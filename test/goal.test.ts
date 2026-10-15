import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import type { SandboxRequest } from "@fungi.computer/mycelium";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import type { ShiitakeEffectOptions } from "@fungi.computer/shiitake/effect";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";

import { goalContract } from "../src/goal/contract.js";
import { goalExtension } from "../src/goal/host.js";
import { grantAll, openAgent, sqliteOwner } from "./fixtures/host.js";

/** The goal tool inputs this test sends through the sandbox bindings. */
type GoalToolInput = Readonly<Record<string, string | number>>;

type FauxResponse = Parameters<
  ReturnType<typeof fauxModel>["setResponses"]
>[0][number];

/** One shared faux model that answers each run in order. */
function scriptedModel(
  responses: readonly FauxResponse[],
): ShiitakeEffectOptions["model"] {
  const faux = fauxModel([]);
  faux.setResponses([...responses]);
  return {
    acquire: () =>
      Effect.succeed({
        model: faux.model,
        stream: faux.stream,
        release: Effect.void,
      }),
  };
}

async function openGoal(
  overrides: Parameters<typeof openAgent>[2] = {},
  store = sqliteOwner(),
) {
  const host = await openAgent(
    store.owner,
    grantAll([goalExtension]),
    overrides,
  );
  const session = host.session("garden");
  const goal = bindSessionExtension(session, goalContract);
  const commands = async () =>
    (await session.read()).pending.prompts.length +
    (await session.read()).messages.filter(({ value }) => value.role === "user")
      .length;
  return {
    ...host,
    store,
    goal,
    commands,
    view: async () => goal.view(await session.read()),
    dispose: async () => {
      await host.close();
      store.close();
    },
  };
}

it("sets a goal with one idempotent first admission and guards replacement by revision", async () => {
  const host = await openGoal();
  try {
    expect(await host.view()).toEqual({ status: "running", value: null });
    const first = await host.goal.call("set", {
      objective: "  ship the fern  ",
      expectedRevision: null,
      requestId: "set-1",
    });
    expect(first.goal).toMatchObject({
      objective: "  ship the fern  ",
      state: "active",
      stopReason: null,
    });
    await expect(
      host.goal.call("set", {
        objective: "  ship the fern  ",
        expectedRevision: null,
        requestId: "set-1",
      }),
    ).resolves.toEqual(first);
    await expect(
      host.goal.call("set", {
        objective: "ship the fern",
        expectedRevision: null,
        requestId: "set-1",
      }),
    ).rejects.toMatchObject({ boundary: "contract", cause: "conflict" });
    await expect(
      host.goal.call("set", {
        objective: "Replace it",
        expectedRevision: null,
        requestId: "set-2",
      }),
    ).rejects.toMatchObject({ boundary: "store", cause: "conflict" });
    await expect(
      host.goal.call("set", {
        objective: "   ",
        expectedRevision: first.goal.revision,
        requestId: "set-3",
      }),
    ).rejects.toMatchObject({ boundary: "contract", cause: "invalid" });
    expect(await host.view()).toEqual({
      status: "running",
      value: {
        goal: first.goal,
        history: { events: [], omitted: 0, nextSequence: 1 },
      },
    });
  } finally {
    await host.dispose();
  }
});

it("continues an active goal once per settled run and stops continuing while paused", async () => {
  const host = await openGoal();
  try {
    await host.goal.call("set", {
      objective: "Tend the garden",
      expectedRevision: null,
      requestId: "tend",
    });
    await host.reconcile();
    // The set prompt settled; exactly one continuation is waiting.
    expect(await host.commands()).toBe(2);
    await host.goal.call("pause", {});
    await host.drain();
    expect(await host.commands()).toBe(2);
    expect(await host.view()).toMatchObject({
      status: "running",
      value: { goal: { state: "paused", stopReason: null } },
    });
    const messages = (await host.session("garden").read()).messages;
    expect(messages.map(({ value }) => value.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[2]?.value.content).toBe("Goal turn · Tend the garden");
  } finally {
    await host.dispose();
  }
});

it("keeps continuation instructions in model context instead of the visible Goal turn", async () => {
  const prompts: string[] = [];
  const host = await openGoal({
    model: {
      acquire: () =>
        Effect.sync(() => {
          const faux = fauxModel([]);
          faux.setResponses([fauxAssistantMessage("done")]);
          return {
            model: faux.model,
            release: Effect.void,
            stream: (model, context, options) => {
              const system = context.messages[0];
              if (system?.role !== "system")
                throw new Error("Missing system prompt");
              prompts.push(getSystemMessageText(system));
              return faux.stream(model, context, options);
            },
          };
        }),
    },
  });
  try {
    const first = await host.goal.call("set", {
      objective: "Keep the menus tidy",
      expectedRevision: null,
      requestId: "menus",
    });
    await host.reconcile();
    await host.reconcile();
    await host.goal.call("pause", {});
    await host.drain();
    const messages = (await host.session("garden").read()).messages;
    expect(messages[0]?.origin).toEqual({
      extensionId: goalContract.id,
      correlation: null,
    });
    expect(messages[2]?.origin).toEqual({
      extensionId: goalContract.id,
      correlation: first.goal.revision,
    });
    expect(messages[2]?.value.content).toBe("Goal turn · Keep the menus tidy");
    expect(prompts[0]).toContain("Keep the menus tidy");
    expect(prompts[0]).not.toContain("Continue working toward");
    expect(prompts[1]).toContain(
      "Continue working toward the current goal described in the goal section.",
    );
    expect(prompts[1]).toContain(
      "Find goal.get_goal and goal.update_goal with forage.search({query:'goal'}) and forage.describe.",
    );
    expect(prompts[1]).toContain(
      "Audit every requirement against evidence before goal.update_goal({status:'complete', reason}).",
    );
    expect(prompts[1]).toContain(
      "If the same external blocker persists for three goal turns, report blocked with a reason.",
    );
    expect(prompts[1]).toContain(
      "Check for progress rather than repeating yourself.",
    );
  } finally {
    await host.dispose();
  }
});

it("keeps the active Goal in context without directing a human-triggered run", async () => {
  const prompts: string[] = [];
  const host = await openGoal({
    model: {
      acquire: () =>
        Effect.sync(() => {
          const faux = fauxModel([]);
          faux.setResponses([fauxAssistantMessage("Answered the human")]);
          return {
            model: faux.model,
            release: Effect.void,
            stream: (model, context, options) => {
              const system = context.messages[0];
              if (system?.role !== "system")
                throw new Error("Missing system prompt");
              prompts.push(getSystemMessageText(system));
              return faux.stream(model, context, options);
            },
          };
        }),
    },
  });
  try {
    await host.goal.call("set", {
      objective: "Keep the menus tidy",
      expectedRevision: null,
      requestId: "human-goal",
    });
    await Effect.runPromise(
      host.agent
        .session("garden")
        .send("Answer this unrelated question instead", {
          delivery: "followUp",
          requestId: "human-question",
        }),
    );
    await host.reconcile();
    await host.reconcile();
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain("Keep the menus tidy");
      expect(prompt).not.toContain("Continue working toward");
    }
    expect(await host.view()).toMatchObject({
      status: "running",
      value: { goal: { state: "active" } },
    });
    await host.goal.call("pause", {});
    await host.drain();
  } finally {
    await host.dispose();
  }
});

it("replies to a maximum multibyte objective without stopping Goal", async () => {
  const prompts: string[] = [];
  const host = await openGoal({
    model: {
      acquire: () =>
        Effect.sync(() => {
          const faux = fauxModel([]);
          faux.setResponses([fauxAssistantMessage("Still tending the goal")]);
          return {
            model: faux.model,
            release: Effect.void,
            stream: (model, context, options) => {
              const system = context.messages[0];
              if (system?.role !== "system")
                throw new Error("Missing system prompt");
              prompts.push(getSystemMessageText(system));
              return faux.stream(model, context, options);
            },
          };
        }),
    },
  });
  try {
    await host.goal.call("set", {
      objective: "€".repeat(4_000),
      expectedRevision: null,
      requestId: "multibyte-goal",
    });
    await host.reconcile();
    await host.reconcile();
    expect(
      (await host.session("garden").read()).messages.filter(
        ({ value }) => value.role === "assistant",
      ),
    ).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      const sections = prompt.split("\n\n[extension:").slice(1);
      expect(sections.length).toBeGreaterThan(0);
      for (const section of sections) {
        const text = section.slice(section.indexOf("]\n") + 2);
        expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
          1_024,
        );
        expect(text).not.toContain("�");
      }
      expect(prompt).toContain("€");
    }
    expect(prompts[1]).toContain("Continue working toward the current goal");
    expect(await host.view()).toMatchObject({
      status: "running",
      value: { goal: { state: "active" } },
    });
    await host.goal.call("pause", {});
    await host.drain();
    expect(await host.view()).toMatchObject({
      status: "running",
      value: { goal: { state: "paused" } },
    });
  } finally {
    await host.dispose();
  }
});

it("commits a model-requested terminal only when its run settles successfully", async () => {
  const calls: string[] = [];
  const results: unknown[] = [];
  const tools = {
    modules: [],
    sources: [],
    sandbox: fromTypedSandbox({
      execute: async (request: SandboxRequest) => {
        const code = request.code;
        calls.push(code);
        const goal = request.bindings.goal;
        if (goal === undefined) throw new Error("goal tools are missing");
        const call = (name: string, input: GoalToolInput) => {
          const operation = goal[name];
          if (operation === undefined) throw new Error(`missing ${name}`);
          return operation(input);
        };
        if (code === "create") {
          const created = await call("create_goal", {
            objective: "Finish the fern",
          });
          const rejected: string[] = [];
          for (const input of [
            { objective: "Replacement" },
            { objective: "Budgeted", token_budget: 1 },
          ])
            try {
              await call("create_goal", input);
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              rejected.push(error.message);
            }
          results.push({ created, rejected });
          return created;
        }
        const result = await (code === "update"
          ? call("update_goal", {
              status: "complete",
              reason: "Verified the fern",
            })
          : call("get_goal", {}));
        results.push(result);
        return result;
      },
    }),
  };
  const host = await openGoal({
    tools,
    model: scriptedModel([
      fauxAssistantMessage(fauxToolCall("execute", { code: "create" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("execute", { code: "update" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("execute", { code: "get" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("goal complete"),
    ]),
  });
  try {
    await Effect.runPromise(
      host.agent.session("garden").send("Work on the fern", {
        requestId: "work",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(calls).toEqual(["create", "update", "get"]);
    expect(results[0]).toMatchObject({
      created: { objective: "Finish the fern", state: "active" },
      rejected: [
        "A nonterminal Session goal already exists",
        expect.any(String),
      ],
    });
    // The model saw its provisional terminal before settlement committed it.
    expect(results[2]).toEqual({
      objective: "Finish the fern",
      state: "complete",
      stopReason: "Verified the fern",
    });
    expect(await host.view()).toMatchObject({
      status: "running",
      value: {
        goal: {
          objective: "Finish the fern",
          state: "complete",
          stopReason: "Verified the fern",
        },
        history: {
          nextSequence: 2,
          omitted: 0,
          events: [
            {
              id: "1",
              sequence: 1,
              event: { state: "complete", objective: "Finish the fern" },
            },
          ],
        },
      },
    });
    const committed = await host.view();
    if (committed.status !== "running" || committed.value === null)
      throw new Error("Completed Goal projection unavailable");
    const workIds = new Set(
      (await host.session("garden").read()).messages.map(
        ({ commandId }) => commandId,
      ),
    );
    expect(
      committed.value.history.events.every(
        ({ commandId }) => commandId !== null && workIds.has(commandId),
      ),
    ).toBe(true);
    await host.drain();
    expect(await host.view()).toEqual(committed);
    expect(await host.commands()).toBe(1);
    await host.close();
    const reopened = await openGoal({}, host.store);
    try {
      await reopened.drain();
      expect(await reopened.view()).toEqual(committed);
    } finally {
      await reopened.close();
    }
  } finally {
    await host.dispose();
  }
});

it("shows failed goal work as a visible stop and retries it on a human resume", async () => {
  let failNext = true;
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage("resumed"),
    fauxAssistantMessage("still going"),
  ]);
  const host = await openGoal({
    model: {
      acquire: () =>
        Effect.suspend(() => {
          if (failNext) {
            failNext = false;
            return Effect.die(new Error("model unavailable"));
          }
          return Effect.succeed({
            model: faux.model,
            stream: faux.stream,
            release: Effect.void,
          });
        }),
    },
  });
  try {
    await host.goal.call("set", {
      objective: "Keep the lights on",
      expectedRevision: null,
      requestId: "lights",
    });
    await host.drain();
    expect(await host.view()).toMatchObject({
      status: "running",
      value: {
        goal: { state: "active", stopReason: "Goal work ended failed" },
      },
    });
    expect(await host.commands()).toBe(1);

    const resumed = await host.goal.call("resume", {});
    expect(resumed).toMatchObject({ state: "active", stopReason: null });
    expect(await host.commands()).toBe(2);
    await host.goal.call("pause", {});
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "paused", stopReason: null } },
    });
  } finally {
    await host.dispose();
  }
});

it("does not continue a paused goal or duplicate a continuation across cold reopens", async () => {
  const store = sqliteOwner();
  const first = await openGoal({}, store);
  await first.goal.call("set", {
    objective: "Rest",
    expectedRevision: null,
    requestId: "rest",
  });
  await first.goal.call("pause", {});
  await first.close();
  for (let reopen = 0; reopen < 2; reopen += 1) {
    const next = await openGoal({}, store);
    await next.drain();
    expect(await next.commands()).toBe(1);
    await next.close();
  }
  const last = await openGoal({}, store);
  try {
    await last.goal.call("resume", {});
    expect(await last.commands()).toBe(2);
    await last.goal.call("pause", {});
    await last.drain();
    expect(await last.commands()).toBe(2);
  } finally {
    await last.dispose();
  }
});

it("reports an unavailable goal when the host did not roster it", async () => {
  const store = sqliteOwner();
  const host = await openAgent(store.owner, grantAll([]));
  try {
    const goal = bindSessionExtension(host.session("garden"), goalContract);
    expect(goal.view(await host.session("garden").read())).toEqual({
      status: "unavailable",
    });
    await expect(goal.call("pause", {})).rejects.toMatchObject({
      boundary: "extensions",
      cause: "unavailable",
    });
  } finally {
    await host.close();
    store.close();
  }
});

it("pauses after three tool-free continuations and human resume resets the stall", async () => {
  const store = sqliteOwner();
  const first = await openGoal({}, store);
  await first.goal.call("set", {
    objective: "Do something",
    expectedRevision: null,
    requestId: "stall",
  });
  await first.reconcile();
  await first.reconcile();
  await first.close();
  const reopened = await openGoal({}, store);
  try {
    await reopened.drain();
    expect(await reopened.commands()).toBe(4);
    expect(await reopened.view()).toMatchObject({
      value: {
        goal: {
          state: "paused",
          stopReason: "Stalled: no progress for 3 turns. /goal resume to retry",
        },
      },
    });
    await reopened.goal.call("resume", {});
    await reopened.drain();
    expect(await reopened.commands()).toBe(7);
    expect(await reopened.view()).toMatchObject({
      value: { goal: { state: "paused" } },
    });
  } finally {
    await reopened.dispose();
  }
});

it("clears a goal without admitting any further work", async () => {
  const host = await openGoal();
  try {
    await host.goal.call("set", {
      objective: "Rest",
      expectedRevision: null,
      requestId: "clear-me",
    });
    await host.goal.call("clear", {});
    await host.drain();
    expect(await host.view()).toEqual({ status: "running", value: null });
    expect(await host.commands()).toBe(1);
  } finally {
    await host.dispose();
  }
});

it("advertises goal tools through a bounded prompt on every ordinary run", async () => {
  const prompts: string[] = [];
  const faux = fauxModel([]);
  faux.setResponses([fauxAssistantMessage("done")]);
  const host = await openGoal({
    model: {
      acquire: () =>
        Effect.succeed({
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
  });
  try {
    await Effect.runPromise(
      host.agent
        .session("garden")
        .send("hello", { requestId: "guide", delivery: "followUp" }),
    );
    await host.drain();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("goal.create_goal");
    expect(prompts[0]).toContain("goal.update_goal");
    expect(prompts[0]).toContain("You may start a goal yourself");
    expect(prompts[0]?.length).toBeLessThan(1_200);
  } finally {
    await host.dispose();
  }
});

it("keeps a deleted Session absent when its retained goal is resumed", async () => {
  const host = await openGoal();
  try {
    await host.goal.call("set", {
      objective: "Finish the garden",
      requestId: "deleted-goal",
      expectedRevision: null,
    });
    await host.drain();
    expect(await host.view()).toMatchObject({
      status: "running",
      value: { goal: { state: "paused" } },
    });
    expect(await Effect.runPromise(host.agent.deleteSession("garden"))).toBe(
      true,
    );
    const resumed = await host.goal.call("resume", {});
    expect(resumed).toMatchObject({
      state: "paused",
    });
    expect(resumed.stopReason).toContain("unavailable");
    expect(
      (await Effect.runPromise(host.agent.listSessions())).sessions,
    ).toEqual([]);
    expect(
      (await host.extensions.list()).find(({ id }) => id === goalContract.id)
        ?.status,
    ).toBe("running");
  } finally {
    await host.dispose();
  }
});
