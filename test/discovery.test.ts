import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { z } from "zod";
import { botanicalAgentExtensions } from "../src/roster.js";
import { openAgent, sqliteOwner } from "./fixtures/host.js";

it("finds and describes every Ask, goal, loop and plan operation in a normal run", async () => {
  const store = sqliteOwner();
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("execute", { code: "discover" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const pathsByQuery = new Map<string, string[]>();
  const described: string[] = [];
  const listed: string[] = [];
  const inputSchemas = new Map<string, unknown>();
  let validationChecked = false;
  let refusal: unknown;
  const host = await openAgent(store.owner, botanicalAgentExtensions, {
    model: {
      acquire: () =>
        Effect.succeed({
          model: faux.model,
          stream: faux.stream,
          release: Effect.void,
        }),
    },
    tools: {
      sources: [],
      modules: [],
      sandbox: fromTypedSandbox({
        execute: async (request) => {
          const search = request.bindings.forage?.search;
          const describe = request.bindings.forage?.describe;
          const list = request.bindings.forage?.list;
          if (
            search === undefined ||
            describe === undefined ||
            list === undefined
          )
            throw new Error("Missing Forage catalog");
          let cursor: string | null = null;
          do {
            const page = z
              .object({
                results: z.array(z.object({ path: z.string() })),
                nextCursor: z.string().nullable(),
                total: z.number(),
              })
              .parse(
                await list(
                  cursor === null ? { limit: 3 } : { limit: 3, cursor },
                ),
              );
            expect(page.total).toBe(13);
            listed.push(...page.results.map((row) => row.path));
            cursor = page.nextCursor;
          } while (cursor !== null);
          for (const query of [
            "question",
            "goal",
            "loop",
            "schedule",
            "schedule_next",
            "plan",
            "complete",
          ]) {
            const result = z
              .object({ results: z.array(z.object({ path: z.string() })) })
              .parse(await search({ query }));
            const paths = result.results.map((row) => row.path);
            pathsByQuery.set(query, paths);
            for (const path of paths) {
              const description = z
                .object({
                  path: z.string(),
                  kind: z.literal("operation"),
                  inputSchema: z.json(),
                })
                .parse(await describe({ path }));
              described.push(description.path);
              inputSchemas.set(description.path, description.inputSchema);
            }
          }
          expect(request.bindings.ask).toBeUndefined();
          const question = request.bindings.question?.ask;
          if (question === undefined) throw new Error("Missing question.ask");
          try {
            refusal = await question({
              questions: [
                {
                  id: "choice",
                  header: "1234567890123",
                  question: "Choose?",
                  options: [
                    { label: "A", description: "First" },
                    { label: "B", description: "Second" },
                  ],
                },
              ],
              mode: "continue",
            });
          } catch (error) {
            refusal = error;
          }
          validationChecked = true;
          return { described };
        },
      }),
    },
  });
  try {
    await Effect.runPromise(
      host.agent.session("ordinary").send("Discover tools", {
        requestId: "discovery",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(validationChecked).toBe(true);
    expect(refusal).toMatchObject({
      _tag: "CapabilityFailed",
      cause: { kind: "InvalidInput" },
    });
    expect(z.object({ message: z.string() }).parse(refusal).message).toContain(
      "<=12 characters",
    );
    expect(pathsByQuery.get("question")).toEqual(
      expect.arrayContaining(["question.ask", "question.withdraw"]),
    );
    expect(described).toEqual(
      expect.arrayContaining(["question.ask", "question.withdraw"]),
    );
    expect(listed).not.toContain("question.answer");
    expect(pathsByQuery.get("goal")).toEqual(
      expect.arrayContaining([
        "goal.create_goal",
        "goal.get_goal",
        "goal.update_goal",
      ]),
    );
    expect(pathsByQuery.get("loop")).toEqual(
      expect.arrayContaining([
        "loop.get",
        "loop.start",
        "loop.stop",
        "loop.schedule_next",
      ]),
    );
    expect(pathsByQuery.get("schedule")).toContain("loop.schedule_next");
    expect(pathsByQuery.get("schedule_next")).toContain("loop.schedule_next");
    expect(pathsByQuery.get("plan")).toContain("plan.update_plan");
    expect(pathsByQuery.get("complete")).toContain("goal.update_goal");
    expect(described).toContain("plan.update_plan");
    expect(listed).toEqual([
      "forage.describe",
      "forage.list",
      "forage.search",
      "goal.create_goal",
      "goal.get_goal",
      "goal.update_goal",
      "loop.get",
      "loop.schedule_next",
      "loop.start",
      "loop.stop",
      "plan.update_plan",
      "question.ask",
      "question.withdraw",
    ]);
    expect(new Set(listed).size).toBe(13);
    const questionSchema = {
      properties: {
        questions: {
          minItems: 1,
          maxItems: 4,
          items: {
            properties: {
              header: { type: "string", minLength: 1, maxLength: 12 },
            },
          },
        },
      },
    };
    expect(inputSchemas.get("question.ask")).toMatchObject({
      anyOf: [questionSchema, questionSchema],
    });
    expect(inputSchemas.get("question.withdraw")).toMatchObject({
      properties: { askId: { maxLength: 256 } },
    });
    expect(inputSchemas.get("goal.create_goal")).toMatchObject({
      properties: { objective: { maxLength: 4000 } },
    });
    expect(inputSchemas.get("goal.update_goal")).toMatchObject({
      properties: { reason: { maxLength: 1000 } },
    });
    expect(inputSchemas.get("loop.start")).toMatchObject({
      properties: { prompt: { maxLength: 262144 } },
    });
    expect(inputSchemas.get("loop.stop")).toMatchObject({
      properties: { reason: { maxLength: 1000 } },
    });
    expect(inputSchemas.get("loop.schedule_next")).toMatchObject({
      properties: { reason: { maxLength: 4000 } },
    });
    expect(inputSchemas.get("plan.update_plan")).toMatchObject({
      properties: {
        explanation: { maxLength: 2000 },
        steps: {
          maxItems: 50,
          items: { properties: { step: { maxLength: 500 } } },
        },
      },
    });
    // An empty checklist is how the Agent clears its plan.
    expect(inputSchemas.get("plan.update_plan")).not.toHaveProperty(
      "properties.steps.minItems",
    );
  } finally {
    await host.close();
    store.close();
  }
});
