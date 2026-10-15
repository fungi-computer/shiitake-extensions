import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";

/**
 * Almanac: durable one-shot and cron schedules that send ordinary Session
 * prompts. This contract is shared by the server extension and its clients;
 * its schemas are the only decoders of Almanac values.
 */

/** Caller-chosen schedule identity; also its create idempotency key. */
const ScheduleId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)),
);
const SessionId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
/** Human prompt grammar; the admission door re-checks the exact byte bound. */
const Prompt = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256 * 1024)),
);
const Instant = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const CronExpression = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
const TimeZone = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);

/** One durable schedule as every caller sees it. */
export const Schedule = Schema.Struct({
  id: ScheduleId,
  sessionId: SessionId,
  prompt: Prompt,
  /** Cron expression and zone for a recurring schedule; null for one-shot. */
  cron: Schema.NullOr(
    Schema.Struct({ expression: CronExpression, timeZone: TimeZone }),
  ),
  /** The occurrence that fires next (or fired last, once finished). */
  nextDueAt: Instant,
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

const ScheduleRef = Schema.Struct({ scheduleId: ScheduleId });

/** Almanac's contract: agent-scope schedule CRUD, no Session projection. */
export const almanacContract = {
  id: ExtensionId.make("botanical-almanac"),
  commands: {
    createOneShot: {
      scope: "agent",
      input: Schema.Struct({
        requestId: ScheduleId,
        sessionId: SessionId,
        prompt: Prompt,
        dueAt: Instant,
      }),
      output: Schedule,
    },
    createRecurring: {
      scope: "agent",
      input: Schema.Struct({
        requestId: ScheduleId,
        sessionId: SessionId,
        prompt: Prompt,
        expression: CronExpression,
        timeZone: TimeZone,
      }),
      output: Schedule,
    },
    read: {
      scope: "agent",
      input: ScheduleRef,
      output: Schema.NullOr(Schedule),
    },
    list: {
      scope: "agent",
      input: Schema.Struct({
        after: Schema.optionalKey(ScheduleId),
        limit: Schema.optionalKey(
          Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
          ),
        ),
      }),
      output: Schema.Array(Schedule),
    },
    pause: { scope: "agent", input: ScheduleRef, output: Schedule },
    resume: { scope: "agent", input: ScheduleRef, output: Schedule },
    cancel: { scope: "agent", input: ScheduleRef, output: Schedule },
  },
  projection: null,
} as const;
