import type { WhistlePrompt } from "@fungi.computer/whistle";

import { headline, titleLimit } from "../internal/headline.js";
import type { Loop } from "./contract.js";

type ChoicePrompt = Extract<WhistlePrompt, { type: "choice" }>;
type ConfirmationPrompt = Extract<WhistlePrompt, { type: "confirmation" }>;

/** The `/loop` menu for a live or paused loop. */
export function loopMenuPrompt(loop: Loop) {
  const active = loop.state === "active";
  const lead = active ? "Loop running: " : "Loop paused: ";
  const name = headline(loop.prompt, titleLimit - lead.length);
  const full = loop.prompt.slice(0, 4_000);
  const menu = {
    type: "choice",
    message: `${lead}${name}`,
    summary:
      loop.mode === "self_paced"
        ? "The Agent decides when to run it again."
        : "It runs again on a fixed schedule.",
    facts: [
      {
        label: "Mode",
        value: loop.mode === "self_paced" ? "Self-paced" : "Fixed interval",
      },
      {
        label: "Started",
        value: loop.origin === "human" ? "By you" : "By the Agent",
      },
    ],
    details: [
      { label: "Prompt", value: full },
      ...(loop.lastError === null
        ? []
        : [{ label: "Last error", value: loop.lastError.slice(0, 2_000) }]),
      {
        label: "Failures",
        value: String(loop.consecutiveFailures),
      },
    ],
    options: [
      active
        ? { value: "pause", label: "Pause loop" }
        : { value: "resume", label: "Resume loop" },
      { value: "stop-ask", label: "Stop loop…", destructive: true },
    ],
  } satisfies ChoicePrompt;
  // A short prompt is already the title; only longer text gets a body.
  return full.replace(/\s+/gu, " ").trim() === name
    ? menu
    : { ...menu, body: full, bodyLabel: "Prompt" };
}

/** The destructive step after choosing Stop: Keep is first and focused. */
export const stopConfirmation = {
  type: "confirmation",
  message: "Stop this loop?",
  summary: "It won't run again. You can start a new one.",
  confirmLabel: "Stop loop",
  cancelLabel: "Keep loop",
  destructive: true,
} satisfies ConfirmationPrompt;
