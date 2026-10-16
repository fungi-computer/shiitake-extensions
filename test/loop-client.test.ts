import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vitest";
import { clientContributionSchemaV1 } from "@fungi.computer/shiitake/client-entry";
import loopClient from "../src/loop/client.js";
import { LoopProjection, type Loop } from "../src/loop/contract.js";
import { emptyHistory } from "../src/internal/history.js";

const encode = Schema.encodeSync(LoopProjection);
const admit = Schema.decodeUnknownSync(clientContributionSchemaV1);

function contribution(nextDueAt: number | null, cron: Loop["cron"] = null) {
  if (loopClient.contribute === undefined)
    throw new Error("Loop client is missing");
  return admit(
    loopClient.contribute({
      status: "running",
      revision: "sha256:loop-test",
      value: encode({
        loop: {
          loopId: "loop-test",
          origin: "human",
          expiresAt: null,
          prompt: "Check the kiln",
          mode: cron === null ? "self_paced" : "fixed_interval",
          cron,
          state: "active",
          commandId: "loop-command",
          reason: null,
          nextDueAt,
          lastError: null,
        },
        history: emptyHistory<Loop>(),
      }),
      catalog: { protocol: "whistle.catalog/v1", commands: [] },
    }),
  );
}

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["Europe/Madrid", "2026-10-14T10:05:30.593Z"],
  ["Europe/Madrid", "2026-12-14T10:05:30.593Z"],
  ["Europe/Madrid", "2026-10-14T22:05:30.593Z"],
  ["UTC", "2026-10-14T10:05:30.593Z"],
])(
  "shows the viewer's local due date in both surfaces (%s, %s)",
  (zone, iso) => {
    vi.stubEnv("TZ", zone);
    const at = Date.parse(iso);
    const displayed = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(at);
    const result = contribution(at);
    expect(result.panel[0]?.title).toBe(
      `Loop · active · self-paced · Next ${displayed}`,
    );
    expect(result.waiting).toEqual({
      summary: `Waiting until ${displayed}`,
      cancel: { id: "loop", label: "stop loop", input: { action: "stop" } },
    });
    expect(result.panel[0]?.title).not.toContain(".593Z");
  },
);

it("keeps the cron zone separate from the viewer's display zone", () => {
  vi.stubEnv("TZ", "Europe/Madrid");
  const at = Date.parse("2026-10-14T10:05:30.593Z");
  const local = contribution(at);
  const fixed = contribution(at, {
    expression: "0 * * * *",
    timeZone: "America/New_York",
  });
  expect(fixed.panel[0]?.title).toContain("0 * * * * America/New_York");
  expect(fixed.waiting).toEqual(local.waiting);
});

it("does not invent a due date when no occurrence is scheduled", () => {
  const result = contribution(null);
  expect(result.panel[0]?.title).toBe("Loop · active · self-paced");
  expect(result.waiting).toBeNull();
});
