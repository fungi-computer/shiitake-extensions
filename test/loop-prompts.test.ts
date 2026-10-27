import { expect, it } from "vitest";

import { titleLimit } from "../src/internal/headline.js";
import type { Loop } from "../src/loop/contract.js";
import { loopMenuPrompt, stopConfirmation } from "../src/loop/prompts.js";

const loop = (overrides: Partial<Loop> = {}): Loop => ({
  loopId: "loop_1",
  origin: "human",
  expiresAt: null,
  prompt: "Check the build and fix what broke",
  mode: "self_paced",
  cron: null,
  state: "active",
  commandId: "cmd_1",
  reason: null,
  nextDueAt: null,
  lastError: null,
  consecutiveFailures: 0,
  ...overrides,
});

it("a running loop leads with Pause and puts Stop last, marked destructive", () => {
  const { options, message } = loopMenuPrompt(loop());
  expect(message).toBe("Loop running: Check the build and fix what broke");
  expect(options).toEqual([
    { value: "pause", label: "Pause loop" },
    { value: "stop-ask", label: "Stop loop…", destructive: true },
  ]);
});

it("a paused loop leads with Resume", () => {
  const prompt = loopMenuPrompt(loop({ state: "paused" }));
  expect(prompt.message.startsWith("Loop paused: ")).toBe(true);
  expect(prompt.options[0]).toEqual({ value: "resume", label: "Resume loop" });
});

it("a long prompt never lengthens the title; the whole text sits in the body and details", () => {
  const long = `${"Check the build and fix what broke ".repeat(12)}.`;
  const prompt = loopMenuPrompt(loop({ prompt: long }));
  expect(prompt.message.length).toBeLessThanOrEqual(titleLimit);
  expect(prompt.message.endsWith("…")).toBe(true);
  expect("body" in prompt && prompt.body).toBe(long);
  expect(prompt.details).toContainEqual({ label: "Prompt", value: long });
});

it("the mode is a fact and the raw error is only in the details", () => {
  const prompt = loopMenuPrompt(
    loop({
      mode: "fixed_interval",
      lastError: "ECONNRESET at 10.0.0.1",
      consecutiveFailures: 2,
    }),
  );
  expect(prompt.facts).toContainEqual({
    label: "Mode",
    value: "Fixed interval",
  });
  expect(JSON.stringify(prompt.facts)).not.toContain("ECONNRESET");
  expect(prompt.details).toContainEqual({
    label: "Last error",
    value: "ECONNRESET at 10.0.0.1",
  });
});

it("stopping asks safe-first with named choices", () => {
  expect(stopConfirmation).toMatchObject({
    destructive: true,
    cancelLabel: "Keep loop",
    confirmLabel: "Stop loop",
  });
  expect(stopConfirmation.message.length).toBeLessThanOrEqual(titleLimit);
});
