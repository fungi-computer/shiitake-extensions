import type { AskProjection, ClosedOutcome } from "./contract.js";

function wording(answers: NonNullable<ClosedOutcome["answers"]>): string {
  return Object.values(answers)
    .map((answer) => {
      const picked = answer.selected.join(", ");
      if (answer.text === undefined || answer.text === "")
        return picked === "" ? "(no choice)" : picked;
      return picked === "" ? `“${answer.text}”` : `${picked}, “${answer.text}”`;
    })
    .join(" · ");
}

/** The person's own words for one outcome. */
function describeOutcome(outcome: ClosedOutcome): string {
  const said = wording(outcome.answers ?? {});
  if (outcome.status === "declined") return "You declined the question";
  if (outcome.status === "expired")
    return outcome.action === "proceed_with_recommended"
      ? `Nobody answered in time, so it went with: ${said}`
      : "Nobody answered in time, so nothing was decided";
  return outcome.answeredBy === undefined
    ? `You chose: ${said}`
    : `An Agent answered: ${said}`;
}

/**
 * What a question's follow-up message says in a person's timeline. The message's
 * durable origin names the ask; the outcome comes from the question extension's
 * own projection, decoded with its contract, never from the message text. An
 * owner that publishes no outcomes leaves the message as it is, and an answer
 * older than the outcomes kept reads as "Question closed".
 */
export function questionOutcomeLine(
  projection: typeof AskProjection.Type | null,
  correlation: string | null,
): string | undefined {
  if (correlation === null) return undefined;
  const closed = projection?.closed;
  if (closed === undefined) return undefined;
  const outcome = closed.find((entry) => entry.askId === correlation);
  return outcome === undefined ? "Question closed" : describeOutcome(outcome);
}
