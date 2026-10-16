import { clientContributionSchemaV1 } from "@fungi.computer/shiitake/client-entry";
import {
  defineExtension,
  ExtensionId,
  type CommandsV0,
} from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vitest";
import subagentsClient from "../src/subagents/client.js";
import {
  subagentsContract,
  SubagentsProjection,
} from "../src/subagents/contract.js";
import {
  subagentsExtension,
  subagentsGrant,
  type SubagentAgent,
  type SubagentRecord,
  type SubagentSource,
} from "../src/subagents/host.js";
import { questionHost } from "./fixtures/ask.js";
import { grantAll, openAgent, run, sqliteOwner } from "./fixtures/host.js";

type Host = Awaited<ReturnType<typeof openAgent>>;
const closers: Host[] = [];
afterEach(async () => {
  for (const host of closers.splice(0).reverse()) await host.close();
});

/** The two owner reads the view uses, over a real core Agent. */
function childAccess(host: Host): SubagentAgent {
  return {
    listSessions: (after) => run(host.agent.listSessions(after)),
    session: (sessionId) => ({
      read: (input) => run(host.agent.session(sessionId).read(input)),
    }),
  };
}

async function child(
  extensions: Parameters<typeof openAgent>[1] = { roster: [], grants: [] },
) {
  const store = sqliteOwner();
  const host = await openAgent(store.owner, extensions);
  closers.push(host);
  return host;
}

async function send(host: Host, sessionId: string, drain = true) {
  await Effect.runPromise(
    host.agent.session(sessionId).send("work", {
      requestId: `${sessionId}-work`,
      delivery: "followUp",
    }),
  );
  if (drain) await host.drain();
}

/** A child-owned attention item of kind approval, through the generic door. */
const approvalId = ExtensionId.make("test-tool-approval");
const approvalCommands = {
  ask: {
    scope: "session",
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
} satisfies CommandsV0;
const approvalExtension = defineExtension({
  id: approvalId,
  version: "1.0.0",
}).define({
  attention: true,
  commands: {
    specs: approvalCommands,
    handlers: (ctx) => ({
      ask: ({ sessionId }: Readonly<{ sessionId: string }>) =>
        ctx.attention
          .set(sessionId, {
            id: "call-1",
            kind: "approval",
            summary: "Approve files.write",
            since: 0,
          })
          .pipe(Effect.andThen(ctx.observe(sessionId)), Effect.as({})),
    }),
  },
});

async function parentWith(
  records: Readonly<Record<string, readonly SubagentRecord[]>>,
  agents: Readonly<Record<string, SubagentAgent>>,
  opened: { count: number } = { count: 0 },
) {
  const source: SubagentSource = {
    read: (sessionId, limit) =>
      Promise.resolve({
        agents: (records[sessionId] ?? []).slice(0, limit),
        more: Math.max(0, (records[sessionId]?.length ?? 0) - limit),
      }),
    open: (agentId) => {
      opened.count += 1;
      const agent = agents[agentId];
      return agent === undefined
        ? Promise.reject(new Error("Agent is outside this project"))
        : Promise.resolve({ agent, release: () => Promise.resolve() });
    },
  };
  const store = sqliteOwner();
  const host = await openAgent(store.owner, {
    roster: [
      subagentsExtension({
        source,
        timing: { refreshMs: 0, pollMs: 20, interestMs: 200 },
      }),
    ],
    grants: [subagentsGrant],
  });
  closers.push(host);
  for (const sessionId of Object.keys(records)) await send(host, sessionId);
  return host;
}

const decode = Schema.decodeUnknownSync(SubagentsProjection);
async function rows(host: Host, sessionId: string) {
  const slot = (await host.session(sessionId).read()).extensions[
    subagentsContract.id
  ];
  return slot?.status !== "running" || slot.value === null
    ? undefined
    : decode(slot.value);
}
/** Read the parent until its view settles on the expected value. */
async function settle(
  host: Host,
  sessionId: string,
  expected: Parameters<typeof expect.objectContaining>[0],
) {
  await vi.waitFor(
    async () => {
      expect(await rows(host, sessionId)).toEqual(
        expect.objectContaining(expected),
      );
    },
    { timeout: 5_000, interval: 10 },
  );
}

it("lists nothing for a conversation that sent no work and one row per Agent it sent work to", async () => {
  const idle = await child();
  await send(idle, "task");
  const record = (sessionId: string) => ({
    agentId: "agent-idle",
    name: "Idle",
    sessionId,
  });
  const parent = await parentWith(
    {
      none: [],
      // The host's grouped read already folds two sends into one row.
      one: [record("task")],
    },
    { "agent-idle": childAccess(idle) },
  );
  await settle(parent, "none", { agents: [], more: 0 });
  await settle(parent, "one", {
    agents: [
      { agentId: "agent-idle", name: "Idle", sessionId: "task", state: "idle" },
    ],
  });
});

it("shows a created, never-messaged Agent as idle with nothing to open", async () => {
  const created = await child();
  const parent = await parentWith(
    { parent: [{ agentId: "agent-new", name: "New", sessionId: null }] },
    { "agent-new": childAccess(created) },
  );
  await settle(parent, "parent", {
    agents: [
      { agentId: "agent-new", name: "New", sessionId: null, state: "idle" },
    ],
  });
  const panel = subagentsClient.contribute?.(
    (await parent.session("parent").read()).extensions[subagentsContract.id],
  ).panel;
  expect(panel?.[0]).toMatchObject({ detail: "not messaged yet" });
  expect(panel?.[0]?.open).toBeUndefined();
});

it("maps working, a waiting question, a waiting approval and an unreadable child", async () => {
  const working = await child();
  await send(working, "busy", false);
  const asked = await questionHost();
  closers.push(asked.host);
  await asked.park();
  const approving = await child(grantAll([approvalExtension]));
  await send(approving, "write");
  await approving.session("write").extension(approvalId).call("ask", {});
  const parent = await parentWith(
    {
      parent: [
        { agentId: "agent-working", name: "Working", sessionId: "busy" },
        { agentId: "agent-asked", name: "Asked", sessionId: "questions" },
        { agentId: "agent-approving", name: "Approving", sessionId: "write" },
        { agentId: "agent-gone", name: "Gone", sessionId: "lost" },
        { agentId: "agent-unlisted", name: "Unlisted", sessionId: "missing" },
      ],
    },
    {
      "agent-working": childAccess(working),
      "agent-asked": childAccess(asked.host),
      "agent-approving": childAccess(approving),
      "agent-unlisted": childAccess(working),
    },
  );
  await settle(parent, "parent", {
    agents: [
      expect.objectContaining({ agentId: "agent-working", state: "working" }),
      {
        agentId: "agent-asked",
        name: "Asked",
        sessionId: "questions",
        state: "waiting",
        attention: "Storage",
      },
      {
        agentId: "agent-approving",
        name: "Approving",
        sessionId: "write",
        state: "waiting",
        attention: "Approve files.write",
      },
      expect.objectContaining({ agentId: "agent-gone", state: "unavailable" }),
      expect.objectContaining({
        agentId: "agent-unlisted",
        state: "unavailable",
      }),
    ],
  });
});

it("polls a working child until it settles, and opens each row at its exact conversation", async () => {
  const worker = await child();
  await send(worker, "job", false);
  const parent = await parentWith(
    { parent: [{ agentId: "agent-worker", name: "Worker", sessionId: "job" }] },
    { "agent-worker": childAccess(worker) },
  );
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "working" })],
  });
  await worker.drain();
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "idle" })],
  });
  const contribution = Schema.decodeUnknownSync(clientContributionSchemaV1)(
    subagentsClient.contribute?.(
      (await parent.session("parent").read()).extensions[subagentsContract.id],
    ),
  );
  expect(contribution.panel).toEqual([
    {
      id: "agent-worker",
      title: "Worker · idle",
      tone: "settled",
      status: { label: "idle", tone: "success" },
      open: {
        params: [
          { key: "agent", value: "agent-worker" },
          { key: "session", value: "job" },
        ],
      },
    },
  ]);
});

it("stops reading children once nobody watches and nothing is live", async () => {
  const idle = await child();
  await send(idle, "task");
  const opened = { count: 0 };
  const parent = await parentWith(
    { parent: [{ agentId: "agent-idle", name: "Idle", sessionId: "task" }] },
    { "agent-idle": childAccess(idle) },
    opened,
  );
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "idle" })],
  });
  const settled = opened.count;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(opened.count).toBe(settled);
});

it("counts sub-agents past the footer bound in one more row", () => {
  const value = Schema.encodeSync(SubagentsProjection)({
    agents: [],
    more: 3,
  });
  const panel = subagentsClient.contribute?.({
    status: "running",
    revision: "sha256:subagents-test",
    value,
    catalog: { protocol: "whistle.catalog/v1", commands: [] },
  }).panel;
  expect(panel).toEqual([
    { id: "more", title: "3 more sub-agents", tone: "muted" },
  ]);
});
