import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type SandboxRequest } from "@fungi.computer/mycelium";
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
        retryable: () => false,
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
      },
    });
    const committed = await host.view();
    if (committed.status !== "running" || committed.value === null)
      throw new Error("Finished Loop projection unavailable");
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

it("keeps a failed tick active and exposes its retry time and reason", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startAt = Date.parse("2026-10-08T16:00:00Z");
  vi.setSystemTime(startAt);
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
    const firstFailure = await host.view();
    expect(firstFailure).toMatchObject({
      value: {
        loop: {
          state: "active",
          consecutiveFailures: 1,
          nextDueAt: startAt + 30_000,
        },
      },
    });
    if (firstFailure.status !== "running" || firstFailure.value === null)
      throw new Error("Retry state unavailable");
    expect(firstFailure.value.loop.lastError).toBe(
      "Loop work ended with outcome failed.",
    );
  } finally {
    await host.dispose();
  }
});

it("keeps a failed tick paused and resumes at its recorded retry time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startAt = Date.parse("2026-10-08T16:00:00Z");
  vi.setSystemTime(startAt);
  let pause = () => Promise.resolve();
  let pauseOnce = true;
  const host = await openLoop({
    tools: scheduleTools(() => pause()),
    model: scriptedModel([
      scheduleCall,
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "busy" }),
      scheduleCall,
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "busy" }),
    ]),
  });
  pause = async () => {
    if (!pauseOnce) return;
    pauseOnce = false;
    await host.loop.call("pause", {});
  };
  try {
    await host.loop.call("startSelfPaced", {
      prompt: "Check the kiln",
      requestId: "paused-retry",
    });
    await host.drain();
    const dueAt = startAt + 30_000;
    expect(await host.view()).toMatchObject({
      value: {
        loop: {
          state: "paused",
          consecutiveFailures: 1,
          nextDueAt: dueAt,
        },
      },
    });
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });

    await expect(host.loop.call("resume", {})).resolves.toMatchObject({
      state: "active",
      nextDueAt: dueAt,
    });
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: dueAt,
    });
    vi.setSystemTime(dueAt);
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: { loop: { state: "active", consecutiveFailures: 2 } },
    });
  } finally {
    await host.dispose();
  }
});

it("preserves a fixed-interval retry deadline across pause and resume", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startAt = Date.parse("2026-10-08T15:59:30Z");
  vi.setSystemTime(startAt);
  const host = await openLoop({
    model: scriptedModel([
      fauxAssistantMessage("initial occurrence"),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "busy" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "busy" }),
    ]),
  });
  try {
    await host.loop.call("startFixedInterval", {
      prompt: "Walk the rows",
      requestId: "fixed-retry",
      expression: "0 * * * *",
      timeZone: "UTC",
    });
    await host.drain();
    const retryAt = Date.parse("2026-10-08T16:00:30Z");
    vi.setSystemTime(Date.parse("2026-10-08T16:00:00Z"));
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: { loop: { nextDueAt: retryAt, consecutiveFailures: 1 } },
    });

    await host.loop.call("pause", {});
    vi.setSystemTime(Date.parse("2026-10-08T16:00:10Z"));
    await expect(host.loop.call("resume", {})).resolves.toMatchObject({
      nextDueAt: retryAt,
    });
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: retryAt,
    });
    vi.setSystemTime(retryAt);
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: { loop: { nextDueAt: retryAt + 60_000, consecutiveFailures: 2 } },
    });
  } finally {
    await host.dispose();
  }
});

it("surfaces the stale schedule guard from an ordinary run after loop failure", async () => {
  let observedResult: unknown;
  const recoveryModel = scriptedModel([
    scheduleCall,
    (context) => {
      observedResult = context.messages.find(
        (message) => message.role === "toolResult",
      );
      return fauxAssistantMessage("stale request observed");
    },
  ]);
  const host = await openLoop({
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) => {
          const scheduleNext = request.bindings.loop?.schedule_next;
          if (scheduleNext === undefined)
            throw new Error("loop tools are missing");
          return await scheduleNext({
            delaySeconds: 60,
            reason: "check the kiln",
          });
        },
      }),
    },
    model: {
      acquire: (() => {
        let acquisitions = 0;
        return () => {
          acquisitions += 1;
          return acquisitions === 1
            ? Effect.die(new Error("model unavailable"))
            : recoveryModel.acquire({ sessionId: "kiln", preference: null });
        };
      })(),
    },
  });
  try {
    await host.loop.call("startSelfPaced", {
      prompt: "Check the kiln",
      requestId: "failed-loop",
    });
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: { loop: { state: "active", consecutiveFailures: 1 } },
    });

    await Effect.runPromise(
      host.agent.session("kiln").send("try again", {
        requestId: "foreign-to-failed-loop",
        delivery: "followUp",
      }),
    );
    await host.drain();

    expect(observedResult).toMatchObject({
      role: "toolResult",
      isError: true,
    });
    expect(JSON.stringify(observedResult)).toContain(
      "schedule_next only works inside this loop's own tick run",
    );
  } finally {
    await host.dispose();
  }
});

it("explains that schedule_next only works inside this loop's own tick run", async () => {
  let observedResult: unknown;
  const host = await openLoop({
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) =>
          request.bindings.loop?.schedule_next?.({
            delaySeconds: 60,
            reason: "check the kiln",
          }),
      }),
    },
    model: scriptedModel([
      fauxAssistantMessage(fauxToolCall("execute", { code: "schedule" }), {
        stopReason: "toolUse",
      }),
      (context) => {
        observedResult = context.messages.find(
          (message) => message.role === "toolResult",
        );
        return fauxAssistantMessage("not scheduled");
      },
    ]),
  });
  try {
    await Effect.runPromise(
      host.agent.session("kiln").send("schedule", {
        requestId: "outside-loop-tick",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(observedResult).toBeDefined();
    expect(JSON.stringify(observedResult)).toContain(
      "schedule_next only works inside this loop's own tick run",
    );
    expect(observedResult).toMatchObject({
      role: "toolResult",
      isError: true,
      content: [
        {
          type: "text",
        },
      ],
    });
  } finally {
    await host.dispose();
  }
});

it("backs off every failed tick and caps retries at fifteen minutes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startAt = Date.parse("2026-10-08T16:00:00Z");
  vi.setSystemTime(startAt);
  let attempts = 0;
  const host = await openLoop({
    model: {
      acquire: () => {
        attempts += 1;
        return Effect.die(new Error(`tick failure ${String(attempts)}`));
      },
    },
  });
  try {
    await host.loop.call("startSelfPaced", {
      prompt: "Check the kiln",
      requestId: "retry-loop",
    });
    await host.drain();

    let dueAt = startAt;
    const backoffSteps: readonly (readonly [number, number])[] = [
      [1, 30_000],
      [2, 60_000],
      [3, 120_000],
      [4, 240_000],
      [5, 480_000],
      [6, 900_000],
      [7, 900_000],
    ];
    for (const [failures, delay] of backoffSteps) {
      dueAt += delay;
      const retry = await host.view();
      expect(retry).toMatchObject({
        value: {
          loop: {
            state: "active",
            consecutiveFailures: failures,
            nextDueAt: dueAt,
          },
        },
      });
      if (retry.status !== "running" || retry.value === null)
        throw new Error("Retry state unavailable");
      expect(retry.value.loop.lastError).toBe(
        "Loop work ended with outcome failed.",
      );
      vi.setSystemTime(dueAt);
      await host.drain();
    }
    expect(attempts).toBe(8);
  } finally {
    await host.dispose();
  }
});

it("resets the failure count after the first successful retried tick", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startAt = Date.parse("2026-10-08T16:00:00Z");
  vi.setSystemTime(startAt);
  const host = await openLoop({
    tools: scheduleTools(),
    model: scriptedModel([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "busy" }),
      scheduleCall,
      fauxAssistantMessage("scheduled"),
    ]),
  });
  try {
    await host.loop.call("startSelfPaced", {
      prompt: "Check the kiln",
      requestId: "reset-loop",
    });
    await host.drain();
    vi.setSystemTime(startAt + 30_000);
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: {
        loop: {
          state: "active",
          consecutiveFailures: 0,
          lastError: null,
          nextDueAt: startAt + 90_000,
        },
      },
    });
  } finally {
    await host.dispose();
  }
});

it("does not retry a cancelled tick", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const host = await openLoop({
    model: scriptedModel([fauxAssistantMessage("", { stopReason: "aborted" })]),
  });
  try {
    await host.loop.call("startSelfPaced", {
      prompt: "Check the kiln",
      requestId: "cancelled-tick",
    });
    await host.drain();
    expect(await host.view()).toMatchObject({
      value: {
        loop: {
          state: "cancelled",
          consecutiveFailures: 0,
          nextDueAt: null,
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
  let observedResult: unknown;
  const host = await openLoop({
    tools: {
      ...scheduleTools(),
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) => {
          const scheduleNext = request.bindings.loop?.schedule_next;
          if (scheduleNext === undefined)
            throw new Error("loop tools are missing");
          return await scheduleNext({
            delaySeconds: 60,
            reason: "check the kiln",
          });
        },
      }),
    },
    model: scriptedModel([
      fauxAssistantMessage("first tick"),
      scheduleCall,
      (context) => {
        observedResult = context.messages.find(
          (message) => message.role === "toolResult",
        );
        return fauxAssistantMessage("stale schedule was refused");
      },
    ]),
  });
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
    expect(failed.value?.loop.lastError).toContain("unavailable");
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
    await Effect.runPromise(
      host.agent.session("kiln").send("check the old loop", {
        requestId: "schedule-failed-loop",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(observedResult).toMatchObject({
      role: "toolResult",
      isError: true,
    });
    expect(JSON.stringify(observedResult)).toContain(
      "loop is failed; start a new one with loop.start",
    );
    await expect(
      host.loop.call("startSelfPaced", {
        prompt: "Check again",
        requestId: "restart-after-failed-occurrence",
      }),
    ).resolves.toMatchObject({
      loop: {
        state: "active",
        consecutiveFailures: 0,
        lastError: null,
      },
    });
  } finally {
    await host.dispose();
  }
});
