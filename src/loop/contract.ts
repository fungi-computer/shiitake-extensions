import { historySchema } from "../internal/history.js";
import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";

import { CatalogStep } from "../internal/catalog.js";

/**
 * Session loop: one repeated prompt per Session, either paced by the model
 * (`schedule_next`) or by a fixed cron cadence. Shared by the server
 * extension and every client; its schemas are the one decoder.
 */

const Prompt = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256 * 1024)),
);
const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
);
/** A named cron cadence evaluated in one IANA time zone. */
export const LoopCron = Schema.Struct({
  expression: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(256)),
  ),
  timeZone: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(128)),
  ),
});

/** One Session's loop as every client sees it. */
export const Loop = Schema.Struct({
  loopId: Schema.String,
  origin: Schema.Literals(["human", "model"]),
  expiresAt: Schema.NullOr(Schema.Int),
  /** Original instruction repeated for every occurrence. */
  prompt: Prompt,
  mode: Schema.Literals(["self_paced", "fixed_interval"]),
  /** Cadence of a fixed-interval loop; null when the model paces it. */
  cron: Schema.NullOr(LoopCron),
  state: Schema.Literals([
    "active",
    "paused",
    "finished",
    "failed",
    "cancelled",
  ]),
  /** Latest accepted command associated with this loop. */
  commandId: Schema.String,
  /** The model's stated reason for the next self-paced occurrence. */
  reason: Schema.NullOr(Schema.String),
  /** When the next occurrence is due, if one is scheduled. */
  nextDueAt: Schema.NullOr(Schema.Int),
  /** Visible explanation when loop work failed. */
  lastError: Schema.NullOr(Schema.String),
});
/** One Session's loop. */
export type Loop = Schema.Schema.Type<typeof Loop>;

const StartResult = Schema.Struct({
  loop: Loop,
  accepted: Schema.Struct({
    status: Schema.Literal("accepted"),
    commandId: Schema.String,
  }),
});

/**
 * Arguments of the human `/loop` command. `start` carries the typed text:
 * `<prompt>` paces itself, `<N>m <prompt>` or `<N>h <prompt>` runs on an
 * interval. A bare call opens the controls.
 */
export const LoopCommandInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("start"),
    text: Prompt,
    requestId: RequestId,
  }),
  Schema.Struct({
    action: Schema.Literals(["status", "pause", "resume", "stop", "new"]),
  }),
  Schema.Struct({}),
]);

/** Loop's contract: Session-scope controls and one projection slot. */
export const LoopProjection = Schema.Struct({
  loop: Schema.NullOr(Loop),
  history: historySchema(Loop),
});

export const loopContract = {
  id: ExtensionId.make("botanical-session-loop"),
  commands: {
    loop: { scope: "session", input: LoopCommandInput, output: CatalogStep },
    startSelfPaced: {
      scope: "session",
      input: Schema.Struct({ prompt: Prompt, requestId: RequestId }),
      output: StartResult,
    },
    startFixedInterval: {
      scope: "session",
      input: Schema.Struct({
        prompt: Prompt,
        requestId: RequestId,
        ...LoopCron.fields,
      }),
      output: StartResult,
    },
    pause: { scope: "session", input: Schema.Struct({}), output: Loop },
    resume: { scope: "session", input: Schema.Struct({}), output: Loop },
    stop: { scope: "session", input: Schema.Struct({}), output: Loop },
  },
  projection: { schema: LoopProjection },
} as const;
