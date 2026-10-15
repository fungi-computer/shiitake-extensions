import { historySchema } from "../internal/history.js";
import {
  ExtensionId,
  type CommandsV0,
} from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { CatalogStep } from "../internal/catalog.js";

/**
 * One Session's replaceable checklist, independent of goals and loops. No
 * steps means no plan: replacing it with an empty checklist clears it.
 */
export const Plan = Schema.Struct({
  explanation: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(2_000))),
  ),
  steps: Schema.Array(
    Schema.Struct({
      step: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(500)),
      ),
      status: Schema.Literals(["pending", "in_progress", "completed"]),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(50))),
});
export const PlanInput = Plan.pipe(
  Schema.check(
    Schema.makeFilter(
      (plan) =>
        plan.steps.filter((step) => step.status === "in_progress").length <=
          1 || "At most one plan step may be in progress",
    ),
  ),
);
export type Plan = Schema.Schema.Type<typeof Plan>;

/** Open work remains: some step is not completed. Cleared and finished plans are closed. */
export function planIsOpen(plan: Plan): boolean {
  return plan.steps.some((step) => step.status !== "completed");
}

/** The current checklist and every committed replacement, clears included. */
export const PlanProjection = Schema.Struct({
  plan: Plan,
  history: historySchema(Plan),
});

/** Arguments of the human `/plan` command: a bare call views, `clear` empties it. */
export const PlanCommandInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("clear") }),
  Schema.Struct({}),
]);

export const planContract = {
  id: ExtensionId.make("botanical-session-plan"),
  commands: {
    plan: { scope: "session", input: PlanCommandInput, output: CatalogStep },
  } satisfies CommandsV0,
  projection: { schema: PlanProjection },
};
