import {
  bindAgentExtension,
  bindSessionExtension,
} from "@fungi.computer/shiitake/client";
import { expect, it } from "vitest";

import { almanacContract } from "../src/almanac/contract.js";
import { almanacExtension } from "../src/almanac/host.js";
import { loopContract } from "../src/loop/contract.js";
import { loopExtension } from "../src/loop/host.js";
import {
  controlAgentSchedule,
  controlAgentScheduleWithContent,
  readAgentSchedulePage,
} from "../src/schedules.js";
import { grantAll, openAgent, sqliteOwner } from "./fixtures/host.js";

async function openSchedules() {
  const store = sqliteOwner();
  const host = await openAgent(
    store.owner,
    grantAll([almanacExtension, loopExtension]),
  );
  return {
    ...host,
    almanac: bindAgentExtension(host, almanacContract),
    loop: bindSessionExtension(host.session("garden"), loopContract),
    dispose: async () => {
      await host.close();
      store.close();
    },
  };
}

it("continues by native Almanac and Session keys within one shared page budget", async () => {
  const host = await openSchedules();
  try {
    for (const requestId of ["c", "a", "b"])
      await host.almanac.call("createOneShot", {
        requestId,
        sessionId: "garden",
        prompt: "Private Almanac instruction",
        dueAt: Date.now() + 3_600_000,
      });
    const started = await host.loop.call("startFixedInterval", {
      requestId: "loop",
      prompt: "Private Loop instruction",
      expression: "0 * * * *",
      timeZone: "UTC",
    });
    const first = await readAgentSchedulePage("agent", host, { limit: 2 });
    expect(first.items).toMatchObject([
      {
        kind: "almanac",
        schedule: { id: "a" },
      },
      {
        kind: "almanac",
        schedule: { id: "b" },
      },
    ]);
    expect(first.next).toEqual({
      agentId: "agent",
      kind: "almanac",
      after: "b",
    });
    if (first.next === null) throw new Error("Expected native continuation");
    const second = await readAgentSchedulePage("agent", host, {
      limit: 2,
      after: first.next,
    });
    expect(second.items).toMatchObject([
      {
        kind: "almanac",
        schedule: { id: "c" },
      },
      {
        agentId: "agent",
        kind: "loop",
        schedule: { ...started.loop, sessionId: "garden" },
      },
    ]);
    expect(second.next).toEqual({
      agentId: "agent",
      kind: "loop",
      after: "garden",
    });
    if (second.next === null) throw new Error("Expected native continuation");
    await expect(
      readAgentSchedulePage("agent", host, { limit: 2, after: second.next }),
    ).resolves.toEqual({ items: [], next: null });
    await expect(
      readAgentSchedulePage("agent", host, { limit: 65 }),
    ).rejects.toThrow();
  } finally {
    await host.dispose();
  }
});

it("rejects a continuation for another Agent for either native kind", async () => {
  const host = await openSchedules();
  try {
    for (const kind of ["almanac", "loop"] as const)
      await expect(
        readAgentSchedulePage("agent", host, {
          limit: 2,
          after: { agentId: "another-agent", kind, after: "garden" },
        }),
      ).rejects.toThrow("Schedule continuation belongs to another Agent");
  } finally {
    await host.dispose();
  }
});

it("rejects malformed native continuation keys through the shared helper", async () => {
  const host = await openSchedules();
  try {
    for (const after of ["not/a/native/key", "a".repeat(201)])
      await expect(
        readAgentSchedulePage("agent", host, {
          limit: 2,
          after: { agentId: "agent", kind: "almanac", after },
        }),
      ).rejects.toThrow("Invalid schedule continuation key");
    await expect(
      readAgentSchedulePage("agent", host, {
        limit: 2,
        after: { agentId: "agent", kind: "loop", after: "" },
      }),
    ).rejects.toThrow();
  } finally {
    await host.dispose();
  }
});

it("returns only target and native state for manage, with content available only explicitly", async () => {
  const host = await openSchedules();
  try {
    await host.almanac.call("createOneShot", {
      requestId: "once",
      sessionId: "garden",
      prompt: "Private Almanac instruction",
      dueAt: Date.now() + 3_600_000,
    });
    const started = await host.loop.call("startFixedInterval", {
      requestId: "first",
      prompt: "Private Loop instruction",
      expression: "0 * * * *",
      timeZone: "UTC",
    });
    const almanac = {
      agentId: "agent",
      kind: "almanac",
      scheduleId: "once",
    } as const;
    const loop = {
      agentId: "agent",
      kind: "loop",
      sessionId: "garden",
      loopId: started.loop.loopId,
    } as const;
    for (const target of [almanac, loop]) {
      expect(await controlAgentSchedule(host, target, "pause")).toEqual({
        ...target,
        state: "paused",
      });
      expect(await controlAgentSchedule(host, target, "delete")).toEqual({
        ...target,
        state: "cancelled",
      });
    }
    await expect(
      controlAgentScheduleWithContent(host, almanac, "delete"),
    ).resolves.toMatchObject({
      agentId: "agent",
      kind: "almanac",
      schedule: {
        id: "once",
        state: "cancelled",
        prompt: "Private Almanac instruction",
      },
    });
    const replacement = await host.loop.call("startFixedInterval", {
      requestId: "replacement",
      prompt: "Replacement instruction",
      expression: "0 * * * *",
      timeZone: "UTC",
    });
    for (const action of ["pause", "delete"] as const)
      await expect(
        controlAgentSchedule(host, loop, action),
      ).rejects.toMatchObject({
        boundary: "store",
        cause: "conflict",
      });
    await expect(
      controlAgentScheduleWithContent(
        host,
        { ...loop, loopId: replacement.loop.loopId },
        "pause",
      ),
    ).resolves.toMatchObject({
      kind: "loop",
      schedule: {
        loopId: replacement.loop.loopId,
        state: "paused",
        prompt: "Replacement instruction",
      },
    });
  } finally {
    await host.dispose();
  }
});

it("rejects an unavailable native owner instead of reporting an empty page", async () => {
  const store = sqliteOwner();
  const host = await openAgent(store.owner, grantAll([almanacExtension]));
  try {
    await expect(readAgentSchedulePage("agent", host)).rejects.toThrow();
  } finally {
    await host.close();
    store.close();
  }
});
