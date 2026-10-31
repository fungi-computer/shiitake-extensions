import * as Schema from "effect/Schema";
import { Prompt, SessionId } from "../internal/schedule-fields.js";

/** A named cron cadence evaluated in one IANA time zone. */
export const LoopCron = Schema.Struct({
  /** Cron expression for the fixed cadence. */
  expression: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(256)),
  ),
  /** IANA time zone in which the expression is evaluated. */
  timeZone: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(128)),
  ),
});

/** One Session's loop as every client sees it. */
export const Loop = Schema.Struct({
  /** Identity of the loop whose occurrences are being tracked. */
  loopId: Schema.String,
  /** Whether a person or the model started this loop. */
  origin: Schema.Literals(["human", "model"]),
  /** Configured expiry timestamp, or null when absent. */
  expiresAt: Schema.NullOr(Schema.Int),
  /** Original instruction repeated for every occurrence. */
  prompt: Prompt,
  /** Whether the model or a fixed cron cadence schedules occurrences. */
  mode: Schema.Literals(["self_paced", "fixed_interval"]),
  /** Cadence of a fixed-interval loop; null when the model paces it. */
  cron: Schema.NullOr(LoopCron),
  /** Current loop lifecycle state. */
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
  /** Consecutive failed work outcomes; successful work resets this to zero. */
  consecutiveFailures: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
/** One Session's loop. */
export type Loop = Schema.Schema.Type<typeof Loop>;

/** Native bounded Loop page grammar, also used by shared continuations. */
export const LoopListInput = Schema.Struct({
  /** Exclusive Session cursor. */
  after: Schema.optionalKey(SessionId),
  /** Maximum number of Loop rows to read. */
  limit: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
    ),
  ),
});
