import * as Clock from "effect/Clock";
import {
  appendHistory,
  emptyHistory,
  historySchema,
} from "../internal/history.js";
import { Mycelium } from "@fungi.computer/mycelium";
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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { catalog, done } from "../internal/catalog.js";
import { endingSince, goalEndings } from "../internal/goal-ended.js";
import { Plan, PlanInput, planContract, planIsOpen } from "./contract.js";

/** The rules the model follows; the describe page and an open plan's prompt share them. */
const rules =
  "Use it for multi-step work, with at most one in-progress step; replace the whole plan on each update, and pass steps:[] to clear a plan that no longer applies. A completed checklist is not proof of goal completion.";

const config = Object.freeze({
  promptLimit: 2_000,
  idle: "Multi-step work? forage.describe({path:'plan'}) first.",
  moduleDescription:
    "Session checklist tool: update_plan({explanation?,steps:[{step,status:'pending'|'in_progress'|'completed'}]}). " +
    rules,
  guide: "Session checklist tool: plan.update_plan. " + rules,
});
const collections = {
  history: defineCollection(
    Schema.Struct({ sessionId: Schema.String, history: historySchema(Plan) }),
    { key: (row) => row.sessionId },
  ),
  /** How many ended goals each Session's plan was last settled against. */
  goalEnds: defineCollection(
    Schema.Struct({ sessionId: Schema.String, total: Schema.Int }),
    { key: (row) => row.sessionId },
  ),
  plans: defineCollection(
    Schema.Struct({ sessionId: Schema.String, plan: Plan }),
    { key: (row) => row.sessionId },
  ),
};
const input = z
  .strictObject({
    explanation: z.string().max(2_000).optional(),
    steps: z
      .array(
        z.strictObject({
          step: z.string().min(1).max(500),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      )
      .max(50),
  })
  .transform((value) =>
    value.explanation === undefined
      ? { steps: value.steps }
      : { steps: value.steps, explanation: value.explanation },
  );

type Context = ExtensionContextV0<typeof collections, typeof config>;

/** Record how many goals had ended when this Session's plan began; only later endings settle it. */
function baselineGoalEnds(ctx: Context, sessionId: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* ctx.state.goalEnds.get(sessionId))) return;
    const { total } = yield* goalEndings(ctx, sessionId);
    yield* ctx.state.goalEnds.put({ sessionId, total });
  });
}

/**
 * The one write: the Agent's tool and the human's clear both replace the
 * checklist here, and every distinct replacement joins the history.
 */
function replacePlan(
  ctx: Context,
  sessionId: string,
  plan: Plan,
  commandId: string | null,
): Effect.Effect<void, ExtensionStateError, ExtensionTx | ExtensionRead> {
  return Effect.gen(function* () {
    const previous = Option.getOrUndefined(
      yield* ctx.state.plans.get(sessionId),
    );
    if (JSON.stringify(previous?.plan) !== JSON.stringify(plan)) {
      const history =
        Option.getOrUndefined(yield* ctx.state.history.get(sessionId))
          ?.history ?? emptyHistory<Plan>();
      yield* ctx.state.history.put({
        sessionId,
        history: appendHistory(
          history,
          plan,
          commandId,
          yield* Clock.currentTimeMillis,
        ),
      });
      yield* ctx.state.plans.put({ sessionId, plan });
      yield* baselineGoalEnds(ctx, sessionId);
    }
    yield* ctx.observe(sessionId);
  });
}

/**
 * A goal that ended settles its Session's checklist by code, never left to
 * the model to remember: achieved ticks the open steps, cleared clears it.
 */
function settleForEndedGoals(ctx: Context, sessionId: string) {
  return Effect.gen(function* () {
    const endings = yield* goalEndings(ctx, sessionId);
    const { total } = endings;
    const seen = yield* ctx.state.goalEnds.get(sessionId);
    const ending = endingSince(
      Option.isSome(seen) ? seen.value.total : undefined,
      endings,
    );
    if (Option.isNone(seen) || seen.value.total !== total)
      yield* ctx.state.goalEnds.put({ sessionId, total });
    // A plan that predates the count is not this goal's to settle.
    if (ending === "baseline" || ending === undefined) return;
    const found = yield* ctx.state.plans.get(sessionId);
    if (Option.isNone(found) || !planIsOpen(found.value.plan)) return;
    // Only an achieved goal finished its work; a cleared one closes the
    // checklist without claiming it was done.
    yield* replacePlan(
      ctx,
      sessionId,
      ending.outcome === "achieved"
        ? {
            ...found.value.plan,
            steps: found.value.plan.steps.map((step) => ({
              ...step,
              status: "completed" as const,
            })),
          }
        : { steps: [] },
      null,
    );
  });
}

/** Durable plan owner: replace, project and advertise through core's granted doors. */
export const planExtension: RosteredExtensionV0 = defineExtension({
  id: planContract.id,
  version: "2.0.0",
})
  .config(config)
  .state({ version: 2, migrations: {}, collections })
  .define({
    catalog: catalog([
      {
        id: "plan",
        title: "Plan",
        category: "Conversation",
        description: "View or clear the checklist",
        projections: {
          help: { order: 4 },
          palette: { order: 4 },
          slash: {
            aliases: ["plan"],
            order: 4,
            arguments: {
              hint: "[clear]",
              words: [
                {
                  word: "clear",
                  description: "Clear the plan",
                  arguments: { action: "clear" },
                },
              ],
            },
          },
        },
      },
    ]),
    hooks: {
      onSettled: (ctx, page) =>
        Effect.forEach(
          new Set(page.map((run) => run.sessionId)),
          (sessionId) => settleForEndedGoals(ctx, sessionId),
          { discard: true },
        ),
    },
    projection: {
      schema: planContract.projection.schema,
      read: (ctx, sessionId) =>
        Option.map(ctx.state.plans.peek(sessionId), (row) => ({
          plan: row.plan,
          history:
            Option.getOrUndefined(ctx.state.history.peek(sessionId))?.history ??
            emptyHistory<Plan>(),
        })),
    },
    prompt: (ctx, { sessionId }) =>
      ctx.state.plans.get(sessionId).pipe(
        Effect.map((found) => [
          {
            name: "plan",
            text:
              Option.isSome(found) && found.value.plan.steps.length > 0
                ? (
                    ctx.config.guide +
                    "\n" +
                    JSON.stringify(found.value.plan)
                  ).slice(0, ctx.config.promptLimit)
                : ctx.config.idle,
          },
        ]),
      ),
    tools: (ctx, { sessionId, workId }) =>
      Effect.succeed(
        Option.some(
          Mycelium.module({
            id: "botanical.session-plan",
            name: "plan",
            description: ctx.config.moduleDescription,
            operations: {
              update_plan: Mycelium.operation({
                replay: "safe",
                description:
                  "Replace the Session plan checklist. At most one step in_progress; up to 50 steps; steps:[] clears the plan.",
                input,
                output: z.strictObject({
                  completed: z.number(),
                  total: z.number(),
                }),
                execute: (value) =>
                  Effect.runPromise(
                    ctx.transact(
                      Effect.gen(function* () {
                        const plan = yield* Schema.decodeUnknownEffect(
                          PlanInput,
                        )(value).pipe(
                          Effect.mapError(
                            () =>
                              new ExtensionCommandError({
                                reason: "invalid",
                                message:
                                  "Invalid plan: at most one in-progress step",
                              }),
                          ),
                        );
                        yield* replacePlan(ctx, sessionId, plan, workId);
                        return {
                          completed: plan.steps.filter(
                            (step) => step.status === "completed",
                          ).length,
                          total: plan.steps.length,
                        };
                      }),
                    ),
                  ),
              }),
            },
          }),
        ),
      ),
    commands: {
      specs: planContract.commands,
      handlers: (ctx) => ({
        plan: ({ sessionId, input }) =>
          Effect.gen(function* () {
            const plan = Option.getOrUndefined(
              yield* ctx.state.plans.get(sessionId),
            )?.plan;
            if (plan === undefined || plan.steps.length === 0)
              return done({
                type: "info",
                message: "This Session has no plan.",
              });
            if ("action" in input) {
              yield* replacePlan(ctx, sessionId, { steps: [] }, null);
              return done({ type: "success", message: "Plan cleared." });
            }
            // An open plan's footer row opens its checklist; a finished one is hidden.
            return planIsOpen(plan)
              ? { type: "done" as const }
              : done({
                  type: "info",
                  message: `Plan complete: ${String(plan.steps.length)}/${String(plan.steps.length)} steps.`,
                });
          }),
      }),
    },
  });
