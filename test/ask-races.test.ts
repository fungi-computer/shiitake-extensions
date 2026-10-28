import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";
import { questionHost, questions, mintedId } from "./fixtures/ask.js";

afterEach(() => vi.useRealTimers());

it.each([
  { mode: "wait", edge: "window", winner: "answer" },
  { mode: "wait", edge: "window", winner: "clock" },
  { mode: "wait", edge: "expiry", winner: "answer" },
  { mode: "wait", edge: "expiry", winner: "clock" },
  { mode: "continue", edge: "expiry", winner: "answer" },
  { mode: "continue", edge: "expiry", winner: "clock" },
] as const)(
  "$mode: $winner wins the answer/$edge boundary once",
  async ({ mode, edge, winner }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = await questionHost(
      edge === "expiry"
        ? { questions, mode, onExpire: { afterMinutes: 5, action: "stop" } }
        : { questions, mode },
      { timeoutMs: edge === "expiry" ? 900_000 : 180_000 },
    );
    const { host, store } = fixture;
    const session = host.session("questions");
    let running: Promise<void> | undefined;
    try {
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "boundary",
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      await expect
        .poll(async () => (await session.read()).attention.length)
        .toBe(1);
      if (mode === "continue") await running;
      const item = (await session.read()).attention[0];
      if (item === undefined) throw new Error("Expected attention");
      const answer = {
        askId: item.id,
        requestId: "boundary-answer",
        answers: { storage: { selected: ["SQLite"] } },
      };
      const boundary =
        edge === "expiry" ? item.expiresAt : item.since + 120_000;
      if (boundary === undefined) throw new Error("Expected expiry");
      vi.setSystemTime(boundary);
      if (winner === "clock") {
        if (mode === "wait") await running;
        else await host.drain();
      }
      const result = await session
        .extension("botanical-session-question")
        .call("answer", answer);
      const followsUp =
        mode === "continue" || (edge === "window" && winner === "clock");
      expect(result).toEqual(
        edge === "expiry" && winner === "clock"
          ? { result: "closed", status: "expired" }
          : followsUp
            ? {
                result: "accepted",
                via: "follow_up",
                commandId: mintedId,
              }
            : { result: "accepted", via: "in_turn" },
      );
      await running;
      await host.drain();
      const after = await session.read();
      expect(after.attention).toEqual([]);
      expect(after.pending.prompts).toEqual([]);
      expect(
        after.messages.filter(({ value }) => value.role === "user"),
      ).toHaveLength(followsUp ? 2 : 1);
      expect(
        await session
          .extension("botanical-session-question")
          .call("answer", answer),
      ).toEqual(result);
      if (!followsUp)
        expect(fixture.result()).toMatchObject({
          status: winner === "clock" ? "expired" : "answered",
        });
    } finally {
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
    }
  },
);

it("bounds a maximum-size Unicode follow-up to 8 KiB while preserving every selection", async () => {
  const choices = Array.from({ length: 4 }, (_, index) => ({
    label: `${String(index)}${"界".repeat(59)}`,
    description: "Explanation",
  }));
  const allQuestions = Array.from({ length: 4 }, (_, index) => ({
    id: `q${String(index)}`,
    header: `Question ${String(index)}`,
    question: "界".repeat(1_000),
    multiple: true,
    options: choices,
  }));
  const fixture = await questionHost({
    questions: allQuestions,
    mode: "continue",
  });
  try {
    const { askId } = await fixture.park();
    const session = fixture.host.session("questions");
    await session.extension("botanical-session-question").call("answer", {
      askId,
      requestId: "unicode",
      answers: Object.fromEntries(
        allQuestions.map((question) => [
          question.id,
          {
            selected: choices.map((option) => option.label),
            text: "😀".repeat(2_000),
          },
        ]),
      ),
    });
    const snapshot = await session.read();
    expect(snapshot.pending.prompts).toHaveLength(1);
    const text = snapshot.pending.prompts[0]?.text;
    if (text === undefined) throw new Error("Expected follow-up");
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8_192);
    expect(text).not.toContain("�");
    expect(text).toContain("[truncated]");
    for (let index = 0; index < 4; index += 1)
      expect(text).toContain(`Question ${String(index)} (q${String(index)})`);
    for (const option of choices)
      expect(text.split(option.label)).toHaveLength(5);
  } finally {
    await fixture.host.close();
    fixture.store.close();
  }
});
