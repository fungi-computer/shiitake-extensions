import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { clientContributionSchemaV1 } from "@fungi.computer/shiitake/client-entry";
import almanacClient from "../src/almanac/client.js";
import { AlmanacProjection, type Schedule } from "../src/almanac/contract.js";

const schedule: Schedule = {
  id: "weekday",
  sessionId: "garden",
  prompt: "Summarise my inbox",
  cron: { expression: "0 8 * * 1-5", timeZone: "Europe/Berlin" },
  nextDueAt: Date.parse("2026-11-17T07:00:00Z"),
  state: "active",
  lastCommandId: null,
  lastError: null,
  attempt: 0,
};
function contribution(schedules: readonly Schedule[], more = 0) {
  return Schema.decodeUnknownSync(clientContributionSchemaV1)(
    almanacClient.contribute?.({
      status: "running",
      revision: "sha256:almanac-test",
      value: Schema.encodeSync(AlmanacProjection)({ schedules, more }),
      catalog: { protocol: "whistle.catalog/v1", commands: [] },
    }),
  );
}

it("shows a weekday cadence in its schedule zone with exact pause and cancel targets", () => {
  const row = contribution([schedule]).panel[0];
  expect(row?.title).toContain("Every weekday 08:00 · next");
  expect(row?.title).toContain("08:00");
  expect(row?.detail).toBe("Summarise my inbox\nEurope/Berlin");
  expect(row?.actions).toEqual([
    { id: "pauseSchedule", label: "Pause", input: { scheduleId: "weekday" } },
    { id: "cancelSchedule", label: "Cancel", input: { scheduleId: "weekday" } },
  ]);
});
it("shows paused schedules with resume, without a misleading next time", () => {
  const row = contribution([{ ...schedule, state: "paused" }]).panel[0];
  expect(row?.title).toBe("Every weekday 08:00 · paused");
  expect(row?.actions?.[0]).toEqual({
    id: "resumeSchedule",
    label: "Resume",
    input: { scheduleId: "weekday" },
  });
});
it("hides cancelled and finished schedules, empty and unavailable projections", () => {
  expect(
    contribution([
      { ...schedule, state: "cancelled" },
      { ...schedule, id: "done", state: "finished" },
    ]).panel,
  ).toEqual([]);
  expect(contribution([]).panel).toEqual([]);
  expect(almanacClient.contribute?.(undefined).panel).toEqual([]);
});
it("keeps failure details and reports overflow within the shared row budget", () => {
  const result = contribution(
    Array.from({ length: 15 }, (_, i) => ({
      ...schedule,
      id: `s${String(i)}`,
      lastError: "Model unavailable",
    })),
    3,
  );
  expect(result.panel).toHaveLength(16);
  expect(result.panel[0]).toMatchObject({
    tone: "error",
    detail: "Summarise my inbox\nEurope/Berlin\nModel unavailable",
  });
  expect(result.panel[15]?.title).toContain("3 more schedules");
});
it("shows a one-shot and retains unfamiliar cron cadences without guessing", () => {
  expect(contribution([{ ...schedule, cron: null }]).panel[0]?.title).toContain(
    "Once · next",
  );
  expect(
    contribution([
      { ...schedule, cron: { expression: "5,25 9 * * 2", timeZone: "UTC" } },
    ]).panel[0]?.title,
  ).toContain("5,25 9 * * 2");
});
