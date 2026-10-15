import * as Clock from "effect/Clock";
import {
  appendHistory,
  emptyHistory,
  historySchema,
} from "../internal/history.js";
import { Mycelium, type ModuleRegistration } from "@fungi.computer/mycelium";
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
  Goal,
  GoalCommandInput,
  goalContract,
  GoalReason,
  Objective,
} from "./contract.js";

/** Hashed prose and policy: every constant goal reads comes from here. */
const config = {
  continuation:
    "Continue working toward the current goal described in the goal section. Find goal.get_goal and goal.update_goal with forage.search({query:'goal'}) and forage.describe. Audit every requirement against evidence before goal.update_goal({status:'complete', reason}). If the same external blocker persists for three goal turns, report blocked with a reason. Check for progress rather than repeating yourself.",
  moduleDescription:
    "Session goal coordination state. You may create goals autonomously; complete only after actual achievement; block only after the same external impasse for three consecutive goal turns.",
  createDescription:
    "Create a Session goal, including autonomously. A replacement is allowed only after the current goal is complete.",
  getDescription:
    "Read the current goal. A requested terminal state remains provisional until successful settlement.",
  updateDescription:
    "Request complete only after actual achievement, or blocked only after the same external impasse for three consecutive goal turns; settlement commits the request.",
  promptLimit: 1_024,
  stallTurns: 3,
  stallReason: "Stalled: no progress for 3 turns. /goal resume to retry",
  guide:
    "Session goal tools in execute: goal.create_goal({objective}), goal.get_goal({}), goal.update_goal({status:'complete'|'blocked', reason}). Find them with forage.search({query:'goal'}) and forage.describe. You may start a goal yourself. Before marking complete audit every requirement against evidence. Block only after the same external impasse for three consecutive goal turns. Human pause/resume/clear remain human controls. Use plan.update_plan for multi-step work when available.",
} as const;

const promptEncoder = new TextEncoder();
const promptDecoder = new TextDecoder();

/** Encode only whole code points that fit the section's UTF-8 byte budget. */
function boundedPrompt(text: string, byteLimit: number): string {
  const bytes = new Uint8Array(byteLimit);
  const { written } = promptEncoder.encodeInto(text, bytes);
  return promptDecoder.decode(bytes.subarray(0, written));
}

/** One Session's durable goal row. */
const GoalRow = Schema.Struct({
  ...Goal.fields,
  sessionId: Schema.String,
  /** A model-requested terminal, committed only by its run's success. */
  pendingState: Schema.NullOr(Schema.Literals(["complete", "blocked"])),
  pendingReason: Schema.NullOr(GoalReason),
  stalledTurns: Schema.Int,
  /** Request that set this revision; its retry replays. */
  revisionRequestId: Schema.String,
  /** Latest work whose settlement advances this goal. */
  trackedWorkId: Schema.String,
});
type GoalRow = Schema.Schema.Type<typeof GoalRow>;

const collections = {
  history: defineCollection(
    Schema.Struct({ sessionId: Schema.String, history: historySchema(Goal) }),
    { key: (row) => row.sessionId },
  ),
  goals: defineCollection(GoalRow, {
    key: (goal) => goal.sessionId,
    index: (goal) => goal.state,
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
    stopReason: row.stopReason,
  };
}

function commitGoal(ctx: Context, row: GoalRow) {
  return Effect.gen(function* () {
    const previous = Option.getOrUndefined(
      yield* ctx.state.goals.get(row.sessionId),
    );
    if (
      (row.state === "complete" || row.state === "blocked") &&
      previous?.state !== row.state
    ) {
      const history =
        Option.getOrUndefined(yield* ctx.state.history.get(row.sessionId))
          ?.history ?? emptyHistory<Goal>();
      yield* ctx.state.history.put({
        sessionId: row.sessionId,
        history: appendHistory(
          history,
          committed(row),
          row.trackedWorkId || null,
          yield* Clock.currentTimeMillis,
        ),
      });
    }
    yield* ctx.state.goals.put(row);
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

/** Pause or reactivate a nonterminal goal without touching admitted work. */
function changeActivity(
  ctx: Context,
  sessionId: string,
  target: "active" | "paused",
): Step<GoalRow> {
  return Effect.gen(function* () {
    const goal = yield* requireGoal(ctx, sessionId);
    if (goal.state === "complete" || goal.state === "blocked")
      return yield* Effect.fail(
        conflict("A terminal Session goal cannot change activity"),
      );
    const changed: GoalRow =
      target === "active"
        ? { ...goal, state: "active", stopReason: null, stalledTurns: 0 }
        : { ...goal, state: "paused" };
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
        Effect.succeed({
          ...goal,
          state: "paused" as const,
          stopReason: error.message,
        }),
      ),
    );
}

/**
 * Advance one Session's goal from one settled run. Any successful run in
 * the Session becomes the tracked progress; failed tracked work is a visible
 * item-level stop that a human resume retries.
 */
function settle(ctx: Context, run: SettledRunV0) {
  return Effect.gen(function* () {
    const found = yield* ctx.state.goals.get(run.sessionId);
    if (Option.isNone(found)) return;
    const goal = found.value;
    if (goal.state !== "active" && goal.state !== "paused") return;
    if (run.outcome !== "completed") {
      if (run.workId !== goal.trackedWorkId) return;
      yield* commitGoal(ctx, {
        ...goal,
        pendingState: null,
        pendingReason: null,
        stopReason: `Goal work ended ${run.outcome}`,
      });
      return yield* ctx.observe(run.sessionId);
    }
    if (run.terminal !== "completed") {
      yield* commitGoal(ctx, {
        ...goal,
        stopReason: "Completed goal work has no exact terminal",
      });
      return yield* ctx.observe(run.sessionId);
    }
    const tracked: GoalRow = {
      ...goal,
      trackedWorkId: run.workId,
      stopReason: null,
      stalledTurns:
        run.origin?.extensionId === goalContract.id &&
        run.origin.correlation === goal.revision
          ? run.toolCalls === 0
            ? goal.stalledTurns + 1
            : 0
          : goal.stalledTurns,
    };
    if (goal.pendingState !== null && goal.trackedWorkId === run.workId)
      yield* commitGoal(ctx, {
        ...tracked,
        state: goal.pendingState,
        stopReason: goal.pendingReason,
        pendingState: null,
        pendingReason: null,
      });
    else if (
      goal.state === "active" &&
      tracked.stalledTurns >= ctx.config.stallTurns
    )
      yield* commitGoal(ctx, {
        ...tracked,
        state: "paused",
        stopReason: ctx.config.stallReason,
      });
    else if (goal.state === "active")
      yield* commitGoal(
        ctx,
        yield* continueIfIdle(ctx, tracked, `goal-continue:${run.workId}`),
      );
    else yield* commitGoal(ctx, tracked);
    yield* ctx.observe(run.sessionId);
  });
}

/** Run one tool transaction and surface its failure to the model as an Error. */
function toolCall<A>(
  ctx: Context,
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
      new Error(
        failure instanceof ExtensionStop
          ? failure.reason
          : failure instanceof Error
            ? failure.message
            : "Goal tool failed",
      ),
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
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(Objective)(
                objective,
              ).pipe(
                Effect.mapError(() => conflict("Goal objective is invalid")),
              );
              const current = yield* ctx.state.goals.get(sessionId);
              if (Option.isSome(current) && current.value.state !== "complete")
                return yield* Effect.fail(
                  conflict(
                    current.value.state === "blocked"
                      ? "A blocked Session goal cannot be replaced"
                      : "A nonterminal Session goal already exists",
                  ),
                );
              yield* commitGoal(ctx, {
                sessionId,
                objective: decoded,
                state: "active",
                pendingState: null,
                pendingReason: null,
                stalledTurns: 0,
                revision: `run:${workId}`,
                revisionRequestId: `run:${workId}`,
                trackedWorkId: workId,
                stopReason: null,
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
            stopReason: z.string().nullable(),
          }),
          z.null(),
        ]),
        execute: () =>
          toolCall(
            ctx,
            ctx.state.goals.get(sessionId).pipe(
              Effect.map((found) =>
                Option.isNone(found)
                  ? null
                  : {
                      objective: found.value.objective,
                      state: found.value.pendingState ?? found.value.state,
                      stopReason:
                        found.value.pendingReason ?? found.value.stopReason,
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
                pendingState: status,
                pendingReason: decoded,
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
    const row: GoalRow = {
      sessionId,
      objective: input.objective,
      state: "active",
      pendingState: null,
      pendingReason: null,
      stalledTurns: 0,
      revision: `set:${input.requestId}`,
      revisionRequestId: input.requestId,
      trackedWorkId: admitted.commandId,
      stopReason: null,
    };
    yield* commitGoal(ctx, row);
    yield* ctx.observe(sessionId);
    return { goal: committed(row), accepted };
  });
}

function goalLine(goal: Goal): string {
  const state = goal.state.charAt(0).toUpperCase() + goal.state.slice(1);
  return goal.stopReason === null
    ? `${state}: ${goal.objective}`
    : `${state}: ${goal.objective} (${goal.stopReason})`;
}

const objectivePrompt = {
  type: "text",
  message: "What should this Session work toward?",
  placeholder: "Describe the finished result",
} as const;

function clearGoal(ctx: Context, sessionId: string) {
  return ctx.state.goals
    .remove(sessionId)
    .pipe(Effect.andThen(ctx.observe(sessionId)), Effect.as({}));
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
      const options =
        goal.state === "active"
          ? [{ value: "pause", label: "Pause goal" }]
          : goal.state === "paused"
            ? [{ value: "resume", label: "Resume goal" }]
            : [];
      return ask(
        {
          type: "choice",
          message: goalLine(goal),
          options: [
            ...options,
            { value: "clear", label: "Clear goal" },
            {
              value: "replace",
              label:
                goal.state === "complete" || goal.state === "blocked"
                  ? "Set a new goal"
                  : "Replace goal",
            },
          ],
        },
        {},
        "action",
      );
    }
    switch (input.action) {
      case "clear":
        yield* clearGoal(ctx, sessionId);
        return done({ type: "success", message: "Goal cleared." });
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
        const replacing =
          current !== undefined && current.state !== "complete" && !retried;
        if (replacing && input.confirmed === false)
          return declined({ type: "info", message: "Kept the current goal." });
        if (replacing && input.confirmed !== true)
          return ask(
            {
              type: "confirmation",
              message: `Replace the current goal?\nCurrent: ${current.objective}\nNew: ${input.objective}`,
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
  version: "4.1.0",
})
  .config(config)
  .state({ version: 4, migrations: {}, collections })
  .define({
    prompt: (ctx, { sessionId, origin }) =>
      Effect.gen(function* () {
        const goal = Option.getOrNull(yield* ctx.state.goals.get(sessionId));
        const current =
          goal === null ? "No current goal." : goalLine(committed(goal));
        return [
          {
            name: "goal",
            text: boundedPrompt(
              ctx.config.guide + "\n" + current,
              ctx.config.promptLimit,
            ),
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
        const history = Option.getOrUndefined(
          ctx.state.history.peek(sessionId),
        )?.history;
        return goal === undefined && history === undefined
          ? Option.none()
          : Option.some({
              goal: goal === undefined ? null : committed(goal),
              history: history ?? emptyHistory<Goal>(),
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
          clearGoal(ctx, sessionId),
        set: ({ sessionId, input }) => setGoal(ctx, sessionId, input),
      }),
    },
  });
