import type { SandboxBinding } from "@fungi.computer/mycelium";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";
import { questionHost, questions } from "./fixtures/ask.js";

afterEach(() => vi.useRealTimers());

it.each(["second answer", "withdraw", "extra answer key"] as const)(
  "preserves the first valid live answer against %s",
  async (race) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let withdraw: SandboxBinding | undefined;
    const fixture = await questionHost(undefined, {
      program: async (bindings) => {
        withdraw = bindings.question?.withdraw;
        const ask = bindings.question?.ask;
        if (ask === undefined) throw new Error("Missing Ask operation");
        return ask({ questions });
      },
    });
    const { host, store } = fixture;
    let running: Promise<void> | undefined;
    try {
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "race-guards",
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      const session = host.session("questions");
      await expect
        .poll(async () => (await session.read()).attention.length)
        .toBe(1);
      const askId = (await session.read()).attention[0]?.id;
      if (askId === undefined) throw new Error("Expected live Ask");
      const command = session.extension("botanical-session-question");
      const answers = { storage: { selected: ["SQLite"] } };
      if (race === "extra answer key")
        await expect(
          command.call("answer", {
            askId,
            requestId: "extra-key",
            answers: { ...answers, unknown: { selected: ["PostgreSQL"] } },
          }),
        ).rejects.toMatchObject({ boundary: "contract", cause: "invalid" });
      expect(
        await command.call("answer", {
          askId,
          requestId: "first-answer",
          answers,
        }),
      ).toEqual({ result: "accepted", via: "in_turn" });
      expect(fixture.result()).toBeUndefined();
      if (race === "second answer")
        expect(
          await command.call("answer", {
            askId,
            requestId: "second-answer",
            answers: { storage: { selected: ["PostgreSQL"] } },
          }),
        ).toEqual({ result: "closed", status: "answered" });
      if (race === "withdraw") {
        if (withdraw === undefined)
          throw new Error("Missing withdraw operation");
        expect(await withdraw({ askId })).toEqual({
          result: "closed",
          status: "answered",
        });
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await running;
      expect(fixture.result()).toEqual({ status: "answered", answers });
      const snapshot = await session.read();
      expect(snapshot.attention).toEqual([]);
      expect(snapshot.pending.prompts).toEqual([]);
    } finally {
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
    }
  },
);

it("does not replace a parked pending answer when its expiry timer fires before settlement", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const fixture = await questionHost({
    questions,
    mode: "continue",
    onExpire: { afterMinutes: 5, action: "proceed_with_recommended" },
  });
  const { host, store } = fixture;
  try {
    const { askId } = await fixture.park();
    const session = host.session("questions");
    const expiresAt = (await session.read()).attention[0]?.expiresAt;
    if (expiresAt === undefined) throw new Error("Expected expiry");
    // Durable crash checkpoint: the live human answer committed, then the
    // deadline-aborted waiter parked it, before onSettled could deliver it.
    // Seed only that pending response; ordinary admission owns the rest of the row.
    store.owner.sql.exec(
      `UPDATE shiitake_extension_records
       SET value_json = json_set(value_json, '$.pending', json(?))
       WHERE extension_id = ? AND collection = 'asks' AND key = ?`,
      JSON.stringify({
        status: "answered",
        answers: { storage: { selected: ["PostgreSQL"] } },
      }),
      "botanical-session-question",
      askId,
    );
    vi.setSystemTime(expiresAt);
    await host.drain();
    expect((await session.read()).pending.prompts).toEqual([]);
    expect(
      await session.extension("botanical-session-question").call("answer", {
        askId,
        requestId: "after-expiry",
        answers: { storage: { selected: ["SQLite"] } },
      }),
    ).toEqual({ result: "closed", status: "answered" });
    expect(
      (await host.extensions.list()).find(
        ({ id }) => id === "botanical-session-question",
      )?.status,
    ).toBe("running");
  } finally {
    await host.close();
    store.close();
  }
});
