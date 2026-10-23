import {
  defineClientEntry,
  type ClientContributionV1,
} from "@fungi.computer/shiitake/client-entry";
import type { RowV1 } from "@fungi.computer/gills";
import { goalContract, type EndedGoal, type Goal } from "./contract.js";

/** One footer line: the full objective stays in the row's detail. */
const summary = (text: string) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
};
/** The local wall-clock time a goal started, as 14:02. */
const clockTime = (epochMillis: number) => {
  const at = new Date(epochMillis);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};
/**
 * The one footer row for a live or paused goal, with its one control. The
 * line itself says why a goal paused, so every host shows it without opening
 * the row; the detail keeps an objective the line had to shorten.
 */
function currentRow(goal: Goal): ClientContributionV1["panel"][number] {
  const active = goal.state === "active";
  const status = active
    ? `Pursuing goal since ${clockTime(goal.startedAt)}`
    : "Goal paused (/goal resume)";
  const reason =
    !active && goal.pauseCause?.detail != null
      ? [summary(goal.pauseCause.detail)]
      : [];
  const row: ClientContributionV1["panel"][number] = {
    id: "goal",
    title: [status, summary(goal.objective), ...reason].join(" · "),
    tone: active ? "running" : "muted",
    actions: [
      {
        id: "goal",
        label: active ? "Pause goal" : "Resume goal",
        input: { action: active ? "pause" : "resume" },
      },
    ],
  };
  return summary(goal.objective) === goal.objective
    ? row
    : { ...row, detail: goal.objective.slice(0, 1024) };
}

/** One chat line at the Session position committed when the goal ended. */
function endedCell(
  ended: EndedGoal,
): ClientContributionV1["timeline"]["cells"][number] {
  const line: RowV1 = {
    id: "goal-ended",
    title: `${ended.outcome === "achieved" ? "Goal achieved" : "Goal cleared"} · ${summary(ended.objective)}`,
    tone: ended.outcome === "achieved" ? "settled" : "muted",
  };
  // An achieved goal keeps the model's evidence as the line's detail.
  const row: RowV1 =
    ended.reason === null ? line : { ...line, detail: ended.reason };
  return {
    id: String(ended.sequence),
    sequence: ended.sequence,
    at: ended.endedAt,
    commandId: null,
    afterSequence: ended.afterSequence,
    rows: [row],
  };
}

/**
 * Product copy and controls belong to Goal; every host renders plain rows.
 * The footer shows only a live or paused goal; finished goals are chat lines.
 */
export default defineClientEntry(goalContract, {
  promptPresentation: "footer",
  contribute: (view): ClientContributionV1 => {
    if (view.status !== "running" || view.value === null)
      return {
        chips: [],
        panel: [],
        timeline: { cells: [], omitted: 0 },
        waiting: null,
      };
    const { goal, ended, omitted } = view.value;
    return {
      chips: [],
      panel: goal === null ? [] : [currentRow(goal)],
      timeline: { cells: ended.map(endedCell), omitted },
      waiting: null,
    };
  },
});
