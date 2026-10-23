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
    }
    yield* ctx.observe(sessionId);
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
