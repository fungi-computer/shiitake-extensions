import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { clientContributionSchemaV1 } from "@fungi.computer/shiitake/client-entry";
import planClient from "../src/plan/client.js";
import { PlanProjection, type Plan } from "../src/plan/contract.js";
import { appendHistory, emptyHistory } from "../src/internal/history.js";

const plan: Plan = {
  steps: [
    { step: "Trace the owner", status: "completed" },
    { step: "Wire the door", status: "in_progress" },
    { step: "Test the boundary", status: "pending" },
    { step: "Capture the result", status: "pending" },
    { step: "Ship it", status: "pending" },
  ],
};
const history = appendHistory(emptyHistory<Plan>(), plan, "command-one", 1);
const encode = Schema.encodeSync(PlanProjection);
const admit = Schema.decodeUnknownSync(clientContributionSchemaV1);
function contribution(current: Plan = plan) {
  if (planClient.contribute === undefined)
    throw new Error("Plan client is missing");
  return admit(
    planClient.contribute({
      status: "running",
      revision: "sha256:plan-test",
      value: encode({
        plan: current,
        history: appendHistory(history, current, "command-two", 2),
      }),
      catalog: { protocol: "whistle.catalog/v1", commands: [] },
    }),
  );
}

it("keeps committed plan history out of the conversation timeline", () => {
  expect(contribution().timeline).toEqual({ cells: [], omitted: 0 });
  expect(history.events).toHaveLength(1);
});
it("uses the active step and ordinal progress in the collapsed footer, with typed checklist tones", () => {
  expect(contribution().panel).toEqual([
    {
      id: "plan",
      title: "Wire the door",
      detail: "2/5",
      actions: [
        { id: "plan", label: "Clear plan", input: { action: "clear" } },
      ],
      inspection: {
        commandId: "plan",
        title: "Plan",
        rows: plan.steps.map((step, index) => ({
          id: String(index),
          title: step.step,
          tone:
            step.status === "completed"
              ? "settled"
              : step.status === "in_progress"
                ? "running"
                : "muted",
        })),
      },
    },
  ]);
});
it("hides finished and cleared plans from the footer", () => {
  expect(
    contribution({
      steps: plan.steps.map((step) => ({ ...step, status: "completed" })),
    }).panel,
  ).toEqual([]);
  expect(contribution({ steps: [] }).panel).toEqual([]);
});
