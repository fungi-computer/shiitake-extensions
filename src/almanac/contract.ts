import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { Prompt, SessionId } from "../internal/schedule-fields.js";
import {
  ScheduleId,
  Instant,
  CronExpression,
  TimeZone,
  Schedule,
  ScheduleListInput,
} from "./schema.js";
export { Schedule } from "./schema.js";

/**
 * Almanac: durable one-shot and cron schedules that send ordinary Session
 * prompts. This contract is shared by the server extension and its clients;
 * its schemas are the only decoders of Almanac values.
 */

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
      input: ScheduleListInput,
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
