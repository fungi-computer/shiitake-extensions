import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SandboxRequest } from "@fungi.computer/mycelium";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import type { ShiitakeEffectOptions } from "@fungi.computer/shiitake/effect";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";

import { goalContract } from "../src/goal/contract.js";
import { goalExtension } from "../src/goal/host.js";
import { loopContract } from "../src/loop/contract.js";
import { loopExtension } from "../src/loop/host.js";
import { grantAll, openAgent, sqliteOwner } from "./fixtures/host.js";

afterEach(() => {
  vi.useRealTimers();
});

type FauxResponse = Parameters<
  ReturnType<typeof fauxModel>["setResponses"]
>[0][number];

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

const scheduleCall = fauxAssistantMessage(
  fauxToolCall("execute", { code: "schedule" }),
  { stopReason: "toolUse" },
);

/** A sandbox whose `schedule` program calls loop.schedule_next once. */
function scheduleTools(
  beforeReturn: () => Promise<void> = () => Promise.resolve(),
) {
  return {
    modules: [],
    sources: [],
    sandbox: fromTypedSandbox({
      execute: async (request: SandboxRequest) => {
        const scheduleNext = request.bindings.loop?.schedule_next;
        if (scheduleNext === undefined)
          throw new Error("loop tools are missing");
        const result = await scheduleNext({
          delaySeconds: 10,
          reason: "check the kiln",
        });
        await beforeReturn();
        return result;
      },
    }),
  };
}

async function openLoop(
  overrides: Parameters<typeof openAgent>[2] = {},
  roster = grantAll([loopExtension]),
  store = sqliteOwner(),
) {
  const host = await openAgent(store.owner, roster, overrides);
  const session = host.session("kiln");
  const loop = bindSessionExtension(session, loopContract);
  const userPrompts = async () =>
    (await session.read()).messages.filter(({ value }) => value.role === "user")
      .length;
  return {
    ...host,
    store,
    loop,
    userPrompts,
    view: async () => loop.view(await session.read()),
    dispose: async () => {
      await host.close();
      store.close();
    },
  };
}

it("paces a self-paced loop by the model's clamped request and ends when it stops asking", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  const host = await openLoop({
    tools: scheduleTools(),
    model: scriptedModel([
      scheduleCall,
      fauxAssistantMessage("scheduled"),
      fauxAssistantMessage("the kiln is cool; done"),
    ]),
  });
  try {
    const started = await host.loop.call("startSelfPaced", {
      prompt: "Check the kiln",
      requestId: "kiln-1",
    });
    await expect(
      host.loop.call("startSelfPaced", {
        prompt: "Check the kiln",
        requestId: "kiln-1",
      }),
    ).resolves.toEqual(started);
    await expect(
      host.loop.call("startSelfPaced", {
        prompt: "Something else",
        requestId: "kiln-2",
      }),
    ).rejects.toMatchObject({ boundary: "store", cause: "conflict" });

    await host.drain();
    const due = Date.parse("2026-09-26T12:01:00Z");
    expect(await host.view()).toMatchObject({
      status: "running",
      value: {
        loop: { state: "active", reason: "check the kiln", nextDueAt: due },
      },
    });
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: due,
    });

    vi.setSystemTime(new Date(due));
    await host.drain();
    expect(await host.userPrompts()).toBe(2);
    expect(await host.view()).toMatchObject({
      value: {
        loop: { state: "finished", nextDueAt: null },
        history: {
          nextSequence: 3,
          omitted: 0,
          events: [
            { id: "1", sequence: 1, event: { state: "active" } },
            {
              id: "2",
              sequence: 2,
              event: { state: "finished" },
            },
          ],
        },
      },
    });
    const committed = await host.view();
    if (committed.status !== "running" || committed.value === null)
      throw new Error("Finished Loop projection unavailable");
    const workIds = new Set(
      (await host.session("kiln").read()).messages.map(
        ({ commandId }) => commandId,
      ),
    );
    expect(
      committed.value.history.events
        .filter(({ event }) => event.state === "finished")
        .every(({ commandId }) => commandId !== null && workIds.has(commandId)),
    ).toBe(true);
    await host.drain();
    expect(await host.view()).toEqual(committed);
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
  } finally {
    await host.dispose();
  }
});

it("retains the last 32 real loop transitions and their counter across reopening", async () => {
  const host = await openLoop();
  try {
    for (let index = 0; index < 18; index++) {
      await host.loop.call("startSelfPaced", {
        prompt: "Check the kiln",
        requestId: `retention-${String(index)}`,
      });
      await host.loop.call("stop", {});
    }
    const committed = await host.view();
    if (committed.status !== "running" || committed.value === null)
      throw new Error("Loop projection unavailable");
    expect(committed.value.history).toMatchObject({
      nextSequence: 37,
      omitted: 4,
    });
    expect(committed.value.history.events).toHaveLength(32);
    expect(committed.value.history.events[0]).toMatchObject({
      id: "5",
      sequence: 5,
    });
    expect(committed.value.history.events.at(-1)).toMatchObject({
      id: "36",
      sequence: 36,
      event: { state: "cancelled" },
    });
    await host.close();
    const reopened = await openLoop({}, grantAll([loopExtension]), host.store);
    try {
      expect(await reopened.view()).toEqual(committed);
    } finally {
      await reopened.close();
    }
  } finally {
    await host.dispose();
  }
});

it("keeps a request made before a mid-run pause and arms it only on resume", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  let pause = () => Promise.resolve();
  const host = await openLoop({
    tools: scheduleTools(() => pause()),
    model: scriptedModel([scheduleCall, fauxAssistantMessage("scheduled")]),
  });
  pause = async () => {
    await host.loop.call("pause", {});
  };
  try {
    await host.loop.call("startSelfPaced", {
      prompt: "Check the kiln",
      requestId: "kiln-1",
    });
    await host.drain();
    const due = Date.parse("2026-09-26T12:01:00Z");
    expect(await host.view()).toMatchObject({
      value: { loop: { state: "paused", nextDueAt: due } },
    });
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
    await expect(host.loop.call("resume", {})).resolves.toMatchObject({
      state: "active",
      nextDueAt: due,
    });
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: due,
    });
  } finally {
    await host.dispose();
  }
});

it("runs a fixed interval loop on its cron cadence and coalesces missed occurrences", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T12:00:30Z"));
  const host = await openLoop();
  try {
    const started = await host.loop.call("startFixedInterval", {
      prompt: "Walk the rows",
      requestId: "rows",
      expression: "0 * * * *",
      timeZone: "UTC",
    });
    expect(started.loop).toMatchObject({
      mode: "fixed_interval",
      nextDueAt: Date.parse("2026-09-26T13:00:00Z"),
    });
    await host.drain();
    expect(await host.userPrompts()).toBe(1);

    vi.setSystemTime(new Date("2026-09-26T15:10:00Z"));
    await host.drain();
    expect(await host.userPrompts()).toBe(2);
    expect(await host.view()).toMatchObject({
      value: {
        loop: {
          state: "active",
          nextDueAt: Date.parse("2026-09-26T16:00:00Z"),
        },
      },
    });

    await host.loop.call("pause", {});
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
    vi.setSystemTime(new Date("2026-09-26T18:30:00Z"));
    await expect(host.loop.call("resume", {})).resolves.toMatchObject({
      nextDueAt: Date.parse("2026-09-26T19:00:00Z"),
    });
    await expect(host.loop.call("stop", {})).resolves.toMatchObject({
      state: "cancelled",
      nextDueAt: null,
    });
    await expect(host.loop.call("stop", {})).rejects.toMatchObject({
      boundary: "store",
      cause: "conflict",
    });
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
  } finally {
    await host.dispose();
  }
});

it("fails the loop visibly when its work fails", async () => {
  const host = await openLoop({
    model: {
      acquire: () => Effect.die(new Error("model unavailable")),
    },
  });
  try {
    await host.loop.call("startSelfPaced", {
      prompt: "Check the kiln",
      requestId: "kiln-1",
    });
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: {
        loop: {
          state: "failed",
          lastError: "Loop work ended with outcome failed.",
        },
      },
    });
  } finally {
    await host.dispose();
  }
});

it("offers model loop control in an ordinary run and stops from a foreign-to-loop run", async () => {
  const results: unknown[] = [];
  const host = await openLoop({
    model: scriptedModel([
      fauxAssistantMessage(fauxToolCall("execute", { code: "start" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("started"),
      fauxAssistantMessage(fauxToolCall("execute", { code: "schedule" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("waiting"),
      fauxAssistantMessage(fauxToolCall("execute", { code: "stop" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("stopped"),
    ]),
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request) => {
          const tools = request.bindings.loop;
          if (tools === undefined)
            throw new Error("Missing loop module in normal run");
          const operation =
            tools[
              request.code === "start"
                ? "start"
                : request.code === "schedule"
                  ? "schedule_next"
                  : "stop"
            ];
          if (operation === undefined)
            throw new Error("Missing loop operation");
          const result = await operation(
            request.code === "start"
              ? { prompt: "Check later", cadence: { kind: "self_paced" } }
              : request.code === "schedule"
                ? { delaySeconds: 60, reason: "Waiting" }
                : { reason: "All checked" },
          );
          results.push(result);
          return result;
        },
      }),
    },
  });
  try {
    await Effect.runPromise(
      host.agent
        .session("kiln")
        .send("start one", { requestId: "model-start", delivery: "followUp" }),
    );
    await host.drain();
    expect(results[0]).toMatchObject({ state: "active", origin: "model" });
    expect(results[1]).toMatchObject({ delaySeconds: 60 });
    expect(await host.view()).toMatchObject({
      value: { loop: { state: "active" } },
    });
    await Effect.runPromise(
      host.agent
        .session("kiln")
        .send("stop now", { requestId: "foreign-stop", delivery: "followUp" }),
    );
    await host.drain();
    expect(results[2]).toMatchObject({
      state: "finished",
      reason: "All checked",
      lastError: null,
    });
    expect((await host.pendingWork()).nextWakeAt).toBeNull();
  } finally {
    await host.dispose();
  }
});

it("expires fixed interval loops without admitting a late occurrence", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.parse("2026-10-06T12:00:00Z");
  vi.setSystemTime(now);
  const host = await openLoop();
  try {
    await host.loop.call("startFixedInterval", {
      prompt: "Check",
      requestId: "expiry",
      expression: "0 * * * *",
      timeZone: "UTC",
    });
    await host.drain();
    vi.setSystemTime(now + 7 * 24 * 60 * 60 * 1000);
    await host.drain();
    expect(await host.userPrompts()).toBe(1);
    expect(await host.view()).toMatchObject({
      value: {
        loop: {
          state: "finished",
          reason: "fixed interval expired after 7 days",
        },
      },
    });
  } finally {
    await host.dispose();
  }
});

it.each([
  ["goal first", [goalExtension, loopExtension]],
  ["loop first", [loopExtension, goalExtension]],
] as const)(
  "runs goal and loop together with the roster in either order (%s)",
  async (_order, roster) => {
    const host = await openLoop({}, grantAll(roster));
    try {
      const goal = bindSessionExtension(host.session("kiln"), goalContract);
      await goal.call("set", {
        objective: "Fire the pots",
        expectedRevision: null,
        requestId: "pots",
      });
      await host.loop.call("startFixedInterval", {
        prompt: "Check the kiln",
        requestId: "kiln-rows",
        expression: "0 * * * *",
        timeZone: "UTC",
      });
      // The goal set before the loop still continues. Its idle-only
      // continuation waits for the loop's queued first prompt to finish.
      await host.reconcile();
      await host.reconcile();
      await host.reconcile();
      const snapshot = await host.session("kiln").read();
      expect(goal.view(snapshot)).toMatchObject({
        status: "running",
        value: { goal: { state: "active" } },
      });
      expect(host.loop.view(snapshot)).toMatchObject({
        status: "running",
        value: { loop: { state: "active" } },
      });
      expect(
        snapshot.messages
          .map(({ value }) => value)
          .filter((value) => value.role === "user")
          .map(({ content }) => content),
      ).toEqual([
        "Fire the pots",
        "Check the kiln",
        "Goal turn · Fire the pots",
      ]);
      await goal.call("pause", {});
      await host.loop.call("stop", {});
    } finally {
      await host.dispose();
    }
  },
);

it("fails a due loop occurrence without recreating its deleted Session", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T16:00:00Z"));
  const host = await openLoop();
  try {
    await host.loop.call("startFixedInterval", {
      prompt: "Check the kiln",
      requestId: "deleted-loop",
      expression: "* * * * *",
      timeZone: "UTC",
    });
    await host.drain();
    expect(await Effect.runPromise(host.agent.deleteSession("kiln"))).toBe(
      true,
    );
    vi.setSystemTime(new Date("2026-10-08T16:01:00Z"));
    await host.drain();
    expect(
      (await Effect.runPromise(host.agent.listSessions())).sessions,
    ).toEqual([]);
    const failed = await host.view();
    expect(failed).toMatchObject({
      status: "running",
      value: {
        loop: { state: "failed", nextDueAt: null },
      },
    });
    if (failed.status !== "running") throw new Error("Loop extension stopped");
    expect(failed.value?.loop?.lastError).toContain("unavailable");
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
  } finally {
    await host.dispose();
  }
});
