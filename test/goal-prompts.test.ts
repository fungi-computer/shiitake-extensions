import { expect, it } from "vitest";

import { headline } from "../src/internal/headline.js";
import type { Goal } from "../src/goal/contract.js";
import {
  clearConfirmation,
  goalMenuPrompt,
  replaceConfirmation,
} from "../src/goal/prompts.js";

const started = new Date(2026, 9, 26, 14, 2).getTime();
const now = new Date(2026, 9, 26, 16, 0).getTime();

/** The long-text body when the menu carries one. */
const bodyOf = (prompt: ReturnType<typeof goalMenuPrompt>) =>
  "body" in prompt ? prompt.body : undefined;

const paused = (
  kind: NonNullable<Goal["pauseCause"]>["kind"],
  detail: string | null = null,
  objective = "Finish the TUI modal redesign",
): Goal => ({
  revision: "r1",
  objective,
  state: "paused",
  startedAt: started,
  pauseCause: { kind, detail },
});

it("a headline is the first sentence of the first line, cut at a word", () => {
  expect(headline("Ship it. Then rest.", 40)).toBe("Ship it");
  expect(headline("\n  First   line\nsecond line", 40)).toBe("First line");
  expect(headline("one two three four five six", 15)).toBe("one two three…");
  expect(headline("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
});

it.each([
  ["person", null, "You paused this goal."],
  ["blocked", "No repo access", "The Agent is stuck and needs you."],
  [
    "stalled",
    "Stalled: no progress for 3 turns",
    "No progress for 3 turns, so Fungi paused it.",
  ],
  ["cancelled", "Stopped", "You stopped the goal's turn."],
  ["failed", "Goal work failed", "The last turn failed. Resume to try again."],
  ["no-terminal", "x", "The goal's last turn ended without a final reply."],
] as const)(
  "a %s pause says its cause in plain words",
  (kind, detail, summary) => {
    const prompt = goalMenuPrompt(paused(kind, detail), now);
    expect(prompt.message).toBe("Goal paused: Finish the TUI modal redesign");
    expect(prompt.summary).toBe(summary);
    expect(prompt.facts[0]).toEqual({
      label: "Started",
      value: "14:02 today",
    });
  },
);

it("a blocked pause quotes the Agent's reason as a fact", () => {
  expect(
    goalMenuPrompt(paused("blocked", "No repo access"), now).facts,
  ).toContainEqual({
    label: "Why",
    value: "“No repo access”",
  });
});

it("the title stays one short line however long the objective is", () => {
  const objective = `${"Read the approval card review and audit every modal ".repeat(8)}.`;
  const prompt = goalMenuPrompt(paused("failed", null, objective), now);
  expect(prompt.message.length).toBeLessThanOrEqual(60);
  expect(prompt.message.endsWith("…")).toBe(true);
  expect(bodyOf(prompt)).toBe(objective);
  expect(prompt.details).toContainEqual({ label: "Goal", value: objective });
});

it("a one-line objective needs no body", () => {
  expect(bodyOf(goalMenuPrompt(paused("person"), now))).toBeUndefined();
});

it("Clear is the last option, marked destructive, and Replace says more follows", () => {
  const { options } = goalMenuPrompt(paused("person"), now);
  expect(options.map(({ label }) => label)).toEqual([
    "Resume goal",
    "Replace goal…",
    "Clear goal…",
  ]);
  expect(options.map(({ destructive }) => destructive)).toEqual([
    undefined,
    undefined,
    true,
  ]);
});

it("a live goal leads with Pause and says what it is working on", () => {
  const live: Goal = { ...paused("person"), state: "active", pauseCause: null };
  const prompt = goalMenuPrompt(live, now);
  expect(prompt.message).toBe("Working on: Finish the TUI modal redesign");
  expect(prompt.options[0]).toEqual({ value: "pause", label: "Pause goal" });
});

it("destructive confirmations keep the safe answer named and the facts short", () => {
  expect(clearConfirmation).toMatchObject({
    destructive: true,
    cancelLabel: "Keep goal",
    confirmLabel: "Clear goal",
  });
  const replace = replaceConfirmation(
    paused("person"),
    "Write the release notes. Then publish them.",
  );
  expect(replace.facts).toEqual([
    { label: "Current", value: "Finish the TUI modal redesign" },
    { label: "New", value: "Write the release notes" },
  ]);
  expect(replace.destructive).toBe(true);
});
