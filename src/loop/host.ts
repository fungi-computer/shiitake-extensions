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
  ExtensionStop,
  type ExtensionContextV0,
  type ExtensionRead,
  type ExtensionStateError,
  type ExtensionTx,
  type RosteredExtensionV0,
  type SettledRunV0,
} from "@fungi.computer/shiitake/extensions";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";

import {
  ask,
  catalog,
  declined,
  done,
  freshRequestId,
} from "../internal/catalog.js";

import { nextOccurrence } from "../internal/cron.js";
import { Loop, LoopCommandInput, loopContract } from "./contract.js";
import { loopMenuPrompt, stopConfirmation } from "./prompts.js";

/** The rules the model follows; the describe page and a live loop's prompt share them. */
const rules =
  "You may start loops yourself; one live loop per Session. Failed loop ticks retry with backoff; loop.get shows consecutiveFailures, lastError, and nextDueAt. schedule_next is allowed only in the active self-paced loop's own run, clamped to 60–3600 seconds. Omitting it ends that loop. stop works in any Session run. Human pause/resume/stop and Esc remain user controls.";

/** Hashed prose and policy: every constant loop reads comes from here. */
const config = {
  minDelaySeconds: 60,
  maxDelaySeconds: 3_600,
  fixedLifetimeMs: 7 * 24 * 60 * 60 * 1_000,
  promptLimit: 1_024,
  idle: "Recurring or scheduled work? forage.describe({path:'loop'}) first.",
  guide:
    "Session loop tools: loop.get, loop.start, loop.schedule_next, loop.stop. " +
    rules,
  moduleDescription:
    "Session loop tools: get({}), start({prompt,cadence}), schedule_next({delaySeconds,reason}), stop({reason}). " +
    rules,
  scheduleDescription:
    "Schedule the original loop prompt after this run settles successfully. delaySeconds is clamped between 60 and 3600. The reason is stored as why now and does not change the loop prompt. Do not call this when the loop should end.",
} as const;

/** One Session's durable loop row. */
const LoopRow = Schema.Struct({
  ...Loop.fields,
  sessionId: Schema.String,
  /** The start request; its retry replays the same loop. */
  startRequestId: Schema.String,
  /** The model's request, made during `workId`, for the next occurrence. */
  requested: Schema.NullOr(
    Schema.Struct({
      workId: Schema.String,
      delaySeconds: Schema.Number,
      reason: Schema.String,
    }),
  ),
  consecutiveFailures: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
});
type LoopRow = Schema.Schema.Type<typeof LoopRow>;

const collections = {
  loops: defineCollection(LoopRow, {
    key: (loop) => loop.sessionId,
    index: (loop) => loop.state,
  }),
};

type Context = ExtensionContextV0<typeof collections, typeof config>;
type Step<A> = Effect.Effect<
  A,
  ExtensionCommandError | ExtensionStateError,
  ExtensionTx | ExtensionRead
>;

function conflict(message: string): ExtensionCommandError {
  return new ExtensionCommandError({ reason: "conflict", message });
}

function projected(row: LoopRow): Loop {
  return {
    loopId: row.loopId,
    origin: row.origin,
    expiresAt: row.expiresAt,
    prompt: row.prompt,
    mode: row.mode,
    cron: row.cron,
    state: row.state,
    commandId: row.commandId,
    reason: row.reason,
    nextDueAt: row.nextDueAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
  };
}

function commitLoop(ctx: Context, row: LoopRow) {
  return Effect.gen(function* () {
    yield* ctx.state.loops.put(row);
  });
}

/** Arm the next occurrence, keeping its instant on the row for a resume. */
function arm(
  ctx: Context,
  row: LoopRow,
  dueAt: number,
): Effect.Effect<LoopRow, ExtensionStateError, ExtensionTx | ExtensionRead> {
  const armed: LoopRow = { ...row, nextDueAt: dueAt };
  return commitLoop(ctx, armed).pipe(
    Effect.andThen(ctx.timers.set(row.sessionId, dueAt)),
    Effect.as(armed),
  );
}

function admitStart(
  ctx: Context,
  sessionId: string,
  loopId: string,
  input: Readonly<{ prompt: string; requestId: string }>,
) {
  return ctx.send({
    sessionId,
    when: "now",
    correlation: loopId,
    prompt: {
      text: input.prompt,
      requestId: input.requestId,
      delivery: "followUp",
    },
  });
}

/**
 * Start one loop and send its first prompt in the same transaction. A retry
 * of the same start replays through the door instead of conflicting.
 */
function start(
  ctx: Context,
  sessionId: string,
  input: Readonly<{ prompt: string; requestId: string }>,
  cron: LoopRow["cron"],
  origin: Loop["origin"] = "human",
) {
  return Effect.gen(function* () {
    const current = Option.getOrUndefined(
      yield* ctx.state.loops.get(sessionId),
    );
    if (current?.startRequestId === input.requestId) {
      const replayed = yield* admitStart(ctx, sessionId, current.loopId, input);
      if (replayed._tag !== "Accepted")
        return yield* Effect.fail(conflict("Loop start was not admitted"));
      return {
        loop: projected(current),
        accepted: {
          status: "accepted" as const,
          commandId: replayed.commandId,
        },
      };
    }
    if (current?.state === "active" || current?.state === "paused")
      return yield* Effect.fail(conflict("A Session loop is already active"));
    const loopId = `loop:${input.requestId}`;
    const admitted = yield* admitStart(ctx, sessionId, loopId, input);
    if (admitted._tag !== "Accepted")
      return yield* Effect.fail(conflict("Loop start was not admitted"));
    const row: LoopRow = {
      sessionId,
      loopId,
      origin,
      expiresAt:
        cron === null
          ? null
          : (yield* Clock.currentTimeMillis) + ctx.config.fixedLifetimeMs,
      prompt: input.prompt,
      mode: cron === null ? "self_paced" : "fixed_interval",
      cron,
      state: "active",
      commandId: admitted.commandId,
      reason: null,
      nextDueAt: null,
      lastError: null,
      startRequestId: input.requestId,
      requested: null,
      consecutiveFailures: 0,
    };
    const stored =
      cron === null
        ? row
        : yield* arm(
            ctx,
            row,
            yield* nextOccurrence(cron, yield* Clock.currentTimeMillis),
          );
    yield* commitLoop(ctx, stored);
    yield* ctx.observe(sessionId);
    return {
      loop: projected(stored),
      accepted: { status: "accepted" as const, commandId: admitted.commandId },
    };
  });
}

function requireLoop(ctx: Context, sessionId: string): Step<LoopRow> {
  return ctx.state.loops.get(sessionId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ExtensionCommandError({
              reason: "not_found",
              message: "Session loop does not exist",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
}

/** Where a resumed loop picks up: its cadence, or its recorded next instant. */
function resumeAt(loop: LoopRow, now: number) {
  if (loop.consecutiveFailures > 0)
    return Effect.succeed(
      loop.nextDueAt === null ? null : Math.max(now, loop.nextDueAt),
    );
  return loop.cron === null
    ? Effect.succeed(loop.nextDueAt)
    : nextOccurrence(loop.cron, now);
}

/** Apply one settled run to its Session's loop, if the run was the loop's. */
function settle(ctx: Context, run: SettledRunV0) {
  return Effect.gen(function* () {
    const found = yield* ctx.state.loops.get(run.sessionId);
    if (Option.isNone(found)) return;
    const loop = found.value;
    if (loop.state !== "active" && loop.state !== "paused") return;
    if (run.workId !== loop.commandId) return;
    if (run.outcome === "failed") {
      const consecutiveFailures = Math.min(
        Number.MAX_SAFE_INTEGER,
        loop.consecutiveFailures + 1,
      );
      const backoffExponent = Math.min(consecutiveFailures - 1, 5);
      const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** backoffExponent);
      const now = yield* Clock.currentTimeMillis;
      const dueAt = now + delayMs;
      const retry: LoopRow = {
        ...loop,
        state: loop.state,
        requested: null,
        reason: null,
        nextDueAt: dueAt,
        lastError: "Loop work ended with outcome failed.",
        consecutiveFailures,
      };
      if (loop.state === "paused") yield* commitLoop(ctx, retry);
      else yield* arm(ctx, retry, dueAt);
      return yield* ctx.observe(loop.sessionId);
    }
    if (run.outcome !== "completed" || run.terminal !== "completed") {
      yield* ctx.timers.cancel(loop.sessionId);
      yield* commitLoop(ctx, {
        ...loop,
        state: run.outcome === "cancelled" ? "cancelled" : "failed",
        requested: null,
        reason: null,
        nextDueAt: null,
        lastError:
          run.outcome === "completed"
            ? "Completed loop work has no exact terminal."
            : `Loop work ended with outcome ${run.outcome}.`,
        consecutiveFailures: loop.consecutiveFailures,
      });
      return yield* ctx.observe(loop.sessionId);
    }
    // A fixed interval loop's cadence is armed independently of its runs.
    if (loop.mode === "fixed_interval") {
      if (loop.consecutiveFailures !== 0 || loop.lastError !== null) {
        yield* commitLoop(ctx, {
          ...loop,
          consecutiveFailures: 0,
          lastError: null,
        });
        yield* ctx.observe(loop.sessionId);
      }
      return;
    }
    // Omitting schedule_next during the run ends a self-paced loop.
    if (loop.requested?.workId !== run.workId) {
      yield* commitLoop(ctx, {
        ...loop,
        state: "finished",
        reason: "no next wake requested",
        nextDueAt: null,
        lastError: null,
        consecutiveFailures: 0,
      });
      return yield* ctx.observe(loop.sessionId);
    }
    const now = yield* Clock.currentTimeMillis;
    const scheduled: LoopRow = {
      ...loop,
      reason: loop.requested.reason,
      requested: null,
      nextDueAt: now + loop.requested.delaySeconds * 1_000,
      lastError: null,
      consecutiveFailures: 0,
    };
    // A paused loop keeps the instant; resume arms it.
    if (loop.state === "paused") yield* commitLoop(ctx, scheduled);
    else yield* arm(ctx, scheduled, scheduled.nextDueAt ?? now);
    yield* ctx.observe(loop.sessionId);
  });
}

/**
 * Send one due occurrence. Its request id is `loopId:dueAt`, so a retried
 * delivery replays at the door instead of admitting twice.
 */
function fire(ctx: Context, sessionId: string, dueAt: number, now: number) {
  return Effect.gen(function* () {
    const found = yield* ctx.state.loops.get(sessionId);
    if (Option.isNone(found) || found.value.state !== "active") return;
    const loop = found.value;
    if (loop.nextDueAt !== dueAt) return;
    if (loop.expiresAt !== null && now >= loop.expiresAt) {
      yield* commitLoop(ctx, {
        ...loop,
        state: "finished",
        nextDueAt: null,
        reason: "fixed interval expired after 7 days",
        requested: null,
      });
      return yield* ctx.observe(sessionId);
    }
    const admitted = yield* Effect.result(
      ctx.send({
        sessionId,
        requireExistingSession: true,
        when: "now",
        correlation: loop.loopId,
        prompt: {
          text: loop.prompt,
          requestId: `${loop.loopId}:${String(dueAt)}`,
          delivery: "followUp",
        },
      }),
    );
    // The Agent owner will pause this loop after flipping its archive flag.
    // If this timer wins that short interval, keep the loop resumable instead
    // of treating an intentional archive refusal as a permanent failed run.
    if (Result.isFailure(admitted) && admitted.failure.reason === "archived") {
      yield* arm(
        ctx,
        { ...loop, lastError: admitted.failure.message },
        now + 30_000,
      );
      return yield* ctx.observe(sessionId);
    }
    if (Result.isFailure(admitted) || admitted.success._tag === "NotReady") {
      yield* commitLoop(ctx, {
        ...loop,
        state: "failed",
        nextDueAt: null,
        lastError: Result.isFailure(admitted)
          ? admitted.failure.message
          : "Session did not accept the loop occurrence",
      });
      return yield* ctx.observe(sessionId);
    }
    const next: LoopRow = {
      ...loop,
      commandId: admitted.success.commandId,
      nextDueAt: null,
      lastError: null,
    };
    if (loop.cron === null) yield* commitLoop(ctx, next);
    else {
      const upcoming = yield* Effect.result(nextOccurrence(loop.cron, now));
      if (Result.isFailure(upcoming))
        yield* commitLoop(ctx, {
          ...next,
          state: "failed",
          lastError: upcoming.failure.message,
        });
      else yield* arm(ctx, next, upcoming.success);
    }
    yield* ctx.observe(sessionId);
  });
}

/** Run one tool transaction and preserve its owner-admitted diagnostic. */
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
        namespace: "loop",
        operation,
        cause: {
          kind: "OperationFailed",
          message:
            failure instanceof ExtensionStop
              ? failure.reason
              : failure instanceof Error
                ? failure.message
                : "Loop tool failed",
        },
      }),
    );
  });
}

// Mycelium's maintained operation interface takes Zod for model-tool I/O.
const scheduleNextInput = z.strictObject({
  delaySeconds: z.number(),
  reason: z.string().trim().min(1).max(4_000),
});

const toolLoop = z.strictObject({
  loopId: z.string(),
  origin: z.enum(["human", "model"]),
  expiresAt: z.number().nullable(),
  prompt: z.string(),
  mode: z.enum(["self_paced", "fixed_interval"]),
  cron: z
    .strictObject({ expression: z.string(), timeZone: z.string() })
    .nullable(),
  state: z.enum(["active", "paused", "finished", "failed", "cancelled"]),
  commandId: z.string(),
  reason: z.string().nullable(),
  nextDueAt: z.number().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
});

/** The self-paced `schedule_next` tool for exactly the loop's current run. */
function loopModule(
  ctx: Context,
  sessionId: string,
  workId: string,
): ModuleRegistration {
  return Mycelium.module({
    id: "botanical.session-loop",
    name: "loop",
    description: ctx.config.moduleDescription,
    operations: {
      get: Mycelium.operation({
        replay: "safe",
        description:
          "Get the current Session loop and its next scheduled wake.",
        input: z.strictObject({}),
        output: toolLoop.nullable(),
        execute: () =>
          toolCall(
            ctx,
            "get",
            ctx.state.loops
              .get(sessionId)
              .pipe(
                Effect.map((found) =>
                  Option.isSome(found) ? projected(found.value) : null,
                ),
              ),
          ),
      }),
      start: Mycelium.operation({
        replay: "unsafe",
        description:
          "Start a Session loop, including autonomously. One live loop per Session; the first prompt runs after the current run.",
        input: z.strictObject({
          prompt: z
            .string()
            .min(1)
            .max(256 * 1024),
          cadence: z.union([
            z.strictObject({ kind: z.literal("self_paced") }),
            z.strictObject({
              kind: z.literal("every"),
              minutes: z.number().int().min(1).max(59),
            }),
            z.strictObject({
              kind: z.literal("every"),
              hours: z.number().int().min(1).max(23),
            }),
          ]),
        }),
        output: toolLoop,
        execute: ({ prompt, cadence }) =>
          toolCall(
            ctx,
            "start",
            Effect.gen(function* () {
              const requestId = yield* freshRequestId;
              const cron =
                cadence.kind === "self_paced"
                  ? null
                  : {
                      expression:
                        "minutes" in cadence
                          ? "0 */" + String(cadence.minutes) + " * * * *"
                          : "0 0 */" + String(cadence.hours) + " * * *",
                      timeZone: "UTC",
                    };
              const result = yield* start(
                ctx,
                sessionId,
                { prompt, requestId },
                cron,
                "model",
              );
              return result.loop;
            }),
          ),
      }),
      stop: Mycelium.operation({
        replay: "unsafe",
        description:
          "Stop this Session's loop from any run, with a visible reason. Cancel its next scheduled wake.",
        input: z.strictObject({ reason: z.string().trim().min(1).max(1_000) }),
        output: toolLoop,
        execute: ({ reason }) =>
          toolCall(ctx, "stop", stopLoop(ctx, sessionId, reason)),
      }),
      schedule_next: Mycelium.operation({
        replay: "unsafe",
        description: ctx.config.scheduleDescription,
        input: scheduleNextInput,
        output: z.strictObject({
          delaySeconds: z.number(),
          dueAt: z.number(),
          reason: z.string().min(1).max(4_000),
        }),
        execute: ({ delaySeconds, reason }) =>
          toolCall(
            ctx,
            "schedule_next",
            Effect.gen(function* () {
              const found = yield* ctx.state.loops.get(sessionId);
              if (Option.isNone(found))
                return yield* Effect.fail(
                  conflict(
                    "schedule_next only works inside this loop's own tick run",
                  ),
                );
              if (found.value.state === "failed")
                return yield* Effect.fail(
                  conflict("loop is failed; start a new one with loop.start"),
                );
              if (
                found.value.state !== "active" ||
                found.value.mode !== "self_paced" ||
                found.value.commandId !== workId
              )
                return yield* Effect.fail(
                  conflict(
                    "schedule_next only works inside this loop's own tick run",
                  ),
                );
              const clamped = Math.max(
                ctx.config.minDelaySeconds,
                Math.min(ctx.config.maxDelaySeconds, delaySeconds),
              );
              yield* commitLoop(ctx, {
                ...found.value,
                requested: { workId, delaySeconds: clamped, reason },
              });
              return {
                delaySeconds: clamped,
                dueAt: (yield* Clock.currentTimeMillis) + clamped * 1_000,
                reason,
              };
            }),
          ),
      }),
    },
  });
}

/** Botanical's Session loop on core timers and `effect/Cron`. */
function pauseLoop(ctx: Context, sessionId: string) {
  return Effect.gen(function* () {
    const loop = yield* requireLoop(ctx, sessionId);
    if (loop.state !== "active")
      return yield* Effect.fail(conflict("Session loop is not active"));
    const paused: LoopRow = { ...loop, state: "paused" };
    yield* commitLoop(ctx, paused);
    yield* ctx.timers.cancel(sessionId);
    yield* ctx.observe(sessionId);
    return projected(paused);
  });
}

function resumeLoop(ctx: Context, sessionId: string) {
  return Effect.gen(function* () {
    const loop = yield* requireLoop(ctx, sessionId);
    if (loop.state !== "paused")
      return yield* Effect.fail(conflict("Session loop is not paused"));
    const now = yield* Clock.currentTimeMillis;
    const due = yield* resumeAt(loop, now);
    const active: LoopRow = { ...loop, state: "active" };
    const resumed = due === null ? active : yield* arm(ctx, active, due);
    yield* commitLoop(ctx, resumed);
    yield* ctx.observe(sessionId);
    return projected(resumed);
  });
}

function stopLoop(ctx: Context, sessionId: string, reason?: string) {
  return Effect.gen(function* () {
    const loop = yield* requireLoop(ctx, sessionId);
    if (loop.state !== "active" && loop.state !== "paused")
      return yield* Effect.fail(conflict("Session loop is not active"));
    const stopped: LoopRow = {
      ...loop,
      state: reason === undefined ? "cancelled" : "finished",
      requested: null,
      reason: reason ?? "cancelled by user",
      lastError: null,
      nextDueAt: null,
    };
    yield* commitLoop(ctx, stopped);
    yield* ctx.timers.cancel(sessionId);
    yield* ctx.observe(sessionId);
    return projected(stopped);
  });
}

/** Match and mutate within the same extension command transaction. */
function controlIdentifiedLoop(
  ctx: Context,
  target: Readonly<{ sessionId: string; loopId: string }>,
  action: "pause" | "stop",
) {
  return requireLoop(ctx, target.sessionId).pipe(
    Effect.flatMap((loop) =>
      loop.loopId !== target.loopId
        ? Effect.fail(conflict("Session loop has been replaced"))
        : action === "pause"
          ? pauseLoop(ctx, target.sessionId)
          : stopLoop(ctx, target.sessionId),
    ),
  );
}

function cronForInterval(value: number, unit: string): string | undefined {
  if (unit === "m" || unit === "min")
    return value > 59 ? undefined : `0 */${String(value)} * * * *`;
  return value > 23 ? undefined : `0 0 */${String(value)} * * *`;
}

function invalid(message: string): ExtensionCommandError {
  return new ExtensionCommandError({ reason: "invalid", message });
}

/** `<prompt>` paces itself; `<N>m|h <prompt>` runs on a fixed UTC interval. */
function startFromText(
  ctx: Context,
  sessionId: string,
  input: Readonly<{ text: string; requestId: string }>,
) {
  return Effect.gen(function* () {
    const interval = /^([1-9]\d*)(m|min|h|hr)\s+(.+)$/su.exec(input.text);
    if (interval === null) {
      if (/^\d+[a-z]+\s/u.test(input.text))
        return yield* Effect.fail(
          invalid("Use /loop <N>m or /loop <N>h followed by a prompt."),
        );
      return yield* start(
        ctx,
        sessionId,
        { prompt: input.text, requestId: input.requestId },
        null,
      );
    }
    const expression = cronForInterval(Number(interval[1]), interval[2] ?? "m");
    if (expression === undefined)
      return yield* Effect.fail(
        invalid(
          "Cron loop intervals support 1 to 59 minutes or 1 to 23 hours.",
        ),
      );
    return yield* start(
      ctx,
      sessionId,
      { prompt: interval[3] ?? input.text, requestId: input.requestId },
      { expression, timeZone: "UTC" },
    );
  });
}

function loopLine(loop: Loop): string {
  const mode = loop.mode === "self_paced" ? "self-paced" : "fixed interval";
  return `Loop ${loop.state} (${mode}): ${loop.prompt}`;
}

const loopPrompt = {
  type: "text",
  message: "What should the loop repeat?",
  summary: "Start with 5m or 1h for a fixed interval.",
  placeholder: "Check the build and fix what broke",
} as const;

/** The human `/loop` conversation, decided from the committed loop. */
function humanLoop(
  ctx: Context,
  sessionId: string,
  input: Schema.Schema.Type<typeof LoopCommandInput>,
) {
  return Effect.gen(function* () {
    const found = Option.getOrUndefined(yield* ctx.state.loops.get(sessionId));
    const current = found === undefined ? undefined : projected(found);
    const live = current?.state === "active" || current?.state === "paused";
    if (!("action" in input)) {
      if (current === undefined || !live)
        return ask(
          loopPrompt,
          { action: "start", requestId: yield* freshRequestId },
          "text",
        );
      return ask(loopMenuPrompt(current), {}, "action");
    }
    switch (input.action) {
      case "status":
        return done({
          type: "info",
          message:
            current === undefined
              ? "This Session has no loop."
              : loopLine(current),
        });
      case "new":
        return ask(
          loopPrompt,
          { action: "start", requestId: yield* freshRequestId },
          "text",
        );
      case "pause":
        return done({
          type: "success",
          message: loopLine(yield* pauseLoop(ctx, sessionId)),
        });
      case "resume":
        return done({
          type: "success",
          message: loopLine(yield* resumeLoop(ctx, sessionId)),
        });
      case "stop-ask":
        // The menu's Stop: Keep is the focused answer to this destructive step.
        return ask(stopConfirmation, { action: "stop" }, "confirmed");
      case "stop":
        if (input.confirmed === false)
          return declined({ type: "info", message: "Kept the loop." });
        return done({
          type: "success",
          message: loopLine(yield* stopLoop(ctx, sessionId)),
        });
      case "start": {
        const started = yield* startFromText(ctx, sessionId, input);
        return done({ type: "success", message: loopLine(started.loop) });
      }
    }
  });
}

/** The commands this extension advertises to every client. */
export const loopCatalog = catalog([
  {
    id: "loop",
    title: "Loop",
    category: "Conversation",
    description: "Repeat a prompt",
    projections: {
      help: { order: 3 },
      palette: { order: 3 },
      slash: {
        aliases: ["loop"],
        order: 3,
        arguments: {
          hint: "[<N>m|<N>h] <prompt>",
          words: [
            {
              word: "status",
              description: "Show the loop",
              arguments: { action: "status" },
            },
            {
              word: "pause",
              description: "Pause the loop",
              arguments: { action: "pause" },
            },
            {
              word: "resume",
              description: "Resume the loop",
              arguments: { action: "resume" },
            },
            {
              word: "stop",
              description: "Stop the loop",
              arguments: { action: "stop" },
            },
          ],
          text: {
            field: "text",
            arguments: { action: "start" },
            requestIdField: "requestId",
          },
        },
      },
    },
  },
]);

/** Durable Session loop implementation with prompts, controls and scheduled occurrences. */
export const loopExtension: RosteredExtensionV0 = defineExtension({
  id: loopContract.id,
  version: "4.0.0",
})
  .config(config)
  .state({
    version: 3,
    collections,
  })
  .define({
    prompt: (ctx, { sessionId }) =>
      ctx.state.loops.get(sessionId).pipe(
        Effect.map((found) => [
          {
            name: "loop",
            text: Option.isSome(found)
              ? (
                  ctx.config.guide +
                  "\n" +
                  loopLine(projected(found.value)) +
                  "; nextDueAt=" +
                  String(found.value.nextDueAt)
                ).slice(0, ctx.config.promptLimit)
              : ctx.config.idle,
          },
        ]),
      ),
    catalog: loopCatalog,
    projection: {
      schema: loopContract.projection.schema,
      read: (ctx, sessionId) => {
        const loop = Option.getOrUndefined(ctx.state.loops.peek(sessionId));
        return loop === undefined
          ? Option.none()
          : Option.some({ loop: projected(loop) });
      },
    },
    hooks: {
      onSettled: (ctx, page) =>
        Effect.forEach(page, (run) => settle(ctx, run), { discard: true }),
      onTimer: (ctx, timer) => fire(ctx, timer.key, timer.dueAt, timer.firedAt),
    },
    tools: (ctx, { sessionId, workId }) =>
      Effect.succeed(Option.some(loopModule(ctx, sessionId, workId))),
    commands: {
      specs: loopContract.commands,
      handlers: (ctx) => ({
        pauseLoop: ({ input }) => controlIdentifiedLoop(ctx, input, "pause"),
        stopLoop: ({ input }) => controlIdentifiedLoop(ctx, input, "stop"),
        list: ({ input }) =>
          ctx.state.loops
            .page({ after: input.after, limit: input.limit ?? 64 })
            .pipe(
              Effect.map((rows) =>
                rows.map((row) => ({
                  ...projected(row),
                  sessionId: row.sessionId,
                })),
              ),
            ),
        startSelfPaced: ({ sessionId, input }) =>
          start(ctx, sessionId, input, null),
        startFixedInterval: ({ sessionId, input }) =>
          start(ctx, sessionId, input, {
            expression: input.expression,
            timeZone: input.timeZone,
          }),
        pause: ({ sessionId }) => pauseLoop(ctx, sessionId),
        resume: ({ sessionId }) => resumeLoop(ctx, sessionId),
        stop: ({ sessionId }) => stopLoop(ctx, sessionId),
        loop: ({ sessionId, input }) => humanLoop(ctx, sessionId, input),
      }),
    },
  });
