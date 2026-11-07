import {
  defineClientEntry,
  type ClientContributionV1,
} from "@fungi.computer/shiitake/client-entry";
import { questionContract } from "./contract.js";

/** Pending decisions take over the composer; the footer row is where a postponed one waits. */
export default defineClientEntry(questionContract, {
  contribute: (view): ClientContributionV1 => ({
    chips: [],
    panel:
      view.status !== "running" || view.value === null
        ? []
        : view.value.asks.map((ask) => {
            const first = ask.questions[0];
            let title = `${first?.question ?? "Question"}${ask.questions.length > 1 ? ` (+${String(ask.questions.length - 1)} more)` : ""}`;
            let detail =
              first?.options.map((option) => option.label).join(" · ") ?? "";
            if (ask.escalated !== undefined) {
              const { by, reason, note } = ask.escalated;
              const label =
                reason === "escalated"
                  ? `escalated by ${by.name}`
                  : reason === "sender_archived"
                    ? `${by.name} archived`
                    : `${by.name} is gone`;
              title = `${label} · ${title}`;
              if (note !== undefined) detail = `${detail}\n${note}`;
            }
            // An ask waiting on an Agent is calm: it never takes over the
            // composer, but a person may still answer it first.
            if (ask.waitingOn !== undefined)
              return {
                id: ask.askId,
                title: `waiting on ${ask.waitingOn.name} · ${title}`,
                detail,
                tone: "muted",
                actions: [
                  {
                    id: "answerFlow",
                    label: "Answer",
                    input: { askId: ask.askId },
                  },
                ],
              };
            return {
              id: ask.askId,
              title,
              detail,
              tone: "attention",
              actions: [
                {
                  id: "answerFlow",
                  label: "Answer",
                  input: { askId: ask.askId },
                  awaiting: "question",
                },
              ],
            };
          }),
    timeline: { cells: [], omitted: 0 },
    waiting: null,
  }),
});
