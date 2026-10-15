import { expect, it } from "vitest";
import { appendHistory, emptyHistory } from "../src/internal/history.js";

it("retains at most 32 committed events without reusing trimmed identities", () => {
  let history = emptyHistory<{ state: string }>();
  for (let sequence = 1; sequence <= 35; sequence++)
    history = appendHistory(
      history,
      { state: "settled" },
      `work-${String(sequence)}`,
      sequence,
    );
  expect(history.nextSequence).toBe(36);
  expect(history.omitted).toBe(3);
  expect(history.events).toHaveLength(32);
  expect(history.events[0]).toMatchObject({
    id: "4",
    sequence: 4,
    commandId: "work-4",
    at: 4,
  });
  expect(history.events.at(-1)).toMatchObject({ id: "35", sequence: 35 });
  expect(
    appendHistory(history, { state: "settled" }, null, 2).events.at(-1),
  ).toMatchObject({ id: "36", sequence: 36, at: 2, commandId: null });
});

it("trims UTF-8 bytes oldest-first and accepts a change larger than retention", () => {
  let history = emptyHistory<{ text: string }>();
  for (let sequence = 1; sequence <= 4; sequence++)
    history = appendHistory(
      history,
      { text: "é".repeat(8000) },
      null,
      sequence,
    );
  expect(
    new TextEncoder().encode(JSON.stringify(history)).length,
  ).toBeLessThanOrEqual(32 * 1024);
  expect(history.events.map(({ id }) => id)).toEqual(["3", "4"]);
  expect(history.omitted).toBe(2);
  const oversized = appendHistory(
    history,
    { text: "é".repeat(20000) },
    "real-work",
    5,
  );
  expect(oversized).toEqual({ nextSequence: 6, omitted: 5, events: [] });
  const next = appendHistory(oversized, { text: "committed" }, null, 6);
  expect(next.events[0]).toMatchObject({ id: "6", sequence: 6 });
  expect(next.omitted).toBe(5);
});
