import {
  defineClientEntry,
  type ClientContributionV1,
} from "@fungi.computer/shiitake/client-entry";
import type { RowV1 } from "@fungi.computer/gills";
import { goalContract, type Goal } from "./contract.js";

const tone = (goal: Goal): RowV1["tone"] =>
  goal.state === "blocked"
    ? "error"
    : goal.state === "complete"
      ? "settled"
      : goal.state === "paused"
        ? "muted"
        : "running";
/** Product copy and controls belong to Goal; every host renders plain rows. */
export default defineClientEntry(goalContract, {
  correlatedPrompts: "note",
  contribute: (view): ClientContributionV1 => {
    if (view.status !== "running" || view.value === null)
      return {
        chips: [],
        panel: [],
        timeline: { cells: [], omitted: 0 },
        waiting: null,
      };
    const { goal, history } = view.value;
    const panel: ClientContributionV1["panel"][number][] = [];
    if (goal !== null) {
      const row: RowV1 = {
        id: "goal",
        title: goal.objective,
        detail: `Goal · ${goal.state}`,
        tone: tone(goal),
      };
      panel.push(
        goal.state === "active" || goal.state === "paused"
          ? {
              ...row,
              actions: [
                {
                  id: "goal",
                  label: goal.state === "active" ? "Pause goal" : "Resume goal",
                  input: {
                    action: goal.state === "active" ? "pause" : "resume",
                  },
                },
              ],
            }
          : row,
      );
      if (goal.stopReason !== null)
        panel.push({
          id: "reason",
          title: goal.stopReason.slice(0, 4096),
          tone: "attention",
        });
    }
    return {
      chips:
        goal === null
          ? []
          : [
              {
                id: "goal",
                order: 1,
                row: {
                  id: "goal",
                  title: `Goal ${goal.state}${goal.stopReason?.startsWith("Stalled:") ? ": stalled" : ""}`,
                  tone: tone(goal),
                },
              },
            ],
      panel,
      timeline: {
        omitted: history.omitted,
        cells: history.events.map(({ event, ...cell }) => ({
          ...cell,
          rows: [
            { id: "state", title: `Goal ${event.state}`, tone: tone(event) },
            { id: "objective", title: event.objective },
            ...(event.stopReason === null
              ? []
              : [
                  {
                    id: "reason",
                    title: event.stopReason.slice(0, 4096),
                    tone: tone(event),
                  },
                ]),
          ],
        })),
      },
      waiting: null,
    };
  },
});
