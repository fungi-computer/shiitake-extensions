import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { z } from "zod";
import { botanicalAgentExtensions } from "../src/roster.js";
import { openAgent, sqliteOwner } from "./fixtures/host.js";

/** One line this short costs about twenty-five tokens. */
const idleLineLimit = 100;

/** Every rule an extension's old guide told the model, as it must now be described. */
const rules = {
  goal: [
    "create_goal({objective})",
    "get_goal({})",
    "update_goal({status:'complete'|'blocked', reason})",
    "You may start a goal yourself",
    "audit every requirement against evidence",
    "same external impasse for three consecutive goal turns",
    "Human pause/resume/clear remain human controls",
    "plan.update_plan",
  ],
  loop: [
    "get({})",
    "start({prompt,cadence})",
    "schedule_next({delaySeconds,reason})",
    "stop({reason})",
    "You may start loops yourself; one live loop per Session",
    "only in the active self-paced loop's own run, clamped to 60–3600 seconds",
    "Omitting it ends that loop",
    "stop works in any Session run",
    "Human pause/resume/stop and Esc remain user controls",
  ],
  plan: [
    "update_plan({explanation?,steps:[{step,status:'pending'|'in_progress'|'completed'}]})",
    "multi-step work",
    "at most one in-progress step",
    "replace the whole plan on each update",
    "steps:[] to clear a plan",
    "not proof of goal completion",
  ],
  question: [
    "Use question.ask for decisions that need a person's answer",
    "Put the recommended option first",
    "do not add Other",
    "Use credential tools for secrets",
    "While a question is parked, finish independent work and end the turn",
  ],
} as const;

type Namespace = keyof typeof rules;
const namespaces: readonly Namespace[] = ["goal", "loop", "plan", "question"];

/** The prompt text of one extension's section. */
function section(prompt: string, namespace: Namespace): string {
  const found = prompt
    .split("\n\n[extension:")
    .slice(1)
    .find((candidate) =>
      candidate.startsWith(`botanical-session-${namespace}.${namespace}]`),
    );
  if (found === undefined) throw new Error(`No ${namespace} section`);
  return found.slice(found.indexOf("]\n") + 2).trimEnd();
}

async function run(requestedCode: readonly string[], activate = false) {
  const store = sqliteOwner();
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("execute", { code: "describe" }), {
      stopReason: "toolUse",
    }),
    ...Array.from({ length: 12 }, () => fauxAssistantMessage("done")),
  ]);
  const prompts: string[] = [];
  const descriptions = new Map<string, string>();
  const host = await openAgent(store.owner, botanicalAgentExtensions, {
    model: {
      acquire: () =>
        Effect.succeed({
          retryable: () => false,
          model: faux.model,
          release: Effect.void,
          stream: (model, context, options) => {
            const system = context.messages[0];
            if (system?.role !== "system")
              throw new Error("Missing system prompt");
            prompts.push(getSystemMessageText(system));
            return faux.stream(model, context, options);
          },
        }),
    },
    tools: {
      sources: [],
      modules: [],
      sandbox: fromTypedSandbox({
        execute: async (request) => {
          const describe = request.bindings.forage?.describe;
          if (describe === undefined)
            throw new Error("Missing forage.describe");
          for (const path of requestedCode)
            descriptions.set(
              path,
              z
                .object({ description: z.string() })
                .parse(await describe({ path })).description,
            );
          if (activate) {
            const { goal, plan, loop } = request.bindings;
            if (goal === undefined || plan === undefined || loop === undefined)
              throw new Error("Missing tool bindings");
            await goal.create_goal?.({ objective: "Tidy the kiln" });
            await plan.update_plan?.({
              steps: [{ step: "Sweep", status: "in_progress" }],
            });
            await loop.start?.({
              prompt: "Check the kiln",
              cadence: { kind: "self_paced" },
            });
          }
          return null;
        },
      }),
    },
  });
  try {
    await Effect.runPromise(
      host.agent
        .session("ordinary")
        .send("hello", { requestId: "prompt", delivery: "followUp" }),
    );
    await host.drain();
  } finally {
    await host.close();
    store.close();
  }
  return { prompts, descriptions };
}

it("says one short line per extension when no goal, plan, loop or question is active", async () => {
  const { prompts } = await run([]);
  const prompt = prompts[0];
  if (prompt === undefined) throw new Error("No prompt");
  for (const namespace of namespaces) {
    const text = section(prompt, namespace);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(idleLineLimit);
    expect(text).toContain(`forage.describe({path:'${namespace}'})`);
  }
});

it("lets the model load every goal, loop, plan and question rule with forage.describe", async () => {
  const { descriptions } = await run(namespaces);
  for (const namespace of namespaces)
    for (const rule of rules[namespace])
      expect(descriptions.get(namespace), `${namespace}: ${rule}`).toContain(
        rule,
      );
});

it("keeps the full guidance and current state while a goal, plan and loop are live", async () => {
  const { prompts } = await run([], true);
  const prompt = prompts.at(-1);
  if (prompt === undefined) throw new Error("No prompt");
  expect(prompts.length).toBeGreaterThan(1);
  const goal = section(prompt, "goal");
  expect(goal).toContain("Tidy the kiln");
  for (const rule of rules.goal.slice(3, 7)) expect(goal).toContain(rule);
  const plan = section(prompt, "plan");
  expect(plan).toContain("Sweep");
  for (const rule of rules.plan.slice(1)) expect(plan).toContain(rule);
  const loop = section(prompt, "loop");
  expect(loop).toContain("Check the kiln");
  for (const rule of rules.loop.slice(4, 8)) expect(loop).toContain(rule);
});
