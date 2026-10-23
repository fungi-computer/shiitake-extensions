import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import questionClient from "../src/question/client.js";
import { questionHost, questions } from "./fixtures/ask.js";

afterEach(() => vi.useRealTimers());

it("removes a withdrawn question from the live card projection before its tool settles", async () => {
  const withdrawNow = Deferred.makeUnsafe<undefined>();
  const finishTool = Deferred.makeUnsafe<undefined>();
  let withdrawn = false;
  const fixture = await questionHost(undefined, {
    program: async (bindings) => {
      const ask = bindings.question?.ask;
      const withdraw = bindings.question?.withdraw;
      if (ask === undefined || withdraw === undefined)
        throw new Error("Missing question operations");
      const parked = z
        .object({ status: z.literal("parked"), askId: z.string() })
        .parse(await ask({ questions, mode: "continue" }));
      await Effect.runPromise(Deferred.await(withdrawNow));
      const result = await withdraw({ askId: parked.askId });
      expect(result).toEqual({ result: "closed", status: "withdrawn" });
      withdrawn = true;
      await Effect.runPromise(Deferred.await(finishTool));
      return result;
    },
  });
  const { host, store } = fixture;
  const session = host.agent.session("questions");
  let running: Promise<void> | undefined;
  let observing: Promise<void> | undefined;
  let closeWatch: Effect.Effect<void, unknown> | undefined;
  try {
    await Effect.runPromise(
      session.send("Choose storage", {
        requestId: "withdraw-live-card",
        delivery: "followUp",
      }),
    );
    running = host.reconcile();
    await expect
      .poll(
        async () => (await host.session("questions").read()).attention.length,
      )
      .toBe(1);
    const watch = await Effect.runPromise(session.watch());
    closeWatch = watch.close;
    let slots = watch.snapshot.extensions;
    const cards = () =>
      questionClient.contribute?.(slots["botanical-session-question"]).panel;
    expect(cards()).toEqual([
      expect.objectContaining({ title: questions[0]?.question }),
    ]);
    observing = Effect.runPromise(
      Stream.runForEach(watch.changes, (frame) =>
        Effect.sync(() => {
          if (frame.kind === "update") slots = frame.extensions;
          else if (frame.kind === "reset") slots = frame.baseline.extensions;
        }),
      ),
    );
    Effect.runSync(Deferred.succeed(withdrawNow, undefined));
    await expect.poll(() => withdrawn).toBe(true);
    await expect.poll(cards, { timeout: 3_000 }).toEqual([]);
    expect(fixture.result()).toBeUndefined();
  } finally {
    Effect.runSync(Deferred.succeed(withdrawNow, undefined));
    Effect.runSync(Deferred.succeed(finishTool, undefined));
    if (closeWatch !== undefined) await Effect.runPromise(closeWatch);
    await observing;
    await Effect.runPromise(session.abort);
    await running;
    await host.close();
    store.close();
  }
});

it.each(["declined", "expired", "cancelled"] as const)(
  "removes a %s question from the live client projection",
  async (outcome) => {
    if (outcome === "expired") vi.useFakeTimers({ toFake: ["Date"] });
    const finishTool = Deferred.makeUnsafe<undefined>();
    const fixture = await questionHost(
      { questions, onExpire: { afterMinutes: 5, action: "stop" } },
      {
        afterResult: () => Effect.runPromise(Deferred.await(finishTool)),
      },
    );
    const { host, store } = fixture;
    const session = host.agent.session("questions");
    let running: Promise<void> | undefined;
    let observing: Promise<void> | undefined;
    let closeWatch: Effect.Effect<void, unknown> | undefined;
    try {
      await Effect.runPromise(
        session.send("Choose storage", {
          requestId: `terminal-card:${outcome}`,
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      await expect
        .poll(
          async () => (await host.session("questions").read()).attention.length,
        )
        .toBe(1);
      const watch = await Effect.runPromise(session.watch());
      closeWatch = watch.close;
      const attention = watch.snapshot.attention[0];
      if (attention === undefined)
        throw new Error("Missing question attention");
      let slots = watch.snapshot.extensions;
      const cards = () =>
        questionClient.contribute?.(slots["botanical-session-question"]).panel;
      expect(cards()).toHaveLength(1);
      observing = Effect.runPromise(
        Stream.runForEach(watch.changes, (frame) =>
          Effect.sync(() => {
            if (frame.kind === "update") slots = frame.extensions;
            else if (frame.kind === "reset") slots = frame.baseline.extensions;
          }),
        ),
      );
      if (outcome === "declined") {
        expect(
          await host
            .session("questions")
            .extension("botanical-session-question")
            .call("decline", {
              askId: attention.id,
              requestId: "decline-live-card",
            }),
        ).toEqual({ result: "accepted", via: "in_turn" });
      } else if (outcome === "expired") {
        if (attention.expiresAt === undefined)
          throw new Error("Missing expiry");
        vi.setSystemTime(attention.expiresAt);
      } else {
        await Effect.runPromise(session.abort);
        await running;
        await host.drain();
      }
      await expect.poll(cards, { timeout: 3_000 }).toEqual([]);
      if (outcome !== "cancelled")
        await expect
          .poll(fixture.result, { timeout: 3_000 })
          .toMatchObject({ status: outcome });
    } finally {
      Effect.runSync(Deferred.succeed(finishTool, undefined));
      await Effect.runPromise(session.abort);
      await running;
      if (closeWatch !== undefined) await Effect.runPromise(closeWatch);
      await observing;
      await host.close();
      store.close();
    }
  },
);
