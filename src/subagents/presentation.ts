import type { Subagent } from "./contract.js";

/** Keep the same provenance when a footer row becomes a composer decision. */
export function escalationLabel(
  escalation: NonNullable<Subagent["escalated"]>,
): string;
export function escalationLabel(
  escalation: Subagent["escalated"],
): string | undefined;
export function escalationLabel(
  escalation: Subagent["escalated"],
): string | undefined {
  if (escalation === undefined) return undefined;
  return escalation.reason === "escalated"
    ? `escalated by ${escalation.by}`
    : escalation.reason === "sender_archived"
      ? `${escalation.by} archived`
      : `${escalation.by} is gone`;
}
