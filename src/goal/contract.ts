import { historySchema } from "../internal/history.js";
import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";

import { CatalogStep } from "../internal/catalog.js";

/**
 * Session goal: one durable objective per Session that Shiitake keeps
 * working toward until the model reports it complete or blocked. Shared by
 * the server extension and every client; its schemas are the one decoder.
 */

/** A goal objective: stored exactly as sent, never blank. */
export const Objective = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_000)),
  Schema.check(Schema.isPattern(/\S/u, { message: "Goal objective is blank" })),
);
export const GoalReason = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(1_000)),
  Schema.check(Schema.isPattern(/\S/u)),
);
const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

/** The committed goal every client sees; provisional terminals stay private. */
export const Goal = Schema.Struct({
  /** Owner-issued revision that guards an explicit replacement. */
  revision: Schema.String,
  objective: Objective,
  state: Schema.Literals(["active", "paused", "complete", "blocked"]),
  /** Why continuation stopped (for example failed work); a resume retries. */
  stopReason: Schema.NullOr(Schema.String),
});
/** The committed goal every client sees. */
export type Goal = Schema.Schema.Type<typeof Goal>;

/**
 * Arguments of the human `/goal` command. A bare call opens the controls; each
 * reply is a catalog step, so the conversation stays on the server.
 */
export const GoalCommandInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("set"),
    objective: Objective,
    requestId: RequestId,
    /** The revision the human confirmed replacing, when they confirmed one. */
    expectedRevision: Schema.optional(Schema.NullOr(Schema.String)),
    /** The human's answer to "replace the current goal?". */
    confirmed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literals(["pause", "resume", "replace", "clear"]),
  }),
  Schema.Struct({}),
]);

/** Goal's contract: Session-scope human controls and one projection slot. */
export const GoalProjection = Schema.Struct({
  goal: Schema.NullOr(Goal),
  history: historySchema(Goal),
});

export const goalContract = {
  id: ExtensionId.make("botanical-session-goal"),
  commands: {
    goal: { scope: "session", input: GoalCommandInput, output: CatalogStep },
    pause: { scope: "session", input: Schema.Struct({}), output: Goal },
    resume: { scope: "session", input: Schema.Struct({}), output: Goal },
    clear: {
      scope: "session",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    },
    set: {
      scope: "session",
      input: Schema.Struct({
        objective: Objective,
        /** The revision the user saw, or null when they saw no goal. */
        expectedRevision: Schema.NullOr(Schema.String),
        requestId: RequestId,
      }),
      output: Schema.Struct({
        goal: Goal,
        accepted: Schema.Struct({
          status: Schema.Literal("accepted"),
          commandId: Schema.String,
        }),
      }),
    },
  },
  projection: { schema: GoalProjection },
} as const;
