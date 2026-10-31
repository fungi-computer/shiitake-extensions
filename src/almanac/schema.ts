import * as Schema from "effect/Schema";
import { Prompt, SessionId } from "../internal/schedule-fields.js";

/** Caller-chosen schedule identity; also its create idempotency key. */
export const ScheduleId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)),
);
export const Instant = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);
export const CronExpression = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
export const TimeZone = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);

/** One durable schedule as every caller sees it. */
export const Schedule = Schema.Struct({
  /** Caller-chosen schedule identity. */
  id: ScheduleId,
  /** Session that receives each scheduled prompt. */
  sessionId: SessionId,
  /** Original prompt submitted to the destination Session. */
  prompt: Prompt,
  /** Cron expression and zone for a recurring schedule; null for one-shot. */
  cron: Schema.NullOr(
    Schema.Struct({
      /** Cron expression used to calculate occurrences. */
      expression: CronExpression,
      /** IANA time zone in which the expression is evaluated. */
      timeZone: TimeZone,
    }),
  ),
  /** The occurrence that fires next (or fired last, once finished). */
  nextDueAt: Instant,
  /** Current scheduling lifecycle state. */
  state: Schema.Literals(["active", "paused", "cancelled", "finished"]),
  /** Latest command admitted for this schedule. */
  lastCommandId: Schema.NullOr(Schema.String),
  /** Why the current occurrence has not been admitted yet, if it failed. */
  lastError: Schema.NullOr(Schema.String),
  /** Consecutive failed admissions of the current occurrence. */
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
/** One durable schedule. */
export type Schedule = Schema.Schema.Type<typeof Schedule>;

/** Native bounded Almanac page grammar, also used by shared continuations. */
export const ScheduleListInput = Schema.Struct({
  /** Exclusive schedule cursor. */
  after: Schema.optionalKey(ScheduleId),
  /** Maximum number of schedules returned. */
  limit: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
    ),
  ),
});
