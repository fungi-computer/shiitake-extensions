import {
  defineClientEntry,
  type ClientContributionV1,
} from "@fungi.computer/shiitake/client-entry";
import type { RowV1 } from "@fungi.computer/gills";
import { planContract, planIsOpen, type Plan } from "./contract.js";

const summary = (plan: Plan) => {
  const active = plan.steps.findIndex((step) => step.status === "in_progress");
  const completed = plan.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const next =
    active < 0
      ? plan.steps.find((step) => step.status === "pending")
      : plan.steps[active];
  return {
    title: next?.step ?? "Plan complete",
    detail: `${String(active < 0 ? completed : active + 1)}/${String(plan.steps.length)}`,
  };
};
const rows = (plan: Plan): RowV1[] =>
  plan.steps.map((step, index) => ({
    id: String(index),
    title: step.step,
    tone:
      step.status === "completed"
        ? "settled"
        : step.status === "in_progress"
          ? "running"
          : "muted",
  }));
/**
 * Only an open plan occupies the footer, where it is inspectable and clearable;
 * a finished or cleared plan hides while its committed history stays in state.
 */
export default defineClientEntry(planContract, {
  contribute: (view): ClientContributionV1 => ({
    chips: [],
    panel:
      view.status !== "running" ||
      view.value === null ||
      !planIsOpen(view.value.plan)
        ? []
        : [
            {
              id: "plan",
              ...summary(view.value.plan),
              actions: [
                { id: "plan", label: "Clear plan", input: { action: "clear" } },
              ],
              inspection: {
                commandId: "plan",
                title: "Plan",
                rows: rows(view.value.plan),
              },
            },
          ],
    timeline: { cells: [], omitted: 0 },
    waiting: null,
  }),
});
