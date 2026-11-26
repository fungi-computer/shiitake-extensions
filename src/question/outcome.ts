import type { ClientDescribedLineV1 } from "@fungi.computer/shiitake/client-entry";
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

/** A line for the timeline, and whether the person said it themselves. */
type OutcomeLine = Readonly<{ text: string; own: boolean }>;

/** One outcome in words; only the person's own answer is theirs to have said. */
function describeOutcome(outcome: ClosedOutcome): OutcomeLine {
  const said = wording(outcome.answers ?? {});
  if (outcome.status === "declined")
    return { text: "You declined the question", own: false };
  if (outcome.status === "expired")
    return {
      text:
        outcome.action === "proceed_with_recommended"
          ? `Nobody answered in time, so it went with: ${said}`
          : "Nobody answered in time, so nothing was decided",
      own: false,
    };
  return outcome.answeredBy === undefined
    ? { text: said, own: true }
    : { text: `An Agent answered: ${said}`, own: false };
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
): ClientDescribedLineV1 | undefined {
  if (correlation === null) return undefined;
  const closed = projection?.closed;
  if (closed === undefined) return undefined;
  const outcome = closed.find((entry) => entry.askId === correlation);
  return outcome === undefined
    ? { text: "Question closed", own: false }
    : describeOutcome(outcome);
}

/**
 * The person's answer to the question a tool call asked, in their own words,
 * from the question extension's projection. Undefined until that ask closed,
 * or for a call that asked nothing.
 */
export function questionToolCallLine(
  projection: typeof AskProjection.Type | null,
  toolCallId: string,
): ClientDescribedLineV1 | undefined {
  const outcome = projection?.closed?.find(
    (entry) => entry.toolCallId === toolCallId,
  );
  return outcome === undefined ? undefined : describeOutcome(outcome);
}
