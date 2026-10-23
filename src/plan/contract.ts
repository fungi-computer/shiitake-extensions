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
  /** Optional explanation for this checklist replacement. */
  explanation: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(2_000))),
  ),
  /** Ordered checklist; an empty array clears the plan. */
  steps: Schema.Array(
    Schema.Struct({
      /** Work described by this checklist step. */
      step: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(500)),
      ),
      /** Current progress state of the step. */
      status: Schema.Literals(["pending", "in_progress", "completed"]),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(50))),
});
/** Checklist replacement that permits at most one in-progress step. */
export const PlanInput = Plan.pipe(
  Schema.check(
    Schema.makeFilter(
      (plan) =>
        plan.steps.filter((step) => step.status === "in_progress").length <=
          1 || "At most one plan step may be in progress",
    ),
  ),
);
/** One Session's ordered checklist and optional explanation. */
export type Plan = Schema.Schema.Type<typeof Plan>;

/** Open work remains: some step is not completed. Cleared and finished plans are closed. */
export function planIsOpen(plan: Plan): boolean {
  return plan.steps.some((step) => step.status !== "completed");
}

/** The current checklist and every committed replacement, clears included. */
export const PlanProjection = Schema.Struct({
  /** Latest checklist replacement. */
  plan: Plan,
  /** Committed replacements, including explicit clears. */
  history: historySchema(Plan),
});

/** Arguments of the human `/plan` command: a bare call views, `clear` empties it. */
export const PlanCommandInput = Schema.Union([
  Schema.Struct({
    /** Clear the checklist instead of viewing it. */
    action: Schema.Literal("clear"),
  }),
  Schema.Struct({}),
]);

/** Session-owned human plan control and checklist projection. */
export const planContract = {
  /** Stable extension identity. */
  id: ExtensionId.make("botanical-session-plan"),
  /** Human checklist controls. */
  commands: {
    /** View or clear the current checklist. */
    plan: {
      /** The Session owns the checklist. */
      scope: "session",
      /** Decode the selected human control. */
      input: PlanCommandInput,
      /** Return the server-owned conversation step. */
      output: CatalogStep,
    },
  } satisfies CommandsV0,
  /** Current checklist and its replacement history. */
  projection: {
    /** Decoder for visible plan state. */
    schema: PlanProjection,
  },
};
