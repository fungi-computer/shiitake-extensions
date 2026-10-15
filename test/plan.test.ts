import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { PlanInput, planContract, type Plan } from "../src/plan/contract.js";
import planClient from "../src/plan/client.js";
import { planExtension } from "../src/plan/host.js";
import { grantAll, openAgent, sqliteOwner } from "./fixtures/host.js";

type Session = ReturnType<Awaited<ReturnType<typeof openAgent>>["session"]>;
const viewPlan = async (session: Session) =>
  bindSessionExtension(session, planContract).view(await session.read());
/** The footer rows every host renders from the observed slot. */
const footer = async (session: Session) =>
  planClient.contribute?.((await session.read()).extensions[planContract.id])
    .panel;

it("rejects multiple in-progress steps and unbounded checklists", () => {
  const decode = Schema.decodeUnknownSync(PlanInput);
  expect(() =>
    decode({
      steps: [
        { step: "one", status: "in_progress" },
        { step: "two", status: "in_progress" },
      ],
    }),
  ).toThrow();
  expect(() =>
    decode({
      steps: Array.from({ length: 51 }, () => ({
        step: "too much",
        status: "pending",
      })),
    }),
  ).toThrow();
});

it("replaces the Session plan through its run tool and projects the latest checklist", async () => {
  const store = sqliteOwner();
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("execute", { code: "first" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("execute", { code: "second" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("execute", { code: "second" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const results: unknown[] = [];
  const host = await openAgent(store.owner, grantAll([planExtension]), {
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
          const update = request.bindings.plan?.update_plan;
          if (update === undefined) throw new Error("Missing plan tool");
          const result = await update({
            steps:
              request.code === "first"
                ? [
                    { step: "Ship it", status: "in_progress" },
                    { step: "Check it", status: "pending" },
                  ]
                : [{ step: "Shipped", status: "completed" }],
          });
          results.push(result);
          return result;
        },
      }),
    },
  });
  try {
    await expect(
      bindSessionExtension(host.session("fern"), planContract).call("plan", {}),
    ).resolves.toEqual({
      type: "done",
      notice: { type: "info", message: "This Session has no plan." },
    });
    await Effect.runPromise(
      host.agent
        .session("fern")
        .send("plan", { requestId: "p1", delivery: "followUp" }),
    );
    await host.drain();
    expect(results).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 1 },
      { completed: 1, total: 1 },
    ]);
    const session = host.session("fern");
    // A finished plan leaves the footer; its checklist and history stay readable.
    await expect(
      bindSessionExtension(session, planContract).call("plan", {}),
    ).resolves.toEqual({
      type: "done",
      notice: { type: "info", message: "Plan complete: 1/1 steps." },
    });
    const view = bindSessionExtension(session, planContract).view(
      await session.read(),
    );
    expect(await footer(session)).toEqual([]);
    expect(view).toMatchObject({
      status: "running",
      value: { plan: { steps: [{ step: "Shipped", status: "completed" }] } },
    });
    if (view.status !== "running" || view.value === null)
      throw new Error("Plan projection did not open");
    expect(
      view.value.history.events.map(({ id, sequence }) => [id, sequence]),
    ).toEqual([
      ["1", 1],
      ["2", 2],
    ]);
    const commands = new Set(
      (await session.read()).messages.map(({ commandId }) => commandId),
    );
    expect(
      view.value.history.events.every(
        ({ commandId }) => commandId !== null && commands.has(commandId),
      ),
    ).toBe(true);
    const committedHistory = view.value.history;
    await host.close();
    const reopened = await openAgent(store.owner, grantAll([planExtension]));
    try {
      const reopenedView = bindSessionExtension(
        reopened.session("fern"),
        planContract,
      ).view(await reopened.session("fern").read());
      expect(reopenedView).toMatchObject({
        status: "running",
        value: { history: committedHistory },
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await host.close();
    store.close();
  }
});

it("lets the Agent and the human clear a plan through one owner, keeping its history across replay", async () => {
  const store = sqliteOwner();
  const faux = fauxModel([]);
  const call = (code: string) =>
    fauxAssistantMessage(fauxToolCall("execute", { code }), {
      stopReason: "toolUse",
    });
  faux.setResponses([
    call("set"),
    call("clear"),
    call("clear"),
    fauxAssistantMessage("cleared"),
    call("set"),
    fauxAssistantMessage("planned"),
  ]);
  const plan: Plan = {
    steps: [
      { step: "Trace the owner", status: "in_progress" },
      { step: "Ship it", status: "pending" },
    ],
  };
  const results: unknown[] = [];
  const host = await openAgent(store.owner, grantAll([planExtension]), {
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
          const update = request.bindings.plan?.update_plan;
          if (update === undefined) throw new Error("Missing plan tool");
          const result = await update(
            request.code === "set" ? plan : { steps: [] },
          );
          results.push(result);
          return result;
        },
      }),
    },
  });
  try {
    // The Agent clears with the same replace operation it plans with.
    await Effect.runPromise(
      host.agent
        .session("fern")
        .send("plan, then clear", { requestId: "a1", delivery: "followUp" }),
    );
    await host.drain();
    expect(results).toEqual([
      { completed: 0, total: 2 },
      { completed: 0, total: 0 },
      { completed: 0, total: 0 },
    ]);
    const fern = host.session("fern");
    const agentCleared = await viewPlan(fern);
    expect(agentCleared).toMatchObject({
      status: "running",
      value: { plan: { steps: [] } },
    });
    if (agentCleared.status !== "running" || agentCleared.value === null)
      throw new Error("Plan projection did not open");
    // A repeated clear is one replacement; history keeps the plan it cleared.
    expect(agentCleared.value.history.events.map(({ event }) => event)).toEqual(
      [plan, { steps: [] }],
    );
    expect(await footer(fern)).toEqual([]);
    for (const input of [{}, { action: "clear" as const }])
      await expect(
        bindSessionExtension(fern, planContract).call("plan", input),
      ).resolves.toEqual({
        type: "done",
        notice: { type: "info", message: "This Session has no plan." },
      });

    // The human clears an open plan from the same owner.
    await Effect.runPromise(
      host.agent
        .session("moss")
        .send("plan", { requestId: "h1", delivery: "followUp" }),
    );
    await host.drain();
    const moss = host.session("moss");
    expect(await footer(moss)).toMatchObject([
      {
        id: "plan",
        title: "Trace the owner",
        actions: [
          { id: "plan", label: "Clear plan", input: { action: "clear" } },
        ],
      },
    ]);
    await expect(
      bindSessionExtension(moss, planContract).call("plan", {
        action: "clear",
      }),
    ).resolves.toEqual({
      type: "done",
      notice: { type: "success", message: "Plan cleared." },
    });
    const humanCleared = await viewPlan(moss);
    expect(await footer(moss)).toEqual([]);
    if (humanCleared.status !== "running" || humanCleared.value === null)
      throw new Error("Plan projection did not open");
    expect(humanCleared.value.plan).toEqual({ steps: [] });
    expect(
      humanCleared.value.history.events.map(({ commandId, event }) => [
        commandId === null,
        event,
      ]),
    ).toEqual([
      [false, plan],
      [true, { steps: [] }],
    ]);
    const committed = humanCleared.value.history;
    await host.close();
    const reopened = await openAgent(store.owner, grantAll([planExtension]));
    try {
      const replayed = await viewPlan(reopened.session("moss"));
      expect(replayed).toMatchObject({
        status: "running",
        value: { plan: { steps: [] }, history: committed },
      });
      expect(await footer(reopened.session("moss"))).toEqual([]);
    } finally {
      await reopened.close();
    }
  } finally {
    await host.close();
    store.close();
  }
});
