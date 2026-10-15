import {
  defineClientEntry,
  type ClientContributionV1,
} from "@fungi.computer/shiitake/client-entry";
import { questionContract } from "./contract.js";

/** Pending decisions use the existing footer rows and advertised answer flow. */
export default defineClientEntry(questionContract, {
  contribute: (view): ClientContributionV1 => ({
    chips: [],
    panel:
      view.status !== "running" || view.value === null
        ? []
        : view.value.asks.map((ask) => {
            const first = ask.questions[0];
            return {
              id: ask.askId,
              title: `${first?.question ?? "Question"}${ask.questions.length > 1 ? ` (+${String(ask.questions.length - 1)} more)` : ""}`,
              detail:
                first?.options.map((option) => option.label).join(" · ") ?? "",
              tone: "attention",
              actions: [
                {
                  id: "answerFlow",
                  label: "Answer",
                  input: { askId: ask.askId },
                },
              ],
            };
          }),
    timeline: { cells: [], omitted: 0 },
    waiting: null,
  }),
});
