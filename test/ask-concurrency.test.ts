import type { SandboxValue } from "@fungi.computer/mycelium";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { questionHost, questions } from "./fixtures/ask.js";

it.each([
  { mode: "one execute", same: false, secondMode: "wait" },
  { mode: "parallel executes", same: false, secondMode: "wait" },
  { mode: "parallel executes", same: true, secondMode: "continue" },
  { mode: "parallel executes", same: true, secondMode: "wait" },
] as const)(
  "keeps one live Ask across $mode (same=$same, second=$secondMode)",
  async ({ mode, same, secondMode }) => {
    const ready = Deferred.makeUnsafe<undefined>();
    const results = new Map<string, SandboxValue>();
    const fixture = await questionHost(undefined, {
      codes: mode === "one execute" ? ["both"] : ["first", "second"],
      program: async (bindings, code) => {
        const ask = bindings.question?.ask;
        if (ask === undefined) throw new Error("Missing Ask operation");
        const first = async () => {
          const result = await ask({ questions });
          results.set("first", result);
          return result;
        };
        const second = async () => {
          await Effect.runPromise(Deferred.await(ready));
          const result = await ask({
            mode: secondMode,
            questions: same
              ? questions
              : questions.map((question) => ({
                  ...question,
                  question: "Which store should hold the archive?",
                })),
          });
          results.set("second", result);
          return result;
        };
        return code === "both"
          ? Promise.all([first(), second()])
          : code === "first"
            ? first()
            : second();
      },
    });
    const { host, store } = fixture;
    let running: Promise<void> | undefined;
    try {
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "parallel-questions",
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      await expect
        .poll(
          async () => (await host.session("questions").read()).attention.length,
        )
        .toBe(1);
      const askId = (await host.session("questions").read()).attention[0]?.id;
      if (askId === undefined) throw new Error("Expected first live Ask");
      Effect.runSync(Deferred.succeed(ready, undefined));
      await expect
        .poll(() => results.get("second"), { timeout: 3_000 })
        .toEqual(
          same
            ? { status: "parked", askId }
            : { status: "refused", reason: "live_limit", askIds: [askId] },
        );
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("list", {}),
      ).toMatchObject({ asks: [{ askId, status: "live" }] });
      expect((await host.session("questions").read()).attention).toHaveLength(
        1,
      );
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", {
            askId,
            requestId: "answer-live-peer",
            answers: { storage: { selected: ["SQLite"] } },
          }),
      ).toEqual({ result: "accepted", via: "in_turn" });
      await running;
      expect(results.get("first")).toEqual({
        status: "answered",
        answers: { storage: { selected: ["SQLite"] } },
      });
      expect((await host.session("questions").read()).pending.prompts).toEqual(
        [],
      );
    } finally {
      Effect.runSync(Deferred.succeed(ready, undefined));
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
    }
  },
  10_000,
);

it.each([false, true])(
  "keeps an answer delivered when a parallel consumer fails (first failure=%s)",
  async (firstFails) => {
    const consumed = Deferred.makeUnsafe<undefined>();
    const fixture = await questionHost(undefined, {
      codes: ["first", "second"],
      program: async (bindings, code) => {
        const ask = bindings.question?.ask;
        if (ask === undefined) throw new Error("Missing Ask operation");
        if (code === "second")
          await Effect.runPromise(Deferred.await(consumed));
        const result = await ask({ questions });
        if (code === "first")
          Effect.runSync(Deferred.succeed(consumed, undefined));
        if ((code === "first") === firstFails)
          throw new Error("Consumer failed after receiving its answer");
        return result;
      },
    });
    const { host, store } = fixture;
    let running: Promise<void> | undefined;
    try {
      const session = host.session("questions");
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "mixed-consumers",
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      await expect
        .poll(async () => (await session.read()).attention.length)
        .toBe(1);
      const askId = (await session.read()).attention[0]?.id;
      if (askId === undefined) throw new Error("Expected live Ask");
      await session.extension("botanical-session-question").call("answer", {
        askId,
        requestId: "mixed-answer",
        answers: { storage: { selected: ["SQLite"] } },
      });
      await running;
      await host.drain();
      const snapshot = await session.read();
      expect(
        snapshot.messages.filter(({ value }) => value.role === "user"),
      ).toHaveLength(1);
      expect(snapshot.pending.prompts).toEqual([]);
      expect(snapshot.attention).toEqual([]);
      expect(
        snapshot.messages.filter(
          ({ value }) => value.role === "toolResult" && !value.isError,
        ),
      ).toHaveLength(1);
    } finally {
      Effect.runSync(Deferred.succeed(consumed, undefined));
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
    }
  },
);
