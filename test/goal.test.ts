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
import {
  defineExtension,
  ExtensionId,
} from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { goalContract } from "../src/goal/contract.js";
import { goalExtension, goalExtensionFor } from "../src/goal/host.js";
import type { SubagentSource } from "../src/subagents/host.js";
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
        retryable: () => false,
        model: faux.model,
        stream: faux.stream,
        release: Effect.void,
      }),
  };
}

async function openGoal(
  overrides: Parameters<typeof openAgent>[2] = {},
  store = sqliteOwner(),
  subagents?: SubagentSource,
) {
  const host = await openAgent(
    store.owner,
    grantAll([
      subagents === undefined ? goalExtension : goalExtensionFor(subagents),
    ]),
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

async function expectPausedAttention(
  host: Awaited<ReturnType<typeof openGoal>>,
  summary: string,
  kind: "goal-blocked" | "goal-stalled",
) {
  expect((await host.session("garden").read()).attention).toEqual([
    expect.objectContaining({
      extensionId: goalContract.id,
      kind,
      inbox: false,
      summary,
    }),
  ]);
}

it("a person's pause records its typed cause without asking for human attention", async () => {
  const host = await openGoal();
  try {
    await host.goal.call("set", {
      objective: "Wait until tomorrow",
      expectedRevision: null,
      requestId: "person-pause",
    });
    await host.goal.call("pause", {});
    expect((await host.session("garden").read()).attention).toEqual([]);
    expect(await host.view()).toMatchObject({
      value: {
        goal: {
          state: "paused",
          pauseCause: { kind: "person", detail: null },
        },
      },
    });
  } finally {
    await host.dispose();
  }
});

it("person pause stays out of attention across resume, replacement and clear", async () => {
  const host = await openGoal();
  try {
    const first = await host.goal.call("set", {
      objective: "Tend the garden",
      expectedRevision: null,
      requestId: "attention-goal",
    });
    const before = await Effect.runPromise(host.agent.listSessions());
    expect(before.sessions[0]).toMatchObject({ state: "running" });
    await host.goal.call("pause", {});
    await host.goal.call("pause", {});
    expect((await host.session("garden").read()).attention).toEqual([]);
    expect(
      (await Effect.runPromise(host.agent.listSessions())).sessions,
    ).toEqual(before.sessions);

    await host.goal.call("resume", {});
    expect((await host.session("garden").read()).attention).toEqual([]);
    await host.goal.call("pause", {});
    await host.goal.call("set", {
      objective: "Plant the ferns",
      expectedRevision: first.goal.revision,
      requestId: "replace-attention-goal",
    });
    expect((await host.session("garden").read()).attention).toEqual([]);
    await host.goal.call("pause", {});
    expect((await host.session("garden").read()).attention).toEqual([]);
    await host.goal.call("clear", {});
    expect((await host.session("garden").read()).attention).toEqual([]);
  } finally {
    await host.dispose();
  }
});

it("bounds paused-goal attention to the existing 200-character summary contract", async () => {
  const host = await openGoal({
    tools: terminalTools("No access"),
    model: scriptedModel([
      fauxAssistantMessage(fauxToolCall("execute", { code: "block" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Blocked."),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "x".repeat(300),
      expectedRevision: null,
      requestId: "long-attention-goal",
    });
    await host.drain();
    const [attention] = (await host.session("garden").read()).attention;
    expect(attention).toMatchObject({ kind: "goal-blocked", inbox: false });
    expect(attention?.summary).toHaveLength(200);
  } finally {
    await host.dispose();
  }
});

/** A model whose reply after `before` waits until the test releases it. */
function heldModel(
  later: readonly FauxResponse[] = [],
  before: readonly FauxResponse[] = [],
) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const faux = fauxModel([]);
  faux.setResponses([
    ...before,
    async () => {
      started = true;
      await held;
      return fauxAssistantMessage("late reply");
    },
    ...later,
  ]);
  return {
    model: {
      acquire: () =>
        Effect.succeed({
          retryable: () => false,
          model: faux.model,
          stream: faux.stream,
          release: Effect.void,
        }),
    } satisfies ShiitakeEffectOptions["model"],
    started: () => started,
    release: () => {
      release();
    },
  };
}

/** Goal tools driven by the model's `execute` code: "block" or "complete". */
function terminalTools(
  reason: string,
): NonNullable<ShiitakeEffectOptions["tools"]> {
  return {
    modules: [],
    sources: [],
    sandbox: fromTypedSandbox({
      execute: async (request: SandboxRequest) => {
        const operation = request.bindings.goal?.update_goal;
        if (operation === undefined) throw new Error("goal tools are missing");
        return operation({
          status: request.code === "block" ? "blocked" : "complete",
          reason,
        });
      },
    }),
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
      pauseCause: null,
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
        ended: [],
        omitted: 0,
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
      value: {
        goal: { state: "paused", pauseCause: { kind: "person", detail: null } },
      },
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

it("R3 an achieved goal commits only on successful settlement, then leaves the current slot for history", async () => {
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
        "A Session goal is already active or paused; complete it first, or only a person replaces it",
        expect.any(String),
      ],
    });
    // The model saw its provisional terminal before settlement committed it.
    expect(results[2]).toEqual({
      objective: "Finish the fern",
      state: "complete",
      reason: "Verified the fern",
    });
    expect(await host.view()).toMatchObject({
      status: "running",
      value: {
        goal: null,
        ended: [
          {
            sequence: 1,
            objective: "Finish the fern",
            outcome: "achieved",
            reason: "Verified the fern",
          },
        ],
        omitted: 0,
      },
    });
    const committed = await host.view();
    if (committed.status !== "running" || committed.value === null)
      throw new Error("Completed Goal projection unavailable");
    expect((await host.session("garden").read()).attention).toEqual([]);
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

it("R1 a failed run pauses the goal (never leaves it active) and a human resume retries it", async () => {
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
            retryable: () => false,
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
        goal: {
          state: "paused",
          pauseCause: { kind: "failed", detail: "Goal work failed" },
        },
      },
    });
    expect(await host.commands()).toBe(1);
    expect((await host.session("garden").read()).attention).toEqual([]);

    const resumed = await host.goal.call("resume", {});
    expect((await host.session("garden").read()).attention).toEqual([]);
    expect(resumed).toMatchObject({ state: "active", pauseCause: null });
    expect(await host.commands()).toBe(2);
    await host.goal.call("pause", {});
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: {
        goal: { state: "paused", pauseCause: { kind: "person", detail: null } },
      },
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
    expect((await next.session("garden").read()).attention).toEqual([]);
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
  const host = await openGoal();
  try {
    await host.goal.call("set", {
      objective: "Do something",
      expectedRevision: null,
      requestId: "stall",
    });
    await host.drain();
    expect(await host.commands()).toBe(4);
    await expectPausedAttention(
      host,
      "Goal paused: Do something (Stalled: no progress for 3 turns)",
      "goal-stalled",
    );
    expect(await host.view()).toMatchObject({
      value: {
        goal: {
          state: "paused",
          pauseCause: {
            kind: "stalled",
            detail: "Stalled: no progress for 3 turns",
          },
        },
      },
    });
    await host.goal.call("resume", {});
    await host.drain();
    expect(await host.commands()).toBe(7);
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "paused" } },
    });
  } finally {
    await host.dispose();
  }
});

it("completes a stalled goal from its own Agent's later command", async () => {
  const attempts: string[] = [];
  const host = await openGoal({
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) => {
          const update = request.bindings.goal?.update_goal;
          if (update === undefined) throw new Error("goal tools are missing");
          try {
            const result = await update({
              status: "complete",
              reason: "Verified every requirement",
            });
            attempts.push(JSON.stringify(result));
            return result;
          } catch (error) {
            attempts.push(
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        },
      }),
    },
    model: scriptedModel([
      fauxAssistantMessage("first reply"),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage(fauxToolCall("execute", { code: "finish" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "Finish the fern",
      expectedRevision: null,
      requestId: "stalled-first-command",
    });
    await host.drain();
    await expectPausedAttention(
      host,
      "Goal paused: Finish the fern (Stalled: no progress for 3 turns)",
      "goal-stalled",
    );
    await Effect.runPromise(
      host.agent.session("garden").send("Finished; close your goal", {
        delivery: "followUp",
        requestId: "later-command",
      }),
    );
    await host.drain();
    expect(attempts).toEqual([
      JSON.stringify({
        objective: "Finish the fern",
        state: "complete",
        reason: "Verified every requirement",
      }),
    ]);
    expect(await host.view()).toMatchObject({
      value: {
        goal: null,
        ended: [{ outcome: "achieved", reason: "Verified every requirement" }],
      },
    });
  } finally {
    await host.dispose();
  }
});

/** A sandbox whose every execute sends one update_goal and records the outcome. */
function updateEveryExecute(
  input: GoalToolInput,
  outcomes: string[],
): NonNullable<NonNullable<Parameters<typeof openGoal>[0]>["tools"]> {
  return {
    modules: [],
    sources: [],
    sandbox: fromTypedSandbox({
      execute: async (request: SandboxRequest) => {
        const update = request.bindings.goal?.update_goal;
        if (update === undefined) throw new Error("goal tools are missing");
        try {
          const result = await update(input);
          outcomes.push(JSON.stringify(result));
          return result;
        } catch (error) {
          outcomes.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    }),
  };
}

it("lets an Agent resume its own stalled goal, which admits the next goal turn", async () => {
  const outcomes: string[] = [];
  const host = await openGoal({
    tools: updateEveryExecute(
      { status: "resume", reason: "The builder reported back" },
      outcomes,
    ),
    model: scriptedModel([
      fauxAssistantMessage("first reply"),
      ...Array.from({ length: 3 }, () => fauxAssistantMessage("waiting")),
      fauxAssistantMessage(fauxToolCall("execute", { code: "resume" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("resumed"),
      ...Array.from({ length: 3 }, () => fauxAssistantMessage("waiting")),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "Integrate the lanes",
      expectedRevision: null,
      requestId: "self-resume",
    });
    await host.drain();
    expect(await host.commands()).toBe(4);
    await expectPausedAttention(
      host,
      "Goal paused: Integrate the lanes (Stalled: no progress for 3 turns)",
      "goal-stalled",
    );
    await Effect.runPromise(
      host.agent.session("garden").send("Builder: READY", {
        delivery: "followUp",
        requestId: "builder-ready",
      }),
    );
    await host.drain();
    expect(outcomes).toEqual([
      JSON.stringify({
        objective: "Integrate the lanes",
        state: "active",
        reason: "The builder reported back",
      }),
    ]);
    // The resumed goal ran three more goal turns of its own, then the
    // ordinary stall guard paused it again.
    expect(await host.commands()).toBe(8);
    await expectPausedAttention(
      host,
      "Goal paused: Integrate the lanes (Stalled: no progress for 3 turns)",
      "goal-stalled",
    );
  } finally {
    await host.dispose();
  }
});

it("refuses an Agent's resume of a goal a person paused", async () => {
  const outcomes: string[] = [];
  const host = await openGoal({
    tools: updateEveryExecute(
      { status: "resume", reason: "I want to keep going" },
      outcomes,
    ),
    model: scriptedModel([
      fauxAssistantMessage("first reply"),
      fauxAssistantMessage(fauxToolCall("execute", { code: "resume" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("still paused"),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "Hold for review",
      expectedRevision: null,
      requestId: "person-held",
    });
    await host.goal.call("pause", {});
    await host.drain();
    await Effect.runPromise(
      host.agent.session("garden").send("Please continue", {
        delivery: "followUp",
        requestId: "continue-please",
      }),
    );
    await host.drain();
    expect(outcomes).toEqual([
      "A person paused or stopped this goal; only complete is available to you",
    ]);
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "paused", pauseCause: { kind: "person" } } },
    });
  } finally {
    await host.dispose();
  }
});

it("rechecks a waiting goal on its timer and continues once the child command settles", async () => {
  const startAt = Date.parse("2026-10-26T12:00:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startAt);
  let live = true;
  const subagents: SubagentSource = {
    hasLiveChildCommand: () => live,
    read: () => Promise.resolve({ agents: [], more: 0 }),
    open: () => Promise.reject(new Error("No child read in settlement")),
  };
  const host = await openGoal({}, sqliteOwner(), subagents);
  try {
    await host.goal.call("set", {
      objective: "Land the builder's work",
      expectedRevision: null,
      requestId: "timer-wait",
    });
    await host.drain();
    expect(await host.commands()).toBe(1);
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: startAt + 60_000,
    });
    // Still live at the first check: the goal keeps waiting and re-arms.
    vi.setSystemTime(startAt + 60_000);
    await host.drain();
    expect(await host.commands()).toBe(1);
    expect((await host.session("garden").read()).attention).toEqual([
      expect.objectContaining({ kind: "goal-waiting" }),
    ]);
    // The child settled without mailing back: the next check continues.
    live = false;
    vi.setSystemTime(startAt + 120_000);
    await host.drain();
    expect(await host.commands()).toBe(4);
    await expectPausedAttention(
      host,
      "Goal paused: Land the builder's work (Stalled: no progress for 3 turns)",
      "goal-stalled",
    );
  } finally {
    await host.dispose();
    vi.useRealTimers();
  }
});

it("rejects an old run's update after a goal is replaced", async () => {
  let entered = false;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rejected: string[] = [];
  const host = await openGoal({
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) => {
          const update = request.bindings.goal?.update_goal;
          if (update === undefined) throw new Error("goal tools are missing");
          entered = true;
          await held;
          try {
            return await update({ status: "complete", reason: "Old run" });
          } catch (error) {
            rejected.push(
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        },
      }),
    },
    model: scriptedModel([
      fauxAssistantMessage("starting"),
      fauxAssistantMessage(fauxToolCall("execute", { code: "finish" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("old result"),
      fauxAssistantMessage("new result"),
    ]),
  });
  let running: Promise<void> | undefined;
  try {
    const first = await host.goal.call("set", {
      objective: "First task",
      expectedRevision: null,
      requestId: "first-task",
    });
    await host.reconcile();
    running = host.reconcile();
    await expect.poll(() => entered).toBe(true);
    await host.goal.call("set", {
      objective: "New task",
      expectedRevision: first.goal.revision,
      requestId: "replacement-task",
    });
    release();
    await running;
    expect(rejected).toEqual(["Session goal work guard is stale"]);
    expect(await host.view()).toMatchObject({
      value: { goal: { objective: "New task" } },
    });
  } finally {
    release();
    await running;
    await host.dispose();
  }
});

it("waits visibly only for live child commands and resumes the ordinary stall guard after settlement", async () => {
  let live = true;
  const subagents: SubagentSource = {
    hasLiveChildCommand: () => live,
    read: () =>
      Promise.resolve({
        agents: [{ agentId: "child", name: "Child", sessionId: "child-work" }],
        more: 0,
      }),
    open: () =>
      Promise.reject(
        new Error("Progress lookup must not cross the settlement transaction"),
      ),
  };
  const host = await openGoal({}, sqliteOwner(), subagents);
  try {
    await host.goal.call("set", {
      objective: "Review the child work",
      expectedRevision: null,
      requestId: "delegated-goal",
    });
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "active" } },
    });
    expect(await host.commands()).toBe(1);
    expect((await host.session("garden").read()).attention).toEqual([
      expect.objectContaining({ kind: "goal-waiting", inbox: false }),
    ]);
    live = false;
    await Effect.runPromise(
      host.agent.session("garden").send("Child has reported progress", {
        requestId: "child-progress",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(await host.commands()).toBe(5);
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "paused" } },
    });
    await expectPausedAttention(
      host,
      "Goal paused: Review the child work (Stalled: no progress for 3 turns)",
      "goal-stalled",
    );
  } finally {
    await host.dispose();
  }
});

it("a polling goal turn with a live child waits and admits no continuation", async () => {
  const subagents: SubagentSource = {
    hasLiveChildCommand: () => true,
    read: () => Promise.resolve({ agents: [], more: 0 }),
    open: () =>
      Promise.reject(new Error("No child read belongs in settlement")),
  };
  const host = await openGoal(
    {
      tools: {
        modules: [],
        sources: [],
        sandbox: fromTypedSandbox({
          execute: () => Promise.resolve({ content: [] }),
        }),
      },
      model: scriptedModel([
        fauxAssistantMessage(fauxToolCall("execute", { code: "poll" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Child still working"),
      ]),
    },
    sqliteOwner(),
    subagents,
  );
  try {
    await host.goal.call("set", {
      objective: "Land parent work",
      expectedRevision: null,
      requestId: "parent-polling",
    });
    await host.reconcile();
    expect(await host.commands()).toBe(1);
    expect((await host.session("garden").read()).attention).toEqual([
      expect.objectContaining({ kind: "goal-waiting" }),
    ]);
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "active" } },
    });
  } finally {
    await host.dispose();
  }
});

it("lets an Agent clear its own stalled goal with a reason; a person's clear records none", async () => {
  const cleared: unknown[] = [];
  const host = await openGoal({
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) => {
          const update = request.bindings.goal?.update_goal;
          if (update === undefined) throw new Error("goal tools are missing");
          const result = await update({
            status: "clear",
            reason: "The lane landed elsewhere",
          });
          cleared.push(result);
          return result;
        },
      }),
    },
    model: scriptedModel([
      ...Array.from({ length: 4 }, () => fauxAssistantMessage("waiting")),
      fauxAssistantMessage(fauxToolCall("execute", { code: "clear" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("cleared"),
      ...Array.from({ length: 4 }, () => fauxAssistantMessage("waiting")),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "First child task",
      expectedRevision: null,
      requestId: "first-child-task",
    });
    await host.drain();
    await Effect.runPromise(
      host.agent.session("garden").send("Clear the paused goal", {
        requestId: "child-clear-command",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(cleared).toEqual([
      {
        objective: "First child task",
        state: "cleared",
        reason: "The lane landed elsewhere",
      },
    ]);
    expect(await host.view()).toMatchObject({
      value: {
        goal: null,
        ended: [{ outcome: "cleared", reason: "The lane landed elsewhere" }],
      },
    });
    // The Session control is the person's command, not the child's model tool.
    await host.goal.call("set", {
      objective: "Second child task",
      expectedRevision: null,
      requestId: "second-child-task",
    });
    await host.drain();
    await expectPausedAttention(
      host,
      "Goal paused: Second child task (Stalled: no progress for 3 turns)",
      "goal-stalled",
    );
    await host.goal.call("clear", {});
    expect(await host.view()).toMatchObject({
      value: {
        goal: null,
        ended: [
          { outcome: "cleared", reason: "The lane landed elsewhere" },
          { outcome: "cleared", reason: null },
        ],
      },
    });
  } finally {
    await host.dispose();
  }
});

it("refuses a model's clear on an active person-set goal", async () => {
  const errors: string[] = [];
  const host = await openGoal({
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) => {
          try {
            await request.bindings.goal?.update_goal?.({
              status: "clear",
              reason: "Giving up",
            });
          } catch (cause) {
            errors.push(cause instanceof Error ? cause.message : String(cause));
          }
          return { content: [] };
        },
      }),
    },
    model: scriptedModel([
      fauxAssistantMessage(fauxToolCall("execute", { code: "clear" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("I cannot clear an active goal"),
      ...Array.from({ length: 3 }, () => fauxAssistantMessage("waiting")),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "Keep tending",
      expectedRevision: null,
      requestId: "live-goal",
    });
    await host.drain();
    expect(errors).toEqual(["Only a paused Session goal can be cleared"]);
    expect(await host.view()).toMatchObject({
      value: { ended: [], goal: { objective: "Keep tending" } },
    });
  } finally {
    await host.dispose();
  }
});

it("keeps a person's pause human-held and distinguishes an absent goal for model updates", async () => {
  const errors: string[] = [];
  const host = await openGoal({
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) => {
          try {
            await request.bindings.goal?.update_goal?.({
              status: "blocked",
              reason: "External blocker",
            });
          } catch (cause) {
            errors.push(cause instanceof Error ? cause.message : String(cause));
          }
          return { content: [] };
        },
      }),
    },
    model: scriptedModel([
      fauxAssistantMessage(fauxToolCall("execute", { code: "block" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Still paused"),
      fauxAssistantMessage(fauxToolCall("execute", { code: "block" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("No goal"),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "Wait",
      expectedRevision: null,
      requestId: "diagnostic-goal",
    });
    await host.goal.call("pause", {});
    await host.drain();
    await host.goal.call("clear", {});
    await Effect.runPromise(
      host.agent.session("garden").send("Check the goal", {
        requestId: "diagnostic-follow-up",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(errors).toEqual([
      "A person paused or stopped this goal; only complete is available to you",
      "No Session goal",
    ]);
  } finally {
    await host.dispose();
  }
});

it("R3 a cleared goal is history, never current, and admits no further work", async () => {
  const host = await openGoal();
  try {
    await host.goal.call("set", {
      objective: "Rest",
      expectedRevision: null,
      requestId: "clear-me",
    });
    const before = Date.now();
    await host.goal.call("clear", {});
    await host.drain();
    const view = await host.view();
    const endedAt =
      view.status === "running" ? view.value?.ended[0]?.endedAt : undefined;
    expect(endedAt).toBeGreaterThanOrEqual(before);
    expect(view).toEqual({
      status: "running",
      value: {
        goal: null,
        ended: [
          {
            sequence: 1,
            objective: "Rest",
            outcome: "cleared",
            reason: null,
            endedAt,
            afterSequence: 0,
          },
        ],
        omitted: 0,
      },
    });
    expect(await host.commands()).toBe(1);
  } finally {
    await host.dispose();
  }
});

it("points at goal tools through a bounded prompt line on every ordinary run", async () => {
  const prompts: string[] = [];
  const faux = fauxModel([]);
  faux.setResponses([fauxAssistantMessage("done")]);
  const host = await openGoal({
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
  });
  try {
    await Effect.runPromise(
      host.agent
        .session("garden")
        .send("hello", { requestId: "guide", delivery: "followUp" }),
    );
    await host.drain();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("forage.describe({path:'goal'})");
    expect(prompts[0]).not.toContain("You may start a goal yourself");
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
    expect(resumed.pauseCause).toMatchObject({ kind: "failed" });
    expect(resumed.pauseCause?.detail).toContain("unavailable");
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

it("R1 Esc pauses the goal: aborted goal work never stays active, and an unrelated message does not restart it", async () => {
  const held = heldModel([fauxAssistantMessage("Pizza sounds good.")]);
  const host = await openGoal({ model: held.model });
  let running: Promise<void> | undefined;
  try {
    await host.goal.call("set", {
      objective: "Tidy the menus",
      expectedRevision: null,
      requestId: "esc-goal",
    });
    running = host.reconcile();
    await expect.poll(held.started).toBe(true);
    await Effect.runPromise(host.agent.session("garden").abort);
    held.release();
    await running;
    await host.drain();
    expect(await host.view()).toMatchObject({
      status: "running",
      value: {
        goal: {
          state: "paused",
          pauseCause: { kind: "cancelled", detail: "Stopped" },
        },
      },
    });
    await Effect.runPromise(
      host.agent.session("garden").send("what should we eat for lunch?", {
        requestId: "lunch",
        delivery: "followUp",
      }),
    );
    await host.drain();
    // The lunch answer settles; the paused goal sends no hidden goal turn.
    expect(await host.commands()).toBe(2);
    expect((await host.session("garden").read()).attention).toEqual([]);
    expect(await host.view()).toMatchObject({
      value: {
        goal: {
          state: "paused",
          pauseCause: { kind: "cancelled", detail: "Stopped" },
        },
      },
    });
  } finally {
    held.release();
    await running;
    await host.dispose();
  }
});

/**
 * The store exactly as committed when the runtime is lost mid goal turn, as a
 * Hub deploy, a Durable Object eviction or a Local service restart leaves it.
 */
async function storeLostMidGoalTurn(directory: string) {
  const path = join(directory, "owner.sqlite");
  const held = heldModel();
  const store = sqliteOwner();
  const first = await openGoal({ model: held.model }, store);
  let running: Promise<void> | undefined;
  try {
    await first.goal.call("set", {
      objective: "Tidy the menus",
      expectedRevision: null,
      requestId: "closed-goal",
    });
    running = first.reconcile();
    await expect.poll(held.started).toBe(true);
    store.copyTo(path);
  } finally {
    await Effect.runPromise(first.agent.session("garden").abort);
    held.release();
    await running;
    await first.dispose();
  }
  return path;
}

it("R1 restart: when the interrupted goal turn auto-resumes, the goal stays live ('Pursuing goal since…')", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goal-restart-"));
  const path = await storeLostMidGoalTurn(directory);
  // The resumed turn finishes; the goal's next turn then waits.
  const next = heldModel([], [fauxAssistantMessage("Resumed the menus.")]);
  const reopened = await openGoal({ model: next.model }, sqliteOwner(path));
  let running: Promise<void> | undefined;
  try {
    running = reopened.drain();
    await expect.poll(next.started).toBe(true);
    expect(await reopened.view()).toMatchObject({
      status: "running",
      value: { goal: { state: "active", pauseCause: null } },
    });
    const snapshot = await reopened.session("garden").read();
    // R6: reopening asks nothing.
    expect(snapshot.attention).toEqual([]);
    // The set prompt resumed, then Goal admitted its next turn.
    expect(await reopened.commands()).toBe(2);
    await reopened.goal.call("pause", {});
  } finally {
    next.release();
    await running;
    await reopened.dispose();
    rmSync(directory, { recursive: true });
  }
});

it("R1 restart: when the interrupted goal turn cannot resume, the goal pauses with a plain reason", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goal-restart-"));
  const path = await storeLostMidGoalTurn(directory);
  const reopened = await openGoal(
    {
      model: {
        acquire: () => Effect.die(new Error("model unavailable after restart")),
      },
    },
    sqliteOwner(path),
  );
  try {
    await reopened.drain();
    expect(await reopened.view()).toMatchObject({
      status: "running",
      value: {
        goal: {
          state: "paused",
          pauseCause: { kind: "failed", detail: "Goal work failed" },
        },
      },
    });
    expect((await reopened.session("garden").read()).attention).toEqual([]);
    expect(await reopened.commands()).toBe(1);
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true });
  }
});

it("R4 a blocked goal pauses with its reason and resumes like any paused goal", async () => {
  const host = await openGoal({
    tools: terminalTools("No access to the release repo"),
    model: scriptedModel([
      fauxAssistantMessage(fauxToolCall("execute", { code: "block" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("I am blocked on repo access."),
      fauxAssistantMessage("Access arrived; continuing."),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "Write the release notes",
      expectedRevision: null,
      requestId: "blocked-goal",
    });
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: {
        goal: {
          state: "paused",
          pauseCause: {
            kind: "blocked",
            detail: "No access to the release repo",
          },
        },
        ended: [],
      },
    });
    await expectPausedAttention(
      host,
      "Goal paused: Write the release notes (No access to the release repo)",
      "goal-blocked",
    );
    expect(await host.goal.call("pause", {})).toMatchObject({
      state: "paused",
      pauseCause: { kind: "person", detail: null },
    });
    expect((await host.session("garden").read()).attention).toEqual([]);
    expect(await host.goal.call("resume", {})).toMatchObject({
      state: "active",
      pauseCause: null,
    });
    expect((await host.session("garden").read()).attention).toEqual([]);
    expect(await host.commands()).toBe(2);
    await host.goal.call("pause", {});
    await host.drain();
  } finally {
    await host.dispose();
  }
});

it("R7 the replace prompt appears only for a live or paused goal, never for a finished one", async () => {
  const host = await openGoal();
  const set = (objective: string, requestId: string) =>
    host.goal.call("goal", { action: "set", objective, requestId });
  try {
    expect(await set("Tidy the menus", "first")).toEqual({ type: "done" });
    expect(await set("Write the release notes", "while-live")).toMatchObject({
      type: "prompt",
      prompt: {
        type: "confirmation",
        message: "Replace the live goal?",
        destructive: true,
        facts: [
          { label: "Current", value: "Tidy the menus" },
          { label: "New", value: "Write the release notes" },
        ],
      },
    });
    await host.goal.call("pause", {});
    expect(await set("Write the release notes", "while-paused")).toMatchObject({
      type: "prompt",
      prompt: {
        type: "confirmation",
        message: "Replace the paused goal?",
        destructive: true,
      },
    });
    // Clearing finishes the goal; the next goal starts without asking.
    expect(await host.goal.call("goal", { action: "clear" })).toEqual({
      type: "done",
    });
    expect(await set("Plan the next sprint", "after-clear")).toEqual({
      type: "done",
    });
    await host.goal.call("pause", {});
    await host.drain();
  } finally {
    await host.dispose();
  }
});

it("R7 an achieved goal never asks to be replaced", async () => {
  const host = await openGoal({
    tools: terminalTools("Menus are tidy"),
    model: scriptedModel([
      fauxAssistantMessage(fauxToolCall("execute", { code: "complete" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The menus are tidy."),
      fauxAssistantMessage("Starting the notes."),
    ]),
  });
  try {
    await host.goal.call("goal", {
      action: "set",
      objective: "Tidy the menus",
      requestId: "achieve",
    });
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: { goal: null, ended: [{ outcome: "achieved" }] },
    });
    expect(
      await host.goal.call("goal", {
        action: "set",
        objective: "Write the release notes",
        requestId: "next",
      }),
    ).toEqual({ type: "done" });
    await host.goal.call("pause", {});
    await host.drain();
  } finally {
    await host.dispose();
  }
});

it("replacing a goal records the old one as cleared history", async () => {
  const host = await openGoal();
  try {
    const first = await host.goal.call("set", {
      objective: "Tidy the menus",
      expectedRevision: null,
      requestId: "old",
    });
    await host.goal.call("set", {
      objective: "Write the release notes",
      expectedRevision: first.goal.revision,
      requestId: "new",
    });
    expect(await host.view()).toMatchObject({
      value: {
        goal: { objective: "Write the release notes", state: "active" },
        ended: [
          { sequence: 1, objective: "Tidy the menus", outcome: "cleared" },
        ],
      },
    });
    await host.goal.call("pause", {});
    await host.drain();
  } finally {
    await host.dispose();
  }
});

it("R1 Esc on a person's turn while the goal waits for it pauses the goal, never 'Pursuing' forever", async () => {
  // The goal's turn settles while the person's message is queued, so Goal
  // waits for the Session to go idle; the person then stops their own turn.
  const held = heldModel([], [fauxAssistantMessage("Goal work done.")]);
  const host = await openGoal({ model: held.model });
  let running: Promise<void> | undefined;
  try {
    await host.goal.call("set", {
      objective: "Tidy the menus",
      expectedRevision: null,
      requestId: "waiting-goal",
    });
    await Effect.runPromise(
      host.agent.session("garden").send("A question of my own", {
        requestId: "person",
        delivery: "followUp",
      }),
    );
    running = host.drain();
    await expect.poll(held.started).toBe(true);
    await Effect.runPromise(host.agent.session("garden").abort);
    held.release();
    await running;
    expect(await host.view()).toMatchObject({
      value: {
        goal: {
          state: "paused",
          pauseCause: { kind: "cancelled", detail: "Stopped" },
        },
      },
    });
    expect(await host.commands()).toBe(2);
  } finally {
    held.release();
    await running;
    await host.dispose();
  }
});

it("R1 a failed turn with no extension origin pauses the goal without assuming a human sender or starting new work", async () => {
  let call = 0;
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage("Goal work done."),
    fauxAssistantMessage("Next goal turn."),
  ]);
  const host = await openGoal({
    model: {
      acquire: () =>
        Effect.suspend(() => {
          call += 1;
          // The person's turn (the second run) cannot reach its model.
          if (call === 2) return Effect.die(new Error("model unavailable"));
          return Effect.succeed({
            retryable: () => false,
            model: faux.model,
            stream: faux.stream,
            release: Effect.void,
          });
        }),
    },
  });
  try {
    await host.goal.call("set", {
      objective: "Tidy the menus",
      expectedRevision: null,
      requestId: "waiting-goal-failed",
    });
    await Effect.runPromise(
      host.agent.session("garden").send("A question of my own", {
        requestId: "person-failed",
        delivery: "followUp",
      }),
    );
    await host.reconcile();
    await host.reconcile();
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: {
        goal: {
          state: "paused",
          pauseCause: { kind: "failed", detail: "The last turn failed" },
        },
      },
    });
    // No goal turn started after the failure.
    expect(await host.commands()).toBe(2);
    expect((await host.session("garden").read()).attention).toEqual([]);
  } finally {
    await host.dispose();
  }
});

it("R1 restart keeps a pending 'complete': the resumed turn finishes and the goal is achieved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goal-restart-"));
  const path = join(directory, "owner.sqlite");
  const held = heldModel(
    [],
    [
      fauxAssistantMessage(fauxToolCall("execute", { code: "complete" }), {
        stopReason: "toolUse",
      }),
    ],
  );
  const store = sqliteOwner();
  const first = await openGoal(
    { tools: terminalTools("Menus are tidy"), model: held.model },
    store,
  );
  let running: Promise<void> | undefined;
  try {
    await first.goal.call("set", {
      objective: "Tidy the menus",
      expectedRevision: null,
      requestId: "pending-complete",
    });
    running = first.reconcile();
    // The model already asked to complete; its final reply is in flight.
    await expect.poll(held.started).toBe(true);
    store.copyTo(path);
  } finally {
    await Effect.runPromise(first.agent.session("garden").abort);
    held.release();
    await running;
    await first.dispose();
  }
  const reopened = await openGoal(
    {
      tools: terminalTools("Menus are tidy"),
      model: scriptedModel([fauxAssistantMessage("The menus are tidy.")]),
    },
    sqliteOwner(path),
  );
  try {
    await reopened.drain();
    expect(await reopened.view()).toMatchObject({
      value: {
        goal: null,
        ended: [
          {
            objective: "Tidy the menus",
            outcome: "achieved",
            reason: "Menus are tidy",
          },
        ],
      },
    });
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true });
  }
});

it("R1 restart: the resumed turn may still report the goal complete", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goal-restart-"));
  const path = await storeLostMidGoalTurn(directory);
  const reopened = await openGoal(
    {
      tools: terminalTools("Menus are tidy"),
      model: scriptedModel([
        fauxAssistantMessage(fauxToolCall("execute", { code: "complete" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("The menus are tidy."),
      ]),
    },
    sqliteOwner(path),
  );
  try {
    await reopened.drain();
    expect(await reopened.view()).toMatchObject({
      value: {
        goal: null,
        ended: [{ outcome: "achieved", reason: "Menus are tidy" }],
      },
    });
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true });
  }
});

it("the menu's Clear asks first and Keep leaves the goal in place", async () => {
  const host = await openGoal();
  try {
    await host.goal.call("goal", {
      action: "set",
      objective: "Tidy the menus",
      requestId: "first",
    });
    await host.goal.call("pause", {});
    expect(await host.goal.call("goal", { action: "clear-ask" })).toMatchObject(
      {
        type: "prompt",
        prompt: { type: "confirmation", destructive: true },
      },
    );
    expect(
      await host.goal.call("goal", { action: "clear", confirmed: false }),
    ).toMatchObject({ type: "done" });
    expect(await host.view()).toMatchObject({
      value: {
        goal: { objective: "Tidy the menus", state: "paused" },
        ended: [],
      },
    });
    expect(
      await host.goal.call("goal", { action: "clear", confirmed: true }),
    ).toEqual({ type: "done" });
    expect(await host.view()).toMatchObject({ value: { goal: null } });
  } finally {
    await host.dispose();
  }
});

it("the menu's Replace asks for the new goal and then asks a destructive confirmation", async () => {
  const host = await openGoal();
  try {
    await host.goal.call("goal", {
      action: "set",
      objective: "Tidy the menus",
      requestId: "first",
    });
    await host.goal.call("pause", {});
    const objective = await host.goal.call("goal", { action: "replace" });
    expect(objective).toMatchObject({
      type: "prompt",
      prompt: { type: "text" },
      next: { answer: "objective" },
    });
    if (objective.type !== "prompt") throw new Error("expected a prompt");
    expect(objective.next.arguments).not.toHaveProperty("confirmed");
    expect(
      await host.goal.call("goal", {
        ...objective.next.arguments,
        objective: "Write the release notes",
      }),
    ).toMatchObject({
      type: "prompt",
      prompt: {
        type: "confirmation",
        message: "Replace the paused goal?",
        destructive: true,
      },
      next: { answer: "confirmed" },
    });
    expect(await host.view()).toMatchObject({
      value: { goal: { objective: "Tidy the menus", state: "paused" } },
    });
  } finally {
    await host.dispose();
  }
});

/** A sandbox that runs each `execute` code as one goal tool call. */
function goalCaller(
  script: Readonly<Record<string, readonly [string, GoalToolInput]>>,
  results: unknown[] = [],
) {
  return {
    modules: [],
    sources: [],
    sandbox: fromTypedSandbox({
      execute: async (request: SandboxRequest) => {
        const step = script[request.code];
        const goal = request.bindings.goal;
        if (step === undefined || goal === undefined)
          throw new Error("goal tools are missing");
        const operation = goal[step[0]];
        if (operation === undefined) throw new Error(`missing ${step[0]}`);
        const result = await operation(step[1]);
        results.push(result);
        return result;
      },
    }),
  };
}

const callExecute = (code: string) =>
  fauxAssistantMessage(fauxToolCall("execute", { code }), {
    stopReason: "toolUse",
  });

const idleChild = (live: () => boolean): SubagentSource => ({
  hasLiveChildCommand: live,
  read: () => Promise.resolve({ agents: [], more: 0 }),
  open: () => Promise.reject(new Error("No child read belongs in settlement")),
});

it("goal.wait suppresses continuation and stall until another run settles", async () => {
  const results: unknown[] = [];
  const host = await openGoal({
    tools: goalCaller(
      {
        wait: ["wait", { reason: "train 682", fallbackMinutes: 20 }],
      },
      results,
    ),
    model: scriptedModel([
      callExecute("wait"),
      fauxAssistantMessage("Waiting on the train"),
      fauxAssistantMessage("A reply arrived"),
      callExecute("wait"),
      fauxAssistantMessage("Still waiting"),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "Land the train",
      expectedRevision: null,
      requestId: "wait-goal",
    });
    await host.drain();
    expect(results).toEqual([
      {
        objective: "Land the train",
        state: "active",
        reason: "train 682",
        fallbackMinutes: 20,
      },
    ]);
    // One turn, no goal continuation, no stall, and the reason is shown.
    expect(await host.commands()).toBe(1);
    expect((await host.session("garden").read()).attention).toEqual([
      expect.objectContaining({
        kind: "goal-waiting",
        summary: "Waiting: train 682",
      }),
    ]);
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "active", pauseCause: null } },
    });
    // The next settled run (a reply, a person) wakes it: exactly one goal turn.
    await Effect.runPromise(
      host.agent.session("garden").send("The train landed", {
        requestId: "reply-1",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(await host.commands()).toBe(3);
    expect((await host.session("garden").read()).attention).toEqual([
      expect.objectContaining({ kind: "goal-waiting" }),
    ]);
  } finally {
    await host.dispose();
  }
});

it("the fallback timer admits one goal turn", async () => {
  const startAt = Date.parse("2026-10-27T12:00:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startAt);
  const host = await openGoal({
    tools: goalCaller({
      wait: ["wait", { reason: "main", fallbackMinutes: 5 }],
    }),
    model: scriptedModel([
      callExecute("wait"),
      fauxAssistantMessage("Waiting on main"),
      callExecute("wait"),
      fauxAssistantMessage("Checked main, waiting again"),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "Land main",
      expectedRevision: null,
      requestId: "fallback-goal",
    });
    await host.drain();
    expect(await host.commands()).toBe(1);
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: startAt + 5 * 60_000,
    });
    vi.setSystemTime(startAt + 4 * 60_000);
    await host.drain();
    expect(await host.commands()).toBe(1);
    vi.setSystemTime(startAt + 5 * 60_000);
    await host.drain();
    expect(await host.commands()).toBe(2);
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "active" } },
    });
  } finally {
    await host.dispose();
    vi.useRealTimers();
  }
});

it("an open question keeps the goal waiting, not stalled", async () => {
  const asker = defineExtension({
    id: ExtensionId.make("test-asker"),
    version: "1.0.0",
  })
    .state({ version: 1, migrations: {}, collections: {} })
    .define({
      attention: true,
      commands: {
        specs: {
          ask: {
            scope: "session",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
          },
        },
        handlers: (ctx) => ({
          ask: ({ sessionId }: { sessionId: string }) =>
            ctx.attention
              .set(sessionId, {
                id: "q",
                kind: "question",
                summary: "Which branch?",
                since: 1,
              })
              .pipe(Effect.as({})),
        }),
      },
    });
  const host = await openAgent(
    sqliteOwner().owner,
    grantAll([goalExtension, asker]),
  );
  try {
    const session = host.session("garden");
    await bindSessionExtension(session, goalContract).call("set", {
      objective: "Needs an answer",
      expectedRevision: null,
      requestId: "ask-goal",
    });
    await session.extension(asker.manifest.id).call("ask", {});
    await host.drain();
    // Three tool-free goal turns would have stalled it; one waiting turn runs.
    const read = await session.read();
    expect(
      read.messages.filter(({ value }) => value.role === "user"),
    ).toHaveLength(1);
    expect(read.attention.map(({ kind }) => kind).sort()).toEqual([
      "goal-waiting",
      "question",
    ]);
  } finally {
    await host.close();
  }
});

it("twenty settled replies admit at most one goal turn each", async () => {
  const subagents = idleChild(() => true);
  const host = await openGoal({}, sqliteOwner(), subagents);
  try {
    await host.goal.call("set", {
      objective: "Review eight children",
      expectedRevision: null,
      requestId: "spam-goal",
    });
    await host.drain();
    let before = await host.commands();
    for (let reply = 0; reply < 20; reply += 1) {
      await Effect.runPromise(
        host.agent.session("garden").send(`Reply ${String(reply)}`, {
          requestId: `reply-${String(reply)}`,
          delivery: "followUp",
        }),
      );
      await host.drain();
      const after = await host.commands();
      // Session reads keep a bounded window; count while it still grows.
      if (after < 33) expect(after - before).toBe(2);
      before = after;
    }
    // Twenty replies never stalled or paused the goal.
    expect(await host.view()).toMatchObject({
      value: { goal: { state: "active" } },
    });
  } finally {
    await host.dispose();
  }
});

it("create after complete in one run replaces the goal at settlement", async () => {
  const results: unknown[] = [];
  const host = await openGoal({
    tools: goalCaller(
      {
        done: ["update_goal", { status: "complete", reason: "Lane landed" }],
        next: ["create_goal", { objective: "Second lane" }],
        wait: ["wait", { reason: "second lane builds" }],
      },
      results,
    ),
    model: scriptedModel([
      callExecute("done"),
      callExecute("next"),
      fauxAssistantMessage("Retired and replaced"),
      callExecute("wait"),
      fauxAssistantMessage("Second lane under way"),
    ]),
  });
  try {
    await host.goal.call("set", {
      objective: "First lane",
      expectedRevision: null,
      requestId: "retire-goal",
    });
    await host.drain();
    expect(results.slice(0, 2)).toEqual([
      { objective: "First lane", state: "complete", reason: "Lane landed" },
      { objective: "Second lane", state: "active" },
    ]);
    expect(await host.view()).toMatchObject({
      value: {
        goal: { objective: "Second lane", state: "active" },
        ended: [
          {
            objective: "First lane",
            outcome: "achieved",
            reason: "Lane landed",
          },
        ],
      },
    });
    // The replacement takes over: its first goal turn was admitted.
    expect(await host.commands()).toBeGreaterThanOrEqual(2);
  } finally {
    await host.dispose();
  }
});

it("a goal that adopts already-settled work starts its first goal turn, once", async () => {
  const host = await openGoal();
  try {
    const sent = await Effect.runPromise(
      host.agent.session("garden").send("Build the fern lane", {
        requestId: "lane",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(await host.commands()).toBe(1);
    const adopt = {
      objective: "Build the fern lane",
      expectedRevision: null,
      requestId: "lane-goal",
      adoptCommandId: sent.commandId,
    };
    const first = await host.goal.call("set", adopt);
    expect(first.accepted.commandId).toBe(sent.commandId);
    // The objective is not admitted again; one goal turn starts instead.
    const read = await host.session("garden").read();
    expect(read.pending.prompts.map(({ text }) => text)).toEqual([
      "Goal turn · Build the fern lane",
    ]);
    // A retry replays: no second goal turn.
    expect(await host.goal.call("set", adopt)).toEqual(first);
    expect(await host.commands()).toBe(2);
  } finally {
    await host.dispose();
  }
});
