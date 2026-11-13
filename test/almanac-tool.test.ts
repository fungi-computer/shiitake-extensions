import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SandboxRequest, SandboxValue } from "@fungi.computer/mycelium";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import { bindAgentExtension } from "@fungi.computer/shiitake/client";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";

import { almanacContract } from "../src/almanac/contract.js";
import { almanacExtension } from "../src/almanac/host.js";
import { grantAll, openAgent, sqliteOwner } from "./fixtures/host.js";

afterEach(() => {
  vi.useRealTimers();
});

const call = (code: string) =>
  fauxAssistantMessage(fauxToolCall("execute", { code }), {
    stopReason: "toolUse",
  });

type Schedules = NonNullable<SandboxRequest["bindings"][string]>;
type When =
  | { kind: "once"; at: string }
  | { kind: "cron"; expression: string; timeZone: string };
const createdSchedule = z.object({ id: z.string(), nextDueAt: z.number() });

/**
 * An Agent whose model runs `execute` programs against the `schedule` module its
 * Almanac extension grants, exactly as a model-facing tool call reaches it.
 */
async function openScheduler(
  programs: Record<string, (s: Schedules) => Promise<SandboxValue>>,
) {
  const store = sqliteOwner();
  const faux = fauxModel([]);
  faux.setResponses([
    call("create"),
    fauxAssistantMessage("scheduled"),
    call("list"),
    fauxAssistantMessage("listed"),
    // The fired occurrence is an ordinary prompt: the model answers it.
    fauxAssistantMessage("overnight changes summarized"),
    call("cancel"),
    fauxAssistantMessage("cancelled"),
    fauxAssistantMessage("done"),
  ]);
  const results: unknown[] = [];
  const host = await openAgent(store.owner, grantAll([almanacExtension]), {
    model: {
      acquire: () =>
        Effect.succeed({
          retryable: () => false,
          model: faux.model,
          stream: faux.stream,
          release: Effect.void,
        }),
    },
    tools: {
      modules: [],
      sources: [],
      sandbox: fromTypedSandbox({
        execute: async (request: SandboxRequest) => {
          const schedule = request.bindings.schedule;
          if (schedule === undefined) throw new Error("schedule is missing");
          const program = programs[request.code];
          if (program === undefined) throw new Error("unknown program");
          const result = await program(schedule);
          results.push(result);
          return result;
        },
      }),
    },
  });
  const almanac = bindAgentExtension(host, almanacContract);
  const send = async (text: string, requestId: string) => {
    await Effect.runPromise(
      host.agent
        .session("garden")
        .send(text, { requestId, delivery: "followUp" }),
    );
    await host.drain();
  };
  const userMessages = async () =>
    (await Effect.runPromise(host.agent.session("garden").read())).messages
      .map(({ value }) => value)
      .filter(({ role }) => role === "user")
      .map(({ content }) => content);
  return {
    host,
    almanac,
    send,
    results,
    userMessages,
    dispose: async () => {
      await host.close();
      store.close();
    },
  };
}

it("lets an Agent create a daily schedule that is listed, fires through the runner, and is cancelled", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T07:00:00Z"));
  let created: z.output<typeof createdSchedule> | undefined;
  const t = await openScheduler({
    create: async (schedule) => {
      created = createdSchedule.parse(
        await schedule.create?.({
          prompt: "Good morning: summarize the overnight changes",
          when: { kind: "cron", expression: "0 8 * * *", timeZone: "UTC" },
        }),
      );
      return created;
    },
    list: async (schedule) => (await schedule.list?.({})) ?? null,
    cancel: async (schedule) =>
      (await schedule.cancel?.({ scheduleId: created?.id ?? "" })) ?? null,
  });
  try {
    await t.send("every morning at 8, summarize the overnight changes", "p1");
    expect(created).toMatchObject({
      nextDueAt: Date.parse("2026-10-08T08:00:00Z"),
    });
    // The Agent's tool wrote through Almanac's own commands: they read it back.
    const stored = await t.almanac.call("read", {
      scheduleId: created?.id ?? "",
    });
    expect(stored).toMatchObject({
      sessionId: "garden",
      prompt: "Good morning: summarize the overnight changes",
      cron: { expression: "0 8 * * *", timeZone: "UTC" },
      state: "active",
    });

    await t.send("what is scheduled?", "p2");
    expect(t.results.at(-1)).toEqual([
      expect.objectContaining({ id: created?.id, state: "active" }),
    ]);

    // The existing runner fires it when the (fake) clock reaches 08:00 UTC.
    vi.setSystemTime(new Date("2026-10-08T08:00:30Z"));
    await t.host.drain();
    expect(await t.userMessages()).toContain(
      "Good morning: summarize the overnight changes",
    );
    expect(
      await t.almanac.call("read", { scheduleId: created?.id ?? "" }),
    ).toMatchObject({
      state: "active",
      nextDueAt: Date.parse("2026-10-09T08:00:00Z"),
    });

    await t.send("stop the morning summary", "p3");
    expect(t.results.at(-1)).toMatchObject({ state: "cancelled" });
    const before = (await t.userMessages()).length;
    vi.setSystemTime(new Date("2026-10-09T08:00:30Z"));
    await t.host.drain();
    expect((await t.userMessages()).length).toBe(before);
    expect(
      await t.almanac.call("read", { scheduleId: created?.id ?? "" }),
    ).toMatchObject({
      state: "cancelled",
    });
  } finally {
    await t.dispose();
  }
});

it("refuses a past one-shot time and a malformed cron with the owner's reason", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T07:00:00Z"));
  const failures: string[] = [];
  const attempt = (when: When) => async (schedule: Schedules) => {
    const outcome = await schedule.create?.({ prompt: "x", when }).then(
      () => "created",
      (cause: unknown) => (cause instanceof Error ? cause.message : "refused"),
    );
    failures.push(String(outcome));
    return null;
  };
  const t = await openScheduler({
    create: attempt({ kind: "once", at: "2026-10-08T06:00:00Z" }),
    list: attempt({ kind: "cron", expression: "not a cron", timeZone: "UTC" }),
    cancel: () => Promise.resolve(null),
  });
  try {
    await t.send("once in the past", "q1");
    await t.send("bad cron", "q2");
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/future/);
    expect(await t.almanac.call("list", {})).toEqual([]);
  } finally {
    await t.dispose();
  }
});
