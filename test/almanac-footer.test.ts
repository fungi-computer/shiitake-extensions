import {
  bindAgentExtension,
  bindSessionExtension,
} from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { AlmanacProjection, almanacContract } from "../src/almanac/contract.js";
import { almanacExtension } from "../src/almanac/host.js";
import almanacClient from "../src/almanac/client.js";
import { botanicalAgentExtensions } from "../src/roster.js";
import { openAgent, sqliteOwner } from "./fixtures/host.js";

const roster = {
  roster: [almanacExtension],
  grants: botanicalAgentExtensions.grants.filter(
    (grant) => grant.id === almanacContract.id,
  ),
};

it("projects only this conversation's live schedules and controls them through advertised Session commands after reopen", async () => {
  const store = sqliteOwner();
  let host = await openAgent(store.owner, roster);
  try {
    const almanac = bindAgentExtension(host, almanacContract);
    await almanac.call("createRecurring", {
      requestId: "inbox-weekdays",
      sessionId: "garden",
      prompt: "Summarise my inbox",
      expression: "0 8 * * 1-5",
      timeZone: "Europe/Berlin",
    });
    const slot = (await host.session("garden").read()).extensions[
      almanacContract.id
    ];
    expect(almanacClient.contribute?.(slot).panel[0]?.actions?.[0]).toEqual({
      id: "pauseSchedule",
      label: "Pause",
      input: { scheduleId: "inbox-weekdays" },
    });
    expect(
      almanacClient.contribute?.(
        (await host.session("other").read()).extensions[almanacContract.id],
      ).panel,
    ).toEqual([]);
    const other = bindSessionExtension(host.session("other"), almanacContract);
    for (const command of [
      "pauseSchedule",
      "resumeSchedule",
      "cancelSchedule",
    ] as const)
      await expect(
        other.call(command, { scheduleId: "inbox-weekdays" }),
      ).rejects.toThrow("Schedule does not belong to this conversation");
    const session = bindSessionExtension(
      host.session("garden"),
      almanacContract,
    );
    await session.call("pauseSchedule", { scheduleId: "inbox-weekdays" });
    expect(
      await almanac.call("read", { scheduleId: "inbox-weekdays" }),
    ).toMatchObject({ state: "paused" });
    await host.close();
    host = await openAgent(store.owner, roster);
    const reopened = host.session("garden");
    const paused = almanacClient.contribute?.(
      (await reopened.read()).extensions[almanacContract.id],
    );
    expect(paused?.panel[0]?.title).toContain("paused");
    expect(paused?.panel[0]?.actions?.[0]?.id).toBe("resumeSchedule");
    const controls = bindSessionExtension(reopened, almanacContract);
    await controls.call("resumeSchedule", { scheduleId: "inbox-weekdays" });
    expect(
      almanacClient.contribute?.(
        (await reopened.read()).extensions[almanacContract.id],
      ).panel[0]?.title,
    ).toContain("next");
    await controls.call("cancelSchedule", { scheduleId: "inbox-weekdays" });
    await host.close();
    host = await openAgent(store.owner, roster);
    expect(
      almanacClient.contribute?.(
        (await host.session("garden").read()).extensions[almanacContract.id],
      ).panel,
    ).toEqual([]);
    expect(
      await bindAgentExtension(host, almanacContract).call("list", {}),
    ).toEqual([
      expect.objectContaining({ id: "inbox-weekdays", state: "cancelled" }),
    ]);
  } finally {
    await host.close();
    store.close();
  }
});

it("does not lose this Session behind another Session's first page or settled schedules", async () => {
  const store = sqliteOwner();
  const host = await openAgent(store.owner, roster);
  try {
    const almanac = bindAgentExtension(host, almanacContract);
    for (let i = 0; i < 65; i += 1)
      await almanac.call("createOneShot", {
        requestId: `a-${String(i).padStart(2, "0")}`,
        sessionId: "other",
        prompt: "Other conversation",
        dueAt: 4_000_000_000_000,
      });
    for (let i = 0; i < 17; i += 1)
      await almanac.call("createOneShot", {
        requestId: `z-${String(i).padStart(2, "0")}`,
        sessionId: "garden",
        prompt: "My reminder",
        dueAt: 4_000_000_000_000,
      });
    const read = async () => {
      const slot = (await host.session("garden").read()).extensions[
        almanacContract.id
      ];
      if (slot?.status !== "running")
        throw new Error("Almanac projection is missing");
      return Schema.decodeUnknownSync(AlmanacProjection)(slot.value);
    };
    const first = await read();
    expect(first.schedules.map((row) => row.id)).toContain("z-00");
    expect(first.schedules).toHaveLength(15);
    expect(first.more).toBe(2);
    await almanac.call("cancel", { scheduleId: "z-00" });
    await almanac.call("pause", { scheduleId: "z-01" });
    expect((await read()).schedules.some((row) => row.id === "z-00")).toBe(
      false,
    );
    expect((await read()).more).toBe(1);
  } finally {
    await host.close();
    store.close();
  }
});
