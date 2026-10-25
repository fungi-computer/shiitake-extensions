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
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";

import type { WhistleCatalogStepV1 } from "@fungi.computer/whistle/catalog";

import {
  ask,
  catalog,
  declined,
  done,
  freshRequestId,
} from "../internal/catalog.js";
import {
  EndedGoal,
  endedGoalLimit,
  Goal,
  type GoalPauseCause,
  GoalCommandInput,
  goalContract,
  GoalReason,
  Objective,
} from "./contract.js";

/** The rules the model follows; the describe page and an active goal's prompt share them. */
const rules =
  "You may start a goal yourself when none is current. Before marking complete audit every requirement against evidence; complete only after actual achievement. Block only after the same external impasse for three consecutive goal turns; a blocked goal pauses until a person resumes it. Human pause/resume/clear remain human controls. Use plan.update_plan for multi-step work when available.";

/** Hashed prose and policy: every constant goal reads comes from here. */
const config = {
  continuation:
    "Continue working toward the current goal described in the goal section. Find goal.get_goal and goal.update_goal with forage.search({query:'goal'}) and forage.describe. Audit every requirement against evidence before goal.update_goal({status:'complete', reason}). If the same external blocker persists for three goal turns, report blocked with a reason. Check for progress rather than repeating yourself.",
  moduleDescription:
    "Session goal tools: create_goal({objective}), get_goal({}), update_goal({status:'complete'|'blocked', reason}). " +
    rules,
  createDescription:
    "Create a Session goal, including autonomously. Fails while a goal is active or paused; a finished goal is history.",
  getDescription:
    "Read the current goal. A requested terminal state remains provisional until successful settlement.",
  updateDescription:
    "Request complete only after actual achievement, or blocked only after the same external impasse for three consecutive goal turns; settlement commits the request. Complete ends the goal; blocked pauses it for a person.",
  promptLimit: 1_024,
  stallTurns: 3,
  stallReason: "Stalled: no progress for 3 turns",
  /** Why a goal paused when its tracked work did not complete. */
  stoppedReasons: {
    cancelled: "Stopped",
    failed: "Goal work failed",
    interrupted: "Goal work was interrupted",
    outcome_unknown: "Goal work ended without a known outcome",
  },
  /** Why a live goal paused when another turn of its Session did not complete. */
  otherStoppedReasons: {
    failed: "The last turn failed",
    interrupted: "The last turn was interrupted",
    outcome_unknown: "The last turn ended without a known outcome",
  },
  noTerminalReason: "Goal work ended without a final reply",
  idle: "Long-running objective? forage.describe({path:'goal'}) first.",
  guide:
    "Session goal tools: goal.create_goal, goal.get_goal, goal.update_goal. " +
    rules,
} as const;

const promptEncoder = new TextEncoder();
const promptDecoder = new TextDecoder();

/** Encode only whole code points that fit the section's UTF-8 byte budget. */
function boundedPrompt(text: string, byteLimit: number): string {
  const bytes = new Uint8Array(byteLimit);
  const { written } = promptEncoder.encodeInto(text, bytes);
  return promptDecoder.decode(bytes.subarray(0, written));
}

/** One Session's current goal row; a finished goal leaves this collection. */
const GoalRow = Schema.Struct({
  ...Goal.fields,
  sessionId: Schema.String,
  /** A model-requested terminal, committed only by its run's success. */
  pending: Schema.NullOr(
    Schema.Struct({
      state: Schema.Literals(["complete", "blocked"]),
      reason: GoalReason,
    }),
  ),
  stalledTurns: Schema.Int,
  /** Request that set this revision; its retry replays. */
  revisionRequestId: Schema.String,
  /** Latest work whose settlement advances this goal. */
  trackedWorkId: Schema.String,
});
type GoalRow = Schema.Schema.Type<typeof GoalRow>;

/** One Session's finished goals, newest last, and how many were dropped. */
const EndingsRow = Schema.Struct({
  sessionId: Schema.String,
  ended: Schema.Array(EndedGoal).check(Schema.isMaxLength(endedGoalLimit)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const collections = {
  goals: defineCollection(GoalRow, {
    key: (goal) => goal.sessionId,
    index: (goal) => goal.state,
  }),
  endings: defineCollection(EndingsRow, {
    key: (endings) => endings.sessionId,
  }),
};

type Context = ExtensionContextV0<typeof collections, typeof config>;
type Step<A> = Effect.Effect<
  A,
  ExtensionCommandError | ExtensionStateError,
  ExtensionTx | ExtensionRead
>;

function committed(row: GoalRow): Goal {
  return {
    revision: row.revision,
    objective: row.objective,
    state: row.state,
    startedAt: row.startedAt,
    pauseCause: row.pauseCause,
  };
}

function commitGoal(ctx: Context, row: GoalRow) {
  return Effect.gen(function* () {
    yield* ctx.state.goals.put(row);
    if (
      row.state === "paused" &&
      (row.pauseCause?.kind === "blocked" || row.pauseCause?.kind === "stalled")
    )
      yield* ctx.attention
        .set(row.sessionId, {
          id: "paused-goal",
          kind: `goal-${row.pauseCause.kind}`,
          inbox: false,
          summary: goalLine(committed(row)).slice(0, 200),
          since: yield* Clock.currentTimeMillis,
        })
        .pipe(
          Effect.catchTag("ExtensionStateError", (error) =>
            error.reason === "session_absent"
              ? Effect.void
              : Effect.fail(error),
          ),
        );
    else yield* ctx.attention.clear(row.sessionId, "paused-goal");
  });
}

function conflict(message: string): ExtensionCommandError {
  return new ExtensionCommandError({ reason: "conflict", message });
}

function requireGoal(ctx: Context, sessionId: string): Step<GoalRow> {
  return ctx.state.goals.get(sessionId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(conflict("Session goal does not exist")),
        onSome: Effect.succeed,
      }),
    ),
  );
}

/** Pause a goal with the reason a person will see; provisional terminals drop. */
function paused(
  goal: GoalRow,
  kind: GoalPauseCause["kind"],
  detail: string | null,
): GoalRow {
  return {
    ...goal,
    state: "paused",
    pauseCause: { kind, detail },
    pending: null,
  };
}

/**
 * Finish the current goal: it leaves the current slot and joins the
 * Session's bounded history, which the chat shows as one line.
 */
function finishGoal(
  ctx: Context,
  goal: GoalRow,
  outcome: EndedGoal["outcome"],
  reason: string | null,
) {
  return Effect.gen(function* () {
    const endedAt = yield* Clock.currentTimeMillis;
    const afterSequence = yield* ctx.sessionPosition(goal.sessionId);
    const previous = Option.getOrUndefined(
      yield* ctx.state.endings.get(goal.sessionId),
    );
    const total = (previous?.total ?? 0) + 1;
    const ending: EndedGoal = {
      sequence: total,
      objective: goal.objective,
      outcome,
      reason,
      endedAt,
      afterSequence,
    };
    yield* ctx.state.endings.put({
      sessionId: goal.sessionId,
      ended: [...(previous?.ended ?? []), ending].slice(-endedGoalLimit),
      total,
    });
    yield* ctx.state.goals.remove(goal.sessionId);
    yield* ctx.attention.clear(goal.sessionId, "paused-goal");
  });
}

/** Pause or reactivate the current goal without touching admitted work. */
function changeActivity(
  ctx: Context,
  sessionId: string,
  target: "active" | "paused",
): Step<GoalRow> {
  return Effect.gen(function* () {
    const goal = yield* requireGoal(ctx, sessionId);
    const changed: GoalRow =
      target === "active"
        ? {
            ...goal,
            state: "active",
            pauseCause: null,
            stalledTurns: 0,
          }
        : paused(goal, "person", null);
    yield* commitGoal(ctx, changed);
    yield* ctx.observe(sessionId);
    return changed;
  });
}

/** Send one continuation turn if the Session is idle; returns the new row. */
function continueIfIdle(ctx: Context, goal: GoalRow, requestId: string) {
  return ctx
    .send({
      sessionId: goal.sessionId,
      requireExistingSession: true,
      when: "idle",
      correlation: goal.revision,
      prompt: {
        text: `Goal turn · ${goal.objective}`,
        requestId,
        delivery: "followUp",
      },
    })
    .pipe(
      Effect.map((admitted): GoalRow =>
        admitted._tag === "Accepted"
          ? { ...goal, trackedWorkId: admitted.commandId }
          : goal,
      ),
      Effect.catchTag("AdmissionError", (error) =>
        Effect.succeed(paused(goal, "failed", error.message)),
      ),
    );
}

/**
 * Advance one Session's goal from one settled run. Any successful run in
 * the Session becomes the tracked progress. Tracked work that did not
 * complete (Esc, failure, or a restart whose resumed turn could not finish),
 * or any other turn of the Session that failed or was stopped while the goal
 * was live,
 * pauses the goal until a person resumes it; a turn a restart resumed
 * settles here like any other, so the goal keeps going. An achieved goal
 * finishes and leaves the current slot.
 */
function settle(ctx: Context, run: SettledRunV0) {
  return Effect.gen(function* () {
    const found = yield* ctx.state.goals.get(run.sessionId);
    if (Option.isNone(found)) return;
    const goal = found.value;
    if (run.outcome !== "completed") {
      const tracked = run.workId === goal.trackedWorkId;
      if (!tracked && goal.state !== "active") return;
      const cancelled = run.outcome === "cancelled";
      // Esc stops a live goal even on another turn. Restart-resumed work never
      // settles here; other failures pause the goal with their own display line.
      const detail =
        tracked || cancelled
          ? ctx.config.stoppedReasons[run.outcome]
          : ctx.config.otherStoppedReasons[run.outcome];
      yield* commitGoal(
        ctx,
        paused(goal, cancelled ? "cancelled" : "failed", detail),
      );
      return yield* ctx.observe(run.sessionId);
    }
    if (run.terminal !== "completed") {
      yield* commitGoal(
        ctx,
        paused(goal, "no-terminal", ctx.config.noTerminalReason),
      );
      return yield* ctx.observe(run.sessionId);
    }
    const tracked: GoalRow = {
      ...goal,
      trackedWorkId: run.workId,
      stalledTurns:
        run.origin?.extensionId === goalContract.id &&
        run.origin.correlation === goal.revision
          ? run.toolCalls === 0
            ? goal.stalledTurns + 1
            : 0
          : goal.stalledTurns,
    };
    const pending = goal.trackedWorkId === run.workId ? goal.pending : null;
    if (pending?.state === "complete")
      yield* finishGoal(ctx, tracked, "achieved", pending.reason);
    else if (pending?.state === "blocked")
      yield* commitGoal(ctx, paused(tracked, "blocked", pending.reason));
    else if (
      goal.state === "active" &&
      tracked.stalledTurns >= ctx.config.stallTurns
    )
      yield* commitGoal(
        ctx,
        paused(tracked, "stalled", ctx.config.stallReason),
      );
    else if (goal.state === "active")
      yield* commitGoal(
        ctx,
        yield* continueIfIdle(ctx, tracked, `goal-continue:${run.workId}`),
      );
    else yield* commitGoal(ctx, tracked);
    yield* ctx.observe(run.sessionId);
  });
}

/** Run one tool transaction and preserve its owner-admitted diagnostic. */
function toolCall<A>(
  ctx: Context,
  operation: string,
  body: Effect.Effect<
    A,
    ExtensionCommandError | ExtensionStateError,
    ExtensionTx | ExtensionRead
  >,
): Promise<A> {
  return Effect.runPromiseExit(ctx.transact(body)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.squash(exit.cause);
    return Promise.reject(
      new CapabilityFailed({
        namespace: "goal",
        operation,
        cause: {
          kind: "OperationFailed",
          message:
            failure instanceof ExtensionStop
              ? failure.reason
              : failure instanceof Error
                ? failure.message
                : "Goal tool failed",
        },
      }),
    );
  });
}

// Mycelium's maintained operation interface takes Zod for model-tool I/O.
const toolObjective = z.string().min(1).max(4_000);
const toolState = z.enum(["active", "paused", "complete", "blocked"]);

/** The model-facing goal tools for one run, guarded by that run's work id. */
function goalModule(
  ctx: Context,
  sessionId: string,
  workId: string,
): ModuleRegistration {
  return Mycelium.module({
    id: "botanical.session-goal",
    name: "goal",
    description: ctx.config.moduleDescription,
    operations: {
      create_goal: Mycelium.operation({
        replay: "unsafe",
        description: ctx.config.createDescription,
        input: z.strictObject({ objective: toolObjective }),
        output: z.strictObject({
          objective: toolObjective,
          state: z.literal("active"),
        }),
        execute: ({ objective }) =>
          toolCall(
            ctx,
            "create_goal",
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(Objective)(
                objective,
              ).pipe(
                Effect.mapError(() => conflict("Goal objective is invalid")),
              );
              if (Option.isSome(yield* ctx.state.goals.get(sessionId)))
                return yield* Effect.fail(
                  conflict(
                    "A Session goal is already active or paused; only a person replaces it",
                  ),
                );
              yield* commitGoal(ctx, {
                sessionId,
                objective: decoded,
                state: "active",
                startedAt: yield* Clock.currentTimeMillis,
                pending: null,
                stalledTurns: 0,
                revision: `run:${workId}`,
                revisionRequestId: `run:${workId}`,
                trackedWorkId: workId,
                pauseCause: null,
              });
              yield* ctx.observe(sessionId);
              return { objective: decoded, state: "active" as const };
            }),
          ),
      }),
      get_goal: Mycelium.operation({
        replay: "safe",
        description: ctx.config.getDescription,
        input: z.strictObject({}),
        output: z.union([
          z.strictObject({
            objective: toolObjective,
            state: toolState,
            reason: z.string().nullable(),
          }),
          z.null(),
        ]),
        execute: () =>
          toolCall(
            ctx,
            "get_goal",
            ctx.state.goals.get(sessionId).pipe(
              Effect.map((found) =>
                Option.isNone(found)
                  ? null
                  : {
                      objective: found.value.objective,
                      state: found.value.pending?.state ?? found.value.state,
                      reason:
                        found.value.pending?.reason ??
                        found.value.pauseCause?.detail ??
                        null,
                    },
              ),
            ),
          ),
      }),
      update_goal: Mycelium.operation({
        replay: "unsafe",
        description: ctx.config.updateDescription,
        input: z.strictObject({
          status: z.enum(["complete", "blocked"]),
          reason: z.string().min(1).max(1_000),
        }),
        output: z.strictObject({
          objective: toolObjective,
          state: z.enum(["complete", "blocked"]),
          reason: z.string(),
        }),
        execute: ({ status, reason }) =>
          toolCall(
            ctx,
            "update_goal",
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(GoalReason)(
                reason,
              ).pipe(Effect.mapError(() => conflict("Goal reason is invalid")));
              const found = yield* ctx.state.goals.get(sessionId);
              if (
                Option.isNone(found) ||
                found.value.trackedWorkId !== workId ||
                found.value.state !== "active"
              )
                return yield* Effect.fail(
                  conflict("Session goal work guard is stale"),
                );
              yield* commitGoal(ctx, {
                ...found.value,
                pending: { state: status, reason: decoded },
              });
              return {
                objective: found.value.objective,
                state: status,
                reason: decoded,
              };
            }),
          ),
      }),
    },
  });
}

function pauseGoal(ctx: Context, sessionId: string): Step<Goal> {
  return changeActivity(ctx, sessionId, "paused").pipe(Effect.map(committed));
}

type CommandStep<A> = Effect.Effect<
  A,
  ExtensionCommandError | ExtensionStateError | AdmissionError,
  ExtensionTx | ExtensionRead
>;

function resumeGoal(ctx: Context, sessionId: string): CommandStep<Goal> {
  return Effect.gen(function* () {
    // A human resume is the retry: it clears the stop and admits one
    // continuation if the Session is idle.
    const resumed = yield* changeActivity(ctx, sessionId, "active");
    const continued = yield* continueIfIdle(
      ctx,
      resumed,
      `goal-resume:${resumed.revision}:${resumed.trackedWorkId}`,
    );
    yield* commitGoal(ctx, continued);
    return committed(continued);
  });
}

function setGoal(
  ctx: Context,
  sessionId: string,
  input: Readonly<{
    objective: string;
    requestId: string;
    expectedRevision: string | null;
  }>,
) {
  return Effect.gen(function* () {
    const current = Option.getOrUndefined(
      yield* ctx.state.goals.get(sessionId),
    );
    const retried = current?.revisionRequestId === input.requestId;
    if (!retried && (current?.revision ?? null) !== input.expectedRevision)
      return yield* Effect.fail(
        conflict("Session goal changed; read it before replacing it"),
      );
    const admitted = yield* ctx.send({
      sessionId,
      when: "now",
      prompt: {
        text: input.objective,
        requestId: input.requestId,
        delivery: "followUp",
      },
    });
    if (admitted._tag !== "Accepted")
      return yield* Effect.fail(conflict("Session goal was not admitted"));
    const accepted = {
      status: "accepted" as const,
      commandId: admitted.commandId,
    };
    if (admitted.delivery === "replay") {
      // The door proved the request identical; the goal must still be it.
      if (
        current === undefined ||
        !retried ||
        current.objective !== input.objective
      )
        return yield* Effect.fail(
          conflict("Session goal changed after this request was accepted"),
        );
      return { goal: committed(current), accepted };
    }
    // A replaced goal ends as cleared: history, never current.
    if (current !== undefined && !retried)
      yield* finishGoal(ctx, current, "cleared", null);
    const row: GoalRow = {
      sessionId,
      objective: input.objective,
      state: "active",
      startedAt: yield* Clock.currentTimeMillis,
      pending: null,
      stalledTurns: 0,
      revision: `set:${input.requestId}`,
      revisionRequestId: input.requestId,
      trackedWorkId: admitted.commandId,
      pauseCause: null,
    };
    yield* commitGoal(ctx, row);
    yield* ctx.observe(sessionId);
    return { goal: committed(row), accepted };
  });
}

function goalLine(goal: Goal): string {
  if (goal.state === "active") return `Pursuing goal: ${goal.objective}`;
  return goal.pauseCause?.detail == null
    ? `Goal paused: ${goal.objective}`
    : `Goal paused: ${goal.objective} (${goal.pauseCause.detail})`;
}

const objectivePrompt = {
  type: "text",
  message: "What should this Session work toward?",
  placeholder: "Describe the finished result",
} as const;

/** Clear the current goal into history; returns whether one was current. */
function clearGoal(ctx: Context, sessionId: string) {
  return Effect.gen(function* () {
    const current = yield* ctx.state.goals.get(sessionId);
    if (Option.isNone(current)) return false;
    yield* finishGoal(ctx, current.value, "cleared", null);
    yield* ctx.observe(sessionId);
    return true;
  });
}

/**
 * The human `/goal` conversation. Every step is decided here from the
 * committed goal, so every client shows the same choices.
 */
function humanGoal(
  ctx: Context,
  sessionId: string,
  input: Schema.Schema.Type<typeof GoalCommandInput>,
): CommandStep<WhistleCatalogStepV1> {
  return Effect.gen(function* () {
    const current = Option.getOrUndefined(
      yield* ctx.state.goals.get(sessionId),
    );
    if (!("action" in input)) {
      if (current === undefined)
        return ask(
          objectivePrompt,
          { action: "set", requestId: yield* freshRequestId },
          "objective",
        );
      const goal = committed(current);
      return ask(
        {
          type: "choice",
          message: goalLine(goal),
          options: [
            goal.state === "active"
              ? { value: "pause", label: "Pause goal" }
              : { value: "resume", label: "Resume goal" },
            { value: "clear", label: "Clear goal" },
            { value: "replace", label: "Replace goal" },
          ],
        },
        {},
        "action",
      );
    }
    switch (input.action) {
      case "clear":
        // The chat's ending line confirms a clear; only an empty one says so.
        return (yield* clearGoal(ctx, sessionId))
          ? { type: "done" }
          : done({ type: "info", message: "No goal to clear." });
      case "pause":
        yield* pauseGoal(ctx, sessionId);
        return { type: "done" };
      case "resume":
        yield* resumeGoal(ctx, sessionId);
        return { type: "done" };
      case "replace":
        return ask(
          objectivePrompt,
          {
            action: "set",
            requestId: yield* freshRequestId,
            expectedRevision: current?.revision ?? null,
            confirmed: true,
          },
          "objective",
        );
      case "set": {
        const retried = current?.revisionRequestId === input.requestId;
        // Only a live or paused goal is current, so only it asks first.
        const replacing = current !== undefined && !retried;
        if (replacing && input.confirmed === false)
          return declined({ type: "info", message: "Kept the current goal." });
        if (replacing && input.confirmed !== true)
          return ask(
            {
              type: "confirmation",
              message: `Replace the ${current.state === "active" ? "live" : "paused"} goal?\nCurrent: ${current.objective}\nNew: ${input.objective}`,
              confirmLabel: "Replace and start",
              cancelLabel: "Keep current goal",
            },
            {
              action: "set",
              objective: input.objective,
              requestId: input.requestId,
              expectedRevision: current.revision,
            },
            "confirmed",
          );
        yield* setGoal(ctx, sessionId, {
          objective: input.objective,
          requestId: input.requestId,
          expectedRevision: input.expectedRevision ?? current?.revision ?? null,
        });
        // The committed Goal row already shows the state and objective.
        return { type: "done" };
      }
    }
  });
}

/** The commands this extension advertises to every client. */
export const goalCatalog = catalog([
  {
    id: "goal",
    title: "Goal",
    category: "Conversation",
    description: "Set what to work toward",
    projections: {
      help: { order: 2 },
      palette: { order: 2 },
      slash: {
        aliases: ["goal"],
        order: 2,
        arguments: {
          hint: "<objective>",
          words: [
            {
              word: "pause",
              description: "Pause the goal",
              arguments: { action: "pause" },
            },
            {
              word: "resume",
              description: "Resume the goal",
              arguments: { action: "resume" },
            },
            {
              word: "clear",
              description: "Clear the current goal",
              arguments: { action: "clear" },
            },
          ],
          text: {
            field: "objective",
            arguments: { action: "set" },
            requestIdField: "requestId",
          },
        },
      },
    },
  },
]);

/** Botanical's Session goal, driven only by settled runs. */
export const goalExtension: RosteredExtensionV0 = defineExtension({
  id: goalContract.id,
  version: "7.0.0",
})
  .config(config)
  // A command anchor cannot be converted into a historical Session position.
  // Old preview state must be republished separately, never guessed here.
  .state({ version: 7, migrations: {}, collections })
  .define({
    attention: true,
    prompt: (ctx, { sessionId, origin }) =>
      Effect.gen(function* () {
        const goal = Option.getOrNull(yield* ctx.state.goals.get(sessionId));
        const text =
          goal === null
            ? ctx.config.idle
            : (goal.state === "active" ? ctx.config.guide : ctx.config.idle) +
              "\n" +
              goalLine(committed(goal));
        return [
          {
            name: "goal",
            text: boundedPrompt(text, ctx.config.promptLimit),
          },
          ...(goal?.state === "active" &&
          origin?.extensionId === goalContract.id &&
          origin.correlation !== null
            ? [
                {
                  name: "goal-continuation",
                  text: boundedPrompt(
                    ctx.config.continuation,
                    ctx.config.promptLimit,
                  ),
                },
              ]
            : []),
        ];
      }),
    catalog: goalCatalog,
    projection: {
      schema: goalContract.projection.schema,
      read: (ctx, sessionId) => {
        const goal = Option.getOrUndefined(ctx.state.goals.peek(sessionId));
        const endings = Option.getOrUndefined(
          ctx.state.endings.peek(sessionId),
        );
        if (goal === undefined && endings === undefined) return Option.none();
        const ended = endings?.ended ?? [];
        return Option.some({
          goal: goal === undefined ? null : committed(goal),
          ended,
          omitted: (endings?.total ?? 0) - ended.length,
        });
      },
    },
    hooks: {
      onSettled: (ctx, page) =>
        Effect.forEach(page, (run) => settle(ctx, run), { discard: true }),
    },
    tools: (ctx, { sessionId, workId }) =>
      Effect.succeed(Option.some(goalModule(ctx, sessionId, workId))),
    commands: {
      specs: goalContract.commands,
      handlers: (ctx) => ({
        goal: ({ sessionId, input }) => humanGoal(ctx, sessionId, input),
        pause: ({ sessionId }) => pauseGoal(ctx, sessionId),
        resume: ({ sessionId }) => resumeGoal(ctx, sessionId),
        clear: ({ sessionId }: { sessionId: string }) =>
          clearGoal(ctx, sessionId).pipe(Effect.as({})),
        set: ({ sessionId, input }) => setGoal(ctx, sessionId, input),
      }),
    },
  });
