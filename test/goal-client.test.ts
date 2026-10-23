import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vitest";
import { clientContributionSchemaV1 } from "@fungi.computer/shiitake/client-entry";
import goalClient from "../src/goal/client.js";
import {
  GoalProjection,
  GoalPauseCause,
  type EndedGoal,
  type Goal,
} from "../src/goal/contract.js";

const encode = Schema.encodeSync(GoalProjection);
const admit = Schema.decodeUnknownSync(clientContributionSchemaV1);
const startedAt = Date.parse("2026-10-18T14:02:30.000Z");

function contribution(
  goal: Goal | null,
  ended: readonly EndedGoal[] = [],
  omitted = 0,
) {
  if (goalClient.contribute === undefined)
    throw new Error("Goal client is missing");
  return admit(
    goalClient.contribute({
      status: "running",
      revision: "sha256:goal-test",
      value: encode({ goal, ended, omitted }),
      catalog: { protocol: "whistle.catalog/v1", commands: [] },
    }),
  );
}

const live: Goal = {
  revision: "set:menus",
  objective: "Tidy the menus",
  state: "active",
  startedAt,
  pauseCause: null,
};

afterEach(() => vi.unstubAllEnvs());

it.each(["person", "blocked", "stalled", "cancelled", "failed", "no-terminal"])(
  "decodes the closed %s pause cause without interpreting display prose",
  (kind) => {
    expect(
      Schema.decodeUnknownSync(GoalPauseCause)({
        kind,
        detail: "Blocked: words alone do not select a cause",
      }),
    ).toEqual({
      kind,
      detail: "Blocked: words alone do not select a cause",
    });
  },
);

it("rejects an unrecognized pause cause at the shared wire decoder", () => {
  expect(() =>
    Schema.decodeUnknownSync(GoalProjection)({
      goal: {
        ...live,
        state: "paused",
        pauseCause: { kind: "Blocked: needs access", detail: null },
      },
      ended: [],
      omitted: 0,
    }),
  ).toThrow();
});

it("R2 footer: a live goal is one worded line, 'Pursuing goal since 14:02', with a Pause control", () => {
  vi.stubEnv("TZ", "UTC");
  const result = contribution(live);
  expect(result.panel).toEqual([
    {
      id: "goal",
      title: "Pursuing goal since 14:02 · Tidy the menus",
      tone: "running",
      actions: [
        { id: "goal", label: "Pause goal", input: { action: "pause" } },
      ],
    },
  ]);
  // No second "Goal active" chip beside the run status.
  expect(result.chips).toEqual([]);
});

it("R2 footer: an agent-started goal shows the same status line as a person-started one", () => {
  vi.stubEnv("TZ", "UTC");
  const person = contribution(live);
  const agent = contribution({ ...live, revision: "run:agent-work" });
  expect(agent.panel).toEqual(person.panel);
});

it("R2 footer: a paused goal says 'Goal paused (/goal resume)' and why, on the line itself, with a Resume control", () => {
  const result = contribution({
    ...live,
    state: "paused",
    pauseCause: { kind: "cancelled", detail: "Stopped" },
  });
  expect(result.panel).toEqual([
    {
      id: "goal",
      title: "Goal paused (/goal resume) · Tidy the menus · Stopped",
      tone: "muted",
      actions: [
        { id: "goal", label: "Resume goal", input: { action: "resume" } },
      ],
    },
  ]);
  expect(result.chips).toEqual([]);
});

it("R2 footer: with no live or paused goal the footer shows nothing", () => {
  const result = contribution(null, [
    {
      sequence: 1,
      objective: "Tidy the menus",
      outcome: "achieved",
      reason: "Menus are tidy",
      endedAt: startedAt,
      afterSequence: 30,
    },
  ]);
  expect(result.panel).toEqual([]);
  expect(result.chips).toEqual([]);
});

it("R3 chat: each finished goal is exactly one chat line at its committed Session position", () => {
  const result = contribution(null, [
    {
      sequence: 1,
      objective: "Tidy the menus",
      outcome: "achieved",
      reason: "Menus are tidy",
      endedAt: startedAt,
      afterSequence: 30,
    },
    {
      sequence: 2,
      objective: "Write the release notes",
      outcome: "cleared",
      reason: null,
      endedAt: startedAt + 1,
      afterSequence: 45,
    },
  ]);
  expect(result.timeline).toEqual({
    omitted: 0,
    cells: [
      {
        id: "1",
        sequence: 1,
        at: startedAt,
        commandId: null,
        afterSequence: 30,
        rows: [
          {
            id: "goal-ended",
            title: "Goal achieved · Tidy the menus",
            detail: "Menus are tidy",
            tone: "settled",
          },
        ],
      },
      {
        id: "2",
        sequence: 2,
        at: startedAt + 1,
        commandId: null,
        afterSequence: 45,
        rows: [
          {
            id: "goal-ended",
            title: "Goal cleared · Write the release notes",
            tone: "muted",
          },
        ],
      },
    ],
  });
});

it("keeps a long objective whole in the detail while the line stays short", () => {
  const objective = `Tidy ${"every menu ".repeat(20)}`;
  const [row] = contribution({ ...live, objective }).panel;
  expect(row?.title.length).toBeLessThan(120);
  expect(row?.detail).toBe(objective);
});
