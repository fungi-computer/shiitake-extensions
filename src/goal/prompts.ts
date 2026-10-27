import type { WhistlePrompt } from "@fungi.computer/whistle";

import { headline, titleLimit } from "../internal/headline.js";
import type { Goal } from "./contract.js";

type ChoicePrompt = Extract<WhistlePrompt, { type: "choice" }>;
type ConfirmationPrompt = Extract<WhistlePrompt, { type: "confirmation" }>;

const pad = (value: number) => String(value).padStart(2, "0");

/** A start time a person reads: 14:02 today, yesterday 14:02, or a full date. */
function startedAt(epochMillis: number, now: number): string {
  const at = new Date(epochMillis);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  if (days === 0) return `${clock} today`;
  if (days === 1) return `${clock} yesterday`;
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

/** What happened, by the typed cause and never by the goal's own words. */
const pausedSummary = {
  person: "You paused this goal.",
  blocked: "The Agent is stuck and needs you.",
  stalled: "No progress for 3 turns, so Fungi paused it.",
  cancelled: "You stopped the goal's turn.",
  failed: "The last turn failed. Resume to try again.",
  "no-terminal": "The goal's last turn ended without a final reply.",
} as const;

const activeSummary = "Fungi keeps working until it is done or you pause it.";

/** The `/goal` menu for a live or paused goal. */
export function goalMenuPrompt(goal: Goal, now: number) {
  const active = goal.state === "active";
  const lead = active ? "Working on: " : "Goal paused: ";
  const name = headline(goal.objective, titleLimit - lead.length);
  const cause = goal.pauseCause;
  const full = goal.objective.slice(0, 4_000);
  const menu = {
    type: "choice",
    message: `${lead}${name}`,
    summary: active ? activeSummary : pausedSummary[cause?.kind ?? "person"],
    facts: [
      { label: "Started", value: startedAt(goal.startedAt, now) },
      ...(!active && cause?.kind === "blocked" && cause.detail != null
        ? [{ label: "Why", value: `“${cause.detail.slice(0, 500)}”` }]
        : []),
    ],
    details: [
      { label: "Goal", value: full },
      ...(cause === null
        ? []
        : [
            {
              label: "Paused",
              value:
                cause.detail == null
                  ? cause.kind
                  : `${cause.kind} · ${cause.detail.slice(0, 2_000)}`,
            },
          ]),
      { label: "Started", value: new Date(goal.startedAt).toLocaleString() },
    ],
    options: [
      active
        ? { value: "pause", label: "Pause goal" }
        : { value: "resume", label: "Resume goal" },
      { value: "replace", label: "Replace goal…" },
      { value: "clear-ask", label: "Clear goal…", destructive: true },
    ],
  } satisfies ChoicePrompt;
  // A one-sentence goal is already the title; only longer text gets a body.
  return full.replace(/\s+/gu, " ").trim() === name
    ? menu
    : { ...menu, body: full, bodyLabel: "Goal" };
}

/** The destructive step after choosing Clear: Keep is first and focused. */
export const clearConfirmation = {
  type: "confirmation",
  message: "Clear this goal?",
  summary: "It moves to history and can't be resumed.",
  confirmLabel: "Clear goal",
  cancelLabel: "Keep goal",
  destructive: true,
} satisfies ConfirmationPrompt;

/** The destructive step after typing a replacement goal. */
export function replaceConfirmation(current: Goal, replacement: string) {
  const old = current.objective.slice(0, 4_000);
  const next = replacement.slice(0, 4_000);
  return {
    type: "confirmation",
    message: `Replace the ${current.state === "active" ? "live" : "paused"} goal?`,
    summary: "The current goal moves to history and can't be resumed.",
    facts: [
      { label: "Current", value: headline(old, 120) },
      { label: "New", value: headline(next, 120) },
    ],
    details: [
      { label: "Current", value: old },
      { label: "New", value: next },
    ],
    confirmLabel: "Replace and start",
    cancelLabel: "Keep current goal",
    destructive: true,
  } satisfies ConfirmationPrompt;
}
