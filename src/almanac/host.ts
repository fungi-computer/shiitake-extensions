import {
  defineCollection,
  defineExtension,
  ExtensionCommandError,
  type ExtensionContextV0,
  type ExtensionRead,
  type ExtensionStateError,
  type ExtensionTx,
  type RosteredExtensionV0,
} from "@fungi.computer/shiitake/extensions";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Option from "effect/Option";

import {
  afterAdmitted,
  afterRefused,
  cancelled,
  occurrenceKey,
  paused,
  resumed,
  settled,
} from "@fungi.computer/almanac";
import { nextOccurrence } from "../internal/cron.js";
import { almanacContract, Schedule } from "./contract.js";

/** Hashed policy: every constant Almanac reads comes from here. */
const config = {
  /** First retry delay after a failed occurrence admission. */
  retryBaseMs: 30_000,
  /** Longest retry delay; one poisoned schedule never blocks the others. */
  retryMaxMs: 3_600_000,
} as const;

const collections = {
  schedules: defineCollection(Schedule, {
    key: (schedule) => schedule.id,
    index: (schedule) => schedule.state,
  }),
};

type Context = ExtensionContextV0<typeof collections, typeof config>;
type Step<A> = Effect.Effect<
  A,
  ExtensionCommandError | ExtensionStateError,
  ExtensionTx | ExtensionRead
>;

function rejected(
  reason: ExtensionCommandError["reason"],
  message: string,
): ExtensionCommandError {
  return new ExtensionCommandError({ reason, message });
}

function requireSchedule(ctx: Context, id: string): Step<Schedule> {
  return ctx.state.schedules.get(id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(rejected("not_found", "Almanac schedule does not exist")),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function sameSchedule(left: Schedule, right: Schedule): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.prompt === right.prompt &&
    left.cron?.expression === right.cron?.expression &&
    left.cron?.timeZone === right.cron?.timeZone &&
    (left.cron !== null || left.nextDueAt === right.nextDueAt)
  );
}

/** Create or replay one schedule; its request id is its identity. */
function create(ctx: Context, schedule: Schedule): Step<Schedule> {
  return Effect.gen(function* () {
    const existing = yield* ctx.state.schedules.get(schedule.id);
    if (Option.isSome(existing)) {
      if (sameSchedule(existing.value, schedule)) return existing.value;
      return yield* Effect.fail(
        rejected("conflict", "Schedule id is already used by another schedule"),
      );
    }
    yield* ctx.state.schedules.put(schedule);
    yield* ctx.timers.set(schedule.id, schedule.nextDueAt);
    return schedule;
  });
}

/**
 * Send the due occurrence through the door. The occurrence request id is
 * `id:occurrenceAt`, so a retried admission replays instead of duplicating.
 * A refused admission is this schedule's own visible state: it records the
 * error and backs off; it never stops Almanac or delays other schedules.
 */
function fire(ctx: Context, id: string, now: number) {
  return Effect.gen(function* () {
    const found = yield* ctx.state.schedules.get(id);
    if (Option.isNone(found) || found.value.state !== "active") return;
    const schedule = found.value;
    const admitted = yield* Effect.result(
      ctx.send({
        sessionId: schedule.sessionId,
        requireExistingSession: schedule.lastCommandId !== null,
        when: "now",
        correlation: schedule.id,
        prompt: {
          text: schedule.prompt,
          requestId: occurrenceKey(schedule),
          delivery: "followUp",
        },
      }),
    );
    if (Result.isFailure(admitted) || admitted.success._tag === "NotReady") {
      const refused = afterRefused(
        schedule,
        now,
        Result.isFailure(admitted)
          ? admitted.failure.message
          : "Session did not accept the occurrence",
        { baseMs: config.retryBaseMs, maxMs: config.retryMaxMs },
      );
      yield* ctx.state.schedules.put(refused.schedule);
      yield* ctx.timers.set(schedule.id, refused.retryAt);
      return;
    }
    const next = afterAdmitted(
      { ...schedule, lastCommandId: admitted.success.commandId },
      now,
    );
    yield* ctx.state.schedules.put(next);
    if (next.state === "active")
      yield* ctx.timers.set(schedule.id, next.nextDueAt);
  });
}

/** Botanical's Almanac on Shiitake timers and the one admission door. */
export const almanacExtension: RosteredExtensionV0 = defineExtension({
  id: almanacContract.id,
  version: "1.1.0",
})
  .config(config)
  .state({ version: 1, migrations: {}, collections })
  .define({
    hooks: { onTimer: (ctx, timer) => fire(ctx, timer.key, timer.firedAt) },
    commands: {
      specs: almanacContract.commands,
      handlers: (ctx) => ({
        createOneShot: ({ input }) =>
          create(ctx, {
            id: input.requestId,
            sessionId: input.sessionId,
            prompt: input.prompt,
            cron: null,
            nextDueAt: input.dueAt,
            state: "active",
            lastCommandId: null,
            lastError: null,
            attempt: 0,
          }),
        createRecurring: ({ input }) =>
          Effect.gen(function* () {
            const cron = {
              expression: input.expression,
              timeZone: input.timeZone,
            };
            const now = yield* Clock.currentTimeMillis;
            return yield* create(ctx, {
              id: input.requestId,
              sessionId: input.sessionId,
              prompt: input.prompt,
              cron,
              nextDueAt: yield* nextOccurrence(cron, now),
              state: "active",
              lastCommandId: null,
              lastError: null,
              attempt: 0,
            });
          }),
        read: ({ input }) =>
          ctx.state.schedules
            .get(input.scheduleId)
            .pipe(Effect.map(Option.getOrNull)),
        list: ({ input }) =>
          ctx.state.schedules.page({
            after: input.after,
            limit: input.limit ?? 64,
          }),
        pause: ({ input }) =>
          Effect.gen(function* () {
            const schedule = yield* requireSchedule(ctx, input.scheduleId);
            if (settled(schedule))
              return yield* Effect.fail(
                rejected("conflict", "A settled schedule cannot be paused"),
              );
            const next = paused(schedule);
            yield* ctx.state.schedules.put(next);
            yield* ctx.timers.cancel(schedule.id);
            return next;
          }),
        resume: ({ input }) =>
          Effect.gen(function* () {
            const schedule = yield* requireSchedule(ctx, input.scheduleId);
            if (settled(schedule))
              return yield* Effect.fail(
                rejected("conflict", "A settled schedule cannot be resumed"),
              );
            const now = yield* Clock.currentTimeMillis;
            // A human resume is the retry: it clears the failure and skips
            // recurring occurrences missed while paused.
            const back = resumed(schedule, now);
            if (Result.isFailure(back))
              return yield* Effect.fail(
                rejected("invalid", back.failure.message),
              );
            yield* ctx.state.schedules.put(back.success);
            yield* ctx.timers.set(schedule.id, back.success.nextDueAt);
            return back.success;
          }),
        cancel: ({ input }) =>
          Effect.gen(function* () {
            const schedule = yield* requireSchedule(ctx, input.scheduleId);
            if (settled(schedule)) return schedule;
            const next = cancelled(schedule);
            yield* ctx.state.schedules.put(next);
            yield* ctx.timers.cancel(schedule.id);
            return next;
          }),
      }),
    },
  });
