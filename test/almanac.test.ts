import { bindAgentExtension } from "@fungi.computer/shiitake/client";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";

import { almanacContract } from "../src/almanac/contract.js";
import { almanacExtension } from "../src/almanac/host.js";
import { grantAll, openAgent, sqliteOwner } from "./fixtures/host.js";

afterEach(() => {
  vi.useRealTimers();
});

async function openAlmanac() {
  const store = sqliteOwner();
  const host = await openAgent(store.owner, grantAll([almanacExtension]));
  const almanac = bindAgentExtension(host, almanacContract);
  const messages = async (sessionId: string) =>
    (
      await Effect.runPromise(host.agent.session(sessionId).read())
    ).messages.map(({ value }) => value);
  return {
    ...host,
    almanac,
    messages,
    dispose: async () => {
      await host.close();
      store.close();
    },
  };
}

it("admits a due one-shot occurrence once through the door and finishes it", async () => {
  const host = await openAlmanac();
  try {
    expect(
      (await Effect.runPromise(host.agent.listSessions())).sessions,
    ).toEqual([]);
    const created = await host.almanac.call("createOneShot", {
      requestId: "once",
      sessionId: "garden",
      prompt: "Water the ferns",
      dueAt: 0,
    });
    expect(created).toMatchObject({ id: "once", state: "active", attempt: 0 });
    await expect(
      host.almanac.call("createOneShot", {
        requestId: "once",
        sessionId: "garden",
        prompt: "Water the ferns",
        dueAt: 0,
      }),
    ).resolves.toEqual(created);
    await expect(
      host.almanac.call("createOneShot", {
        requestId: "once",
        sessionId: "garden",
        prompt: "Something else",
        dueAt: 0,
      }),
    ).rejects.toMatchObject({ boundary: "store", cause: "conflict" });

    await host.drain();
    const finished = await host.almanac.call("read", { scheduleId: "once" });
    expect(finished).toMatchObject({ state: "finished", lastError: null });
    expect(finished?.lastCommandId).toEqual(expect.any(String));
    expect(await host.messages("garden")).toEqual([
      expect.objectContaining({ role: "user", content: "Water the ferns" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
  } finally {
    await host.dispose();
  }
});

it("does not recreate a recurring schedule's deleted Session after its first accepted send", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T16:00:00Z"));
  const host = await openAlmanac();
  try {
    const created = await host.almanac.call("createRecurring", {
      requestId: "deleted-recurring",
      sessionId: "garden",
      prompt: "Walk the rows",
      expression: "* * * * *",
      timeZone: "UTC",
    });
    expect(created.lastCommandId).toBeNull();
    expect(
      (await Effect.runPromise(host.agent.listSessions())).sessions,
    ).toEqual([]);
    vi.setSystemTime(new Date("2026-10-08T16:01:00Z"));
    await host.drain();
    const accepted = await host.almanac.call("read", {
      scheduleId: created.id,
    });
    expect(accepted?.lastCommandId).toEqual(expect.any(String));
    expect(await host.messages("garden")).toEqual([
      expect.objectContaining({ role: "user", content: "Walk the rows" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
    expect(await Effect.runPromise(host.agent.deleteSession("garden"))).toBe(
      true,
    );
    vi.setSystemTime(new Date("2026-10-08T16:02:00Z"));
    await host.drain();
    expect(
      (await Effect.runPromise(host.agent.listSessions())).sessions,
    ).toEqual([]);
    const refused = await host.almanac.call("read", {
      scheduleId: created.id,
    });
    expect(refused).toMatchObject({
      state: "active",
      attempt: 1,
      lastCommandId: accepted?.lastCommandId,
    });
    expect(refused?.lastError).toContain("unavailable");
    expect((await host.extensions.list())[0]?.status).toBe("running");
    // A retry retains the successful-send evidence and still cannot recreate it.
    vi.setSystemTime(new Date("2026-10-08T16:03:00Z"));
    await host.drain();
    expect(
      (await Effect.runPromise(host.agent.listSessions())).sessions,
    ).toEqual([]);
    expect(
      await host.almanac.call("read", { scheduleId: created.id }),
    ).toMatchObject({
      attempt: 2,
      lastCommandId: accepted?.lastCommandId,
    });
  } finally {
    await host.dispose();
  }
});

it("backs off one poisoned schedule while a healthy one is admitted in the same tick", async () => {
  const host = await openAlmanac();
  try {
    // Within the character bound, over the door's 256 KiB byte bound.
    await host.almanac.call("createOneShot", {
      requestId: "poisoned",
      sessionId: "garden",
      prompt: "é".repeat(200_000),
      dueAt: 0,
    });
    await host.almanac.call("createOneShot", {
      requestId: "healthy",
      sessionId: "garden",
      prompt: "Check the tomatoes",
      dueAt: 0,
    });
    const before = Date.now();
    await host.reconcile();
    await host.drain();

    const poisoned = await host.almanac.call("read", {
      scheduleId: "poisoned",
    });
    expect(poisoned).toMatchObject({ state: "active", attempt: 1 });
    expect(poisoned?.lastError).toEqual(expect.any(String));
    await expect(
      host.almanac.call("read", { scheduleId: "healthy" }),
    ).resolves.toMatchObject({ state: "finished" });
    expect(
      (await host.extensions.list()).map(({ id, status }) => [id, status]),
    ).toEqual([["botanical-almanac", "running"]]);

    const pending = await host.pendingWork();
    expect(pending.pending).toBe(false);
    expect(pending.nextWakeAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(pending.nextWakeAt).toBeLessThanOrEqual(Date.now() + 30_000);

    // A human resume is the retry: the error clears and the backoff resets.
    await expect(
      host.almanac.call("resume", { scheduleId: "poisoned" }),
    ).resolves.toMatchObject({ attempt: 0, lastError: null });
  } finally {
    await host.dispose();
  }
});

it("fires a recurring schedule on its cron cadence and coalesces missed occurrences", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T12:00:30Z"));
  const host = await openAlmanac();
  try {
    const created = await host.almanac.call("createRecurring", {
      requestId: "hourly",
      sessionId: "garden",
      prompt: "Walk the rows",
      expression: "0 * * * *",
      timeZone: "UTC",
    });
    expect(created.nextDueAt).toBe(Date.parse("2026-09-26T13:00:00Z"));
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: created.nextDueAt,
    });

    // Three hours pass: exactly one occurrence is admitted, then the next hour.
    vi.setSystemTime(new Date("2026-09-26T15:10:00Z"));
    await host.drain();
    const fired = await host.almanac.call("read", { scheduleId: "hourly" });
    expect(fired).toMatchObject({
      state: "active",
      nextDueAt: Date.parse("2026-09-26T16:00:00Z"),
    });
    expect(
      (await host.messages("garden")).filter(({ role }) => role === "user"),
    ).toHaveLength(1);

    await expect(
      host.almanac.call("pause", { scheduleId: "hourly" }),
    ).resolves.toMatchObject({ state: "paused" });
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
    await expect(
      host.almanac.call("cancel", { scheduleId: "hourly" }),
    ).resolves.toMatchObject({ state: "cancelled" });
    await expect(
      host.almanac.call("resume", { scheduleId: "hourly" }),
    ).rejects.toMatchObject({ boundary: "store", cause: "conflict" });
    await expect(
      host.almanac.call("pause", { scheduleId: "missing" }),
    ).rejects.toMatchObject({ boundary: "store", cause: "rejected" });
    await expect(
      host.almanac.call("createRecurring", {
        requestId: "broken",
        sessionId: "garden",
        prompt: "Never",
        expression: "not cron",
        timeZone: "UTC",
      }),
    ).rejects.toMatchObject({ boundary: "contract", cause: "invalid" });
    await expect(host.almanac.call("list", {})).resolves.toEqual([
      expect.objectContaining({ id: "hourly", state: "cancelled" }),
    ]);
  } finally {
    await host.dispose();
  }
});
