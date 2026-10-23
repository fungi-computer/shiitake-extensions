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

const ScheduleRef = Schema.Struct({
  /** Existing schedule targeted by the command. */
  scheduleId: ScheduleId,
});

/** Almanac's contract: agent-scope schedule CRUD, no Session projection. */
export const almanacContract = {
  /** Stable extension identity. */
  id: ExtensionId.make("botanical-almanac"),
  /** Agent-scoped schedule operations. */
  commands: {
    /** Create a schedule with one due occurrence. */
    createOneShot: {
      /** The Agent owns the schedule collection. */
      scope: "agent",
      /** Decode the caller's one-shot schedule request. */
      input: Schema.Struct({
        /** Caller-chosen schedule identity and create idempotency key. */
        requestId: ScheduleId,
        /** Session that receives the scheduled prompt. */
        sessionId: SessionId,
        /** Prompt to submit when due. */
        prompt: Prompt,
        /** Due time in epoch milliseconds. */
        dueAt: Instant,
      }),
      /** Return the created durable schedule. */
      output: Schedule,
    },
    /** Create a recurring cron schedule. */
    createRecurring: {
      /** The Agent owns the schedule collection. */
      scope: "agent",
      /** Decode the caller's recurring schedule request. */
      input: Schema.Struct({
        /** Caller-chosen schedule identity and create idempotency key. */
        requestId: ScheduleId,
        /** Session that receives each occurrence. */
        sessionId: SessionId,
        /** Prompt repeated for each occurrence. */
        prompt: Prompt,
        /** Cron expression used to calculate occurrences. */
        expression: CronExpression,
        /** IANA time zone used to evaluate the cron expression. */
        timeZone: TimeZone,
      }),
      /** Return the created durable schedule. */
      output: Schedule,
    },
    /** Read one schedule, or null when absent. */
    read: {
      /** Read from the Agent's schedule collection. */
      scope: "agent",
      /** Identify the schedule to read. */
      input: ScheduleRef,
      /** Decode the schedule or its absence. */
      output: Schema.NullOr(Schedule),
    },
    /** Read a bounded page of schedules after an optional identity. */
    list: {
      /** Read from the Agent's schedule collection. */
      scope: "agent",
      /** Decode pagination arguments. */
      input: Schema.Struct({
        /** Exclusive schedule cursor. */
        after: Schema.optionalKey(ScheduleId),
        /** Maximum number of schedules returned. */
        limit: Schema.optionalKey(
          Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
          ),
        ),
      }),
      /** Decode the returned schedule rows. */
      output: Schema.Array(Schedule),
    },
    /** Suspend future occurrences of a schedule. */
    pause: {
      /** The Agent owns the schedule. */
      scope: "agent",
      /** Identify the schedule to pause. */
      input: ScheduleRef,
      /** Return its updated state. */
      output: Schedule,
    },
    /** Restore a paused schedule to active scheduling. */
    resume: {
      /** The Agent owns the schedule. */
      scope: "agent",
      /** Identify the schedule to resume. */
      input: ScheduleRef,
      /** Return its updated state. */
      output: Schedule,
    },
    /** Cancel future occurrences of a schedule. */
    cancel: {
      /** The Agent owns the schedule. */
      scope: "agent",
      /** Identify the schedule to cancel. */
      input: ScheduleRef,
      /** Return its updated state. */
      output: Schedule,
    },
  },
  /** Almanac has no Session projection. */
  projection: null,
} as const;
