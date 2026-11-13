import {
  CapabilityFailed,
  Mycelium,
  type ModuleRegistration,
} from "@fungi.computer/mycelium";
import {
  type AdmissionError,
  defineCollection,
  defineExtension,
  ExtensionCommandError,
  type ExtensionContextV0,
  type ExtensionRead,
  type ExtensionStateError,
  type ExtensionTx,
  type RosteredExtensionV0,
} from "@fungi.computer/shiitake/extensions";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { z } from "zod";
import { freshRequestId } from "../internal/catalog.js";
import { nextOccurrence } from "../internal/cron.js";
import { almanacContract, Schedule } from "./contract.js";

/** Hashed policy: every constant Almanac reads comes from here. */
const config = {
  /** First retry delay after a failed occurrence admission. */
  retryBaseMs: 30_000,
  /** Longest retry delay; one poisoned schedule never blocks the others. */
  retryMaxMs: 3_600_000,
  /** The one idle prompt line; the rules load with forage.describe. */
  idle: "Daily, weekly or one-time work? forage.describe({path:'schedule'}) first.",
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

/** Create a one-shot schedule due at one instant. */
function createOneShot(
  ctx: Context,
  input: Readonly<{
    requestId: string;
    sessionId: string;
    prompt: string;
    dueAt: number;
  }>,
): Step<Schedule> {
  return create(ctx, {
    id: input.requestId,
    sessionId: input.sessionId,
    prompt: input.prompt,
    cron: null,
    nextDueAt: input.dueAt,
    state: "active",
    lastCommandId: null,
    lastError: null,
    attempt: 0,
  });
}

/** Create a recurring cron schedule; its first occurrence follows now. */
function createRecurring(
  ctx: Context,
  input: Readonly<{
    requestId: string;
    sessionId: string;
    prompt: string;
    expression: string;
    timeZone: string;
  }>,
): Step<Schedule> {
  return Effect.gen(function* () {
    const cron = { expression: input.expression, timeZone: input.timeZone };
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
  });
}

/** Cancel future occurrences; a settled schedule is returned as it is. */
function cancelSchedule(ctx: Context, scheduleId: string): Step<Schedule> {
  return Effect.gen(function* () {
    const schedule = yield* requireSchedule(ctx, scheduleId);
    if (settled(schedule)) return schedule;
    const next = cancelled(schedule);
    yield* ctx.state.schedules.put(next);
    yield* ctx.timers.cancel(schedule.id);
    return next;
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

/** What the model reads from `schedule.describe`; also the module's description. */
const moduleDescription =
  "Durable schedules that send you a prompt in this Session when due: schedule.create({prompt,when}), schedule.list({}), schedule.cancel({scheduleId}). " +
  "when is {kind:'once',at:ISO-8601 instant with offset} or {kind:'cron',expression,timeZone?}; a cron expression has five fields, so every morning at 8 is '0 8 * * *' and Mondays at 9:30 is '30 9 * * 1', evaluated in timeZone (IANA, default UTC; use the person's zone when you know it). " +
  "Use a schedule for a daily, weekly or other cadence that must outlast a loop's 7 days, or for one future time. Schedules persist until cancelled; tell the person what you scheduled and its id so they can cancel it.";

/** Run one tool transaction and keep the owner's own diagnostic. */
function toolCall<A>(
  ctx: Context,
  operation: string,
  body: Effect.Effect<
    A,
    ExtensionCommandError | ExtensionStateError | AdmissionError,
    ExtensionTx | ExtensionRead
  >,
): Promise<A> {
  return Effect.runPromiseExit(ctx.transact(body)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.squash(exit.cause);
    return Promise.reject(
      new CapabilityFailed({
        namespace: "schedule",
        operation,
        cause: {
          kind: "OperationFailed",
          message:
            failure instanceof Error ? failure.message : "Schedule tool failed",
        },
      }),
    );
  });
}

// Mycelium's maintained operation interface takes Zod for model-tool I/O.
const toolSchedule = z.strictObject({
  id: z.string(),
  prompt: z.string(),
  cron: z
    .strictObject({ expression: z.string(), timeZone: z.string() })
    .nullable(),
  nextDueAt: z.number(),
  state: z.enum(["active", "paused", "cancelled", "finished"]),
  lastError: z.string().nullable(),
});

function projected(schedule: Schedule): z.output<typeof toolSchedule> {
  return {
    id: schedule.id,
    prompt: schedule.prompt,
    cron: schedule.cron,
    nextDueAt: schedule.nextDueAt,
    state: schedule.state,
    lastError: schedule.lastError,
  };
}

/** The model-facing create/list/cancel, over the same commands the Hub and Local read. */
function scheduleModule(ctx: Context, sessionId: string): ModuleRegistration {
  return Mycelium.module({
    id: "botanical.almanac",
    name: "schedule",
    description: moduleDescription,
    operations: {
      create: Mycelium.operation({
        replay: "unsafe",
        description:
          "Schedule a prompt for this Session, once or on a cron cadence. Returns the schedule with its id and next due time.",
        input: z.strictObject({
          prompt: z.string().trim().min(1).max(4_000),
          when: z.union([
            z.strictObject({
              kind: z.literal("once"),
              at: z.iso.datetime({ offset: true }),
            }),
            z.strictObject({
              kind: z.literal("cron"),
              expression: z.string().trim().min(1).max(256),
              timeZone: z.string().trim().min(1).max(128).default("UTC"),
            }),
          ]),
        }),
        output: toolSchedule,
        execute: ({ prompt, when }) =>
          toolCall(
            ctx,
            "create",
            Effect.gen(function* () {
              const requestId = yield* freshRequestId;
              if (when.kind === "cron")
                return projected(
                  yield* createRecurring(ctx, {
                    requestId,
                    sessionId,
                    prompt,
                    expression: when.expression,
                    timeZone: when.timeZone,
                  }),
                );
              const dueAt = Date.parse(when.at);
              const now = yield* Clock.currentTimeMillis;
              if (dueAt <= now)
                return yield* Effect.fail(
                  rejected(
                    "invalid",
                    "A one-shot schedule must be in the future",
                  ),
                );
              return projected(
                yield* createOneShot(ctx, {
                  requestId,
                  sessionId,
                  prompt,
                  dueAt,
                }),
              );
            }),
          ),
      }),
      list: Mycelium.operation({
        replay: "safe",
        description:
          "List this Agent's schedules, with ids, cadence, state and next due time.",
        input: z.strictObject({}),
        output: z.array(toolSchedule),
        execute: () =>
          toolCall(
            ctx,
            "list",
            ctx.state.schedules
              .page({ limit: 64 })
              .pipe(Effect.map((rows) => rows.map(projected))),
          ),
      }),
      cancel: Mycelium.operation({
        replay: "unsafe",
        description:
          "Cancel a schedule's future occurrences by id; a finished or cancelled one is returned unchanged.",
        input: z.strictObject({ scheduleId: z.string() }),
        output: toolSchedule,
        execute: ({ scheduleId }) =>
          toolCall(
            ctx,
            "cancel",
            cancelSchedule(ctx, scheduleId).pipe(Effect.map(projected)),
          ),
      }),
    },
  });
}

/** Botanical's Almanac on Shiitake timers and the one admission door. */
export const almanacExtension: RosteredExtensionV0 = defineExtension({
  id: almanacContract.id,
  version: "1.2.0",
})
  .config(config)
  .state({ version: 1, migrations: {}, collections })
  .define({
    prompt: () => Effect.succeed([{ name: "schedule", text: config.idle }]),
    tools: (ctx, { sessionId }) =>
      Effect.succeed(Option.some(scheduleModule(ctx, sessionId))),
    hooks: { onTimer: (ctx, timer) => fire(ctx, timer.key, timer.firedAt) },
    commands: {
      specs: almanacContract.commands,
      handlers: (ctx) => ({
        createOneShot: ({ input }) => createOneShot(ctx, input),
        createRecurring: ({ input }) => createRecurring(ctx, input),
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
        cancel: ({ input }) => cancelSchedule(ctx, input.scheduleId),
      }),
    },
  });
