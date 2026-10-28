import { clientContributionSchemaV1 } from "@fungi.computer/shiitake/client-entry";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import {
  defineExtension,
  ExtensionId,
  type CommandsV0,
} from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogStep } from "../src/internal/catalog.js";
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
  type SubagentTiming,
} from "../src/subagents/host.js";
import { botanicalExtensionsWithSenderRouting } from "../src/roster.js";
import { questions, questionHost, mintedId } from "./fixtures/ask.js";
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
      extension: (id) => host.session(sessionId).extension(id),
      read: (input) => run(host.agent.session(sessionId).read(input)),
      readSettlement: (commandId, input) =>
        run(
          host.agent
            .session(sessionId)
            .readSettlement(commandId, input?.timeoutMs),
        ),
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
  timing: SubagentTiming = { refreshMs: 0, pollMs: 20 },
) {
  const source: SubagentSource = {
    hasLiveChildCommand: () => false,
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
        timing,
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
  expect(panel?.[0]).toMatchObject({ id: "summary" });
  expect(panel?.[0]?.open).toBeUndefined();
  await bindSessionExtension(parent.session("parent"), subagentsContract).call(
    "agents",
    {},
  );
  const expandedPanel = subagentsClient.contribute?.(
    (await parent.session("parent").read()).extensions[subagentsContract.id],
  ).panel;
  expect(expandedPanel?.[0]).toMatchObject({ detail: "not messaged yet" });
  expect(expandedPanel?.[0]?.open).toBeUndefined();
});

it("reads every expanded footer row as the Agent's name and state, without who made it", async () => {
  const fixer = await child();
  const walker = await child();
  const parent = await parentWith(
    {
      parent: [
        {
          agentId: "agent-fixer",
          name: "fixer",
          sessionId: null,
        },
        { agentId: "agent-walker", name: "walker", sessionId: null },
      ],
    },
    {
      "agent-fixer": childAccess(fixer),
      "agent-walker": childAccess(walker),
    },
  );
  await settle(parent, "parent", {
    agents: [
      {
        agentId: "agent-fixer",
        name: "fixer",
        sessionId: null,
        state: "idle",
      },
      {
        agentId: "agent-walker",
        name: "walker",
        sessionId: null,
        state: "idle",
      },
    ],
  });
  await bindSessionExtension(parent.session("parent"), subagentsContract).call(
    "agents",
    {},
  );
  const panel = subagentsClient.contribute?.(
    (await parent.session("parent").read()).extensions[subagentsContract.id],
  ).panel;
  expect(panel?.map(({ title }) => title)).toEqual([
    "fixer · idle",
    "walker · idle",
  ]);
});

it("maps working, a question for a person, an approval for a person and an unreadable child", async () => {
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
        state: "needs_you",
        attention: "Storage",
        // The question itself travels with the row, so a person can answer from here.
        ask: {
          askId: mintedId,
          questions: [expect.objectContaining({ id: "storage" })],
        },
      },
      {
        agentId: "agent-approving",
        name: "Approving",
        sessionId: "write",
        state: "needs_you",
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

it("refreshes a working child's status at its exact conversation", async () => {
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
  await bindSessionExtension(parent.session("parent"), subagentsContract).call(
    "agents",
    {},
  );
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

it("does not re-arm live-child polls without a watcher", async () => {
  const worker = await child();
  await send(worker, "job", false);
  const opened = { count: 0 };
  const parent = await parentWith(
    { parent: [{ agentId: "agent-worker", name: "Worker", sessionId: "job" }] },
    { "agent-worker": childAccess(worker) },
    opened,
  );
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "working" })],
  });
  // Let the baseline refresh finish; a one-shot read is not a watcher.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const baseline = opened.count;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(opened.count).toBe(baseline);

  // A returning consumer still refreshes and observes the child's settlement.
  await worker.drain();
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "idle" })],
  });
});

it("a quiet watcher of fresh cached rows receives settlement without unchanged publications", async () => {
  const worker = await child();
  await send(worker, "job", false);
  const opened = { count: 0 };
  const parent = await parentWith(
    { parent: [{ agentId: "agent-worker", name: "Worker", sessionId: "job" }] },
    { "agent-worker": childAccess(worker) },
    opened,
    { refreshMs: 10_000, pollMs: 20 },
  );
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "working" })],
  });
  const watch = await run(parent.agent.session("parent").watch());
  const updates: unknown[] = [];
  const consuming = Effect.runPromiseExit(
    Stream.runForEach(watch.changes, (frame) =>
      Effect.sync(() => {
        if (frame.kind === "update")
          updates.push(frame.extensions[subagentsContract.id]);
      }),
    ),
  );
  try {
    // Watch delivers one initial catch-up page, even at the baseline cursor.
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]).toMatchObject({
      value: { agents: [{ state: "working" }] },
    });
    // Watching a fresh cached row starts polling without another baseline
    // refresh. Quiet live rows must not cause baseline/replay reads.
    const watching = opened.count;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(opened.count).toBeGreaterThan(watching);
    expect(updates).toHaveLength(1);
    // Unwatched one-shot reads may evict each other, not the quiet live view.
    for (let index = 0; index < 64; index += 1)
      await parent.session(`unwatched-${String(index)}`).read();
    await worker.drain();
    await vi.waitFor(() => {
      expect(updates.at(-1)).toMatchObject({
        value: { agents: [{ state: "idle" }] },
      });
    });
  } finally {
    await run(watch.close);
    await consuming;
  }
});

it("stops reading a live child when the last watcher closes", async () => {
  const worker = await child();
  await send(worker, "job", false);
  const opened = { count: 0 };
  const parent = await parentWith(
    { parent: [{ agentId: "agent-worker", name: "Worker", sessionId: "job" }] },
    { "agent-worker": childAccess(worker) },
    opened,
  );
  const closingWatch = await run(parent.agent.session("parent").watch());
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "working" })],
  });
  await run(closingWatch.close);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const closed = opened.count;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(opened.count).toBe(closed);
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
    expanded: true,
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

it("starts the footer collapsed on first projection and /agents expands it, then collapses it again", async () => {
  const worker = await child();
  await send(worker, "job", false);
  const parent = await parentWith(
    {
      parent: [{ agentId: "agent-worker", name: "Worker", sessionId: "job" }],
      empty: [],
    },
    { "agent-worker": childAccess(worker) },
  );
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "working" })],
  });
  expect(await rows(parent, "parent")).toMatchObject({ expanded: false });
  // The host advertises `/agents` as a slash command.
  const slot = (await parent.session("parent").read()).extensions[
    subagentsContract.id
  ];
  expect(slot?.status === "running" ? slot.catalog : null).toMatchObject({
    commands: [
      { id: "agents", projections: { slash: { aliases: ["agents"] } } },
      // Reached only from a row's Answer action, never as a slash command.
      { id: "answerChild" },
    ],
  });
  const panel = async () =>
    subagentsClient.contribute?.(
      (await parent.session("parent").read()).extensions[subagentsContract.id],
    ).panel;
  expect(await panel()).toEqual([
    {
      id: "summary",
      title: "1 sub-agent · 1 working · /agents shows them",
      tone: "running",
    },
  ]);

  const agents = bindSessionExtension(
    parent.session("parent"),
    subagentsContract,
  );
  expect(await agents.call("agents", {})).toEqual({ type: "done" });
  await settle(parent, "parent", { expanded: true });
  expect((await panel())?.map(({ id }) => id)).toEqual(["agent-worker"]);

  expect(await agents.call("agents", {})).toEqual({ type: "done" });
  await settle(parent, "parent", { expanded: false });
  expect(await panel()).toEqual([
    {
      id: "summary",
      title: "1 sub-agent · 1 working · /agents shows them",
      tone: "running",
    },
  ]);

  await worker.drain();
});

it("/agents with nothing to list changes nothing and says so", async () => {
  const parent = await parentWith({ empty: [] }, {});
  await settle(parent, "empty", { agents: [], expanded: false });
  const result = await bindSessionExtension(
    parent.session("empty"),
    subagentsContract,
  ).call("agents", {});
  expect(result).toMatchObject({
    type: "done",
    notice: { message: "This conversation has no sub-agents." },
  });
  await settle(parent, "empty", { expanded: false });
});

it("a collapsed footer still says a sub-agent needs you, and marks the summary as needing attention", async () => {
  const approving = await child(grantAll([approvalExtension]));
  await send(approving, "write");
  await approving.session("write").extension(approvalId).call("ask", {});
  const parent = await parentWith(
    {
      parent: [
        { agentId: "agent-approving", name: "Approving", sessionId: "write" },
      ],
    },
    { "agent-approving": childAccess(approving) },
  );
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "needs_you" })],
  });
  await settle(parent, "parent", { expanded: false });
  expect(
    subagentsClient.contribute?.(
      (await parent.session("parent").read()).extensions[subagentsContract.id],
    ).panel,
  ).toEqual([
    {
      id: "summary",
      title: "1 sub-agent · 1 needs you · /agents shows them",
      tone: "attention",
    },
  ]);
});

it("a routed child reads waiting on its parent, calm, and counts apart from needs you", async () => {
  const routed = await questionHost(
    { questions, mode: "continue" },
    {
      extensions: botanicalExtensionsWithSenderRouting(),
      sender: {
        agentId: "agent-parent",
        sessionId: "parent",
        name: "Shiitake",
      },
    },
  );
  closers.push(routed.host);
  await routed.park();
  const approving = await child(grantAll([approvalExtension]));
  await send(approving, "write");
  await approving.session("write").extension(approvalId).call("ask", {});
  const parent = await parentWith(
    {
      parent: [
        { agentId: "agent-scout", name: "Scout", sessionId: "questions" },
        { agentId: "agent-approving", name: "Approving", sessionId: "write" },
      ],
    },
    {
      "agent-scout": childAccess(routed.host),
      "agent-approving": childAccess(approving),
    },
  );
  await settle(parent, "parent", {
    agents: [
      {
        agentId: "agent-scout",
        name: "Scout",
        sessionId: "questions",
        state: "waiting_on_agent",
        attention: "Storage",
        waitingOn: "Shiitake",
        ask: {
          askId: mintedId,
          questions: [expect.objectContaining({ id: "storage" })],
        },
      },
      expect.objectContaining({
        agentId: "agent-approving",
        state: "needs_you",
      }),
    ],
  });
  const view = (await parent.session("parent").read()).extensions[
    subagentsContract.id
  ];
  await bindSessionExtension(parent.session("parent"), subagentsContract).call(
    "agents",
    {},
  );
  const expanded = Schema.decodeUnknownSync(clientContributionSchemaV1)(
    subagentsClient.contribute?.(
      (await parent.session("parent").read()).extensions[subagentsContract.id],
    ),
  );
  expect(expanded.panel[0]).toMatchObject({
    title: "Scout · waiting on Shiitake",
    detail: "Which store should hold the notes?",
    tone: "muted",
  });
  // A person may always answer first: the calm row offers Answer too, but it
  // never takes over the composer.
  expect(expanded.panel[0]?.actions).toMatchObject([
    { id: "answerChild", label: "Answer" },
  ]);
  expect(expanded.panel[0]?.actions?.[0]).not.toHaveProperty("awaiting");
  expect(expanded.panel[1]).toMatchObject({
    title: "Approving · needs you",
    tone: "attention",
  });
  // Collapsed, the calm child is named apart and only the person's item is amber.
  expect(subagentsClient.contribute?.(view).panel).toEqual([
    {
      id: "summary",
      title:
        "2 sub-agents · 1 waiting on Shiitake · 1 needs you · /agents shows them",
      tone: "attention",
    },
  ]);
});

it("a summary with only routed children is not amber", async () => {
  const routed = await questionHost(
    { questions, mode: "continue" },
    {
      extensions: botanicalExtensionsWithSenderRouting(),
      sender: {
        agentId: "agent-parent",
        sessionId: "parent",
        name: "Shiitake",
      },
    },
  );
  closers.push(routed.host);
  await routed.park();
  const parent = await parentWith(
    {
      parent: [
        { agentId: "agent-scout", name: "Scout", sessionId: "questions" },
      ],
    },
    { "agent-scout": childAccess(routed.host) },
  );
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "waiting_on_agent" })],
  });
  expect(
    subagentsClient.contribute?.(
      (await parent.session("parent").read()).extensions[subagentsContract.id],
    ).panel,
  ).toEqual([
    {
      id: "summary",
      title: "1 sub-agent · 1 waiting on Shiitake · /agents shows them",
      tone: "muted",
    },
  ]);
});

it("answers an escalated child's question from the parent's footer through the child's own answer flow", async () => {
  const asked = await questionHost();
  closers.push(asked.host);
  await asked.park();
  const parent = await parentWith(
    {
      parent: [
        { agentId: "agent-asked", name: "Asked", sessionId: "questions" },
      ],
    },
    { "agent-asked": childAccess(asked.host) },
  );
  await settle(parent, "parent", {
    agents: [expect.objectContaining({ state: "needs_you" })],
  });
  await bindSessionExtension(parent.session("parent"), subagentsContract).call(
    "agents",
    {},
  );
  const contribution = Schema.decodeUnknownSync(clientContributionSchemaV1)(
    subagentsClient.contribute?.(
      (await parent.session("parent").read()).extensions[subagentsContract.id],
    ),
  );
  const [panelRow] = contribution.panel;
  expect(panelRow).toMatchObject({
    title: "Asked · needs you",
    // The question itself is inline.
    detail: "Which store should hold the notes?",
    tone: "attention",
    // Needing the person, it takes over the composer as a decision.
    actions: [{ id: "answerChild", label: "Answer", awaiting: "question" }],
  });
  const action = panelRow?.actions?.[0];
  if (action?.input === undefined) throw new Error("Expected an Answer action");
  const answer = parent.session("parent").extension(subagentsContract.id);
  const step = Schema.decodeUnknownSync(CatalogStep)(
    await answer.call("answerChild", action.input),
  );
  if (step.type !== "prompt") throw new Error("Expected the first question");
  const prompt = step;
  expect(prompt.prompt).toMatchObject({
    type: "decision",
    summary: "Asked asks",
  });
  // The conversation keeps naming the child while the footer owns the draft.
  expect(prompt.next.arguments).toMatchObject({
    agentId: "agent-asked",
    sessionId: "questions",
  });
  await expect(
    answer.call("answerChild", {
      ...prompt.next.arguments,
      [prompt.next.answer]: { selected: ["SQLite"] },
    }),
  ).resolves.toMatchObject({
    type: "done",
    notice: { message: "Sending your answer to Asked." },
  });
  await vi.waitFor(
    async () => {
      const snapshot = await asked.host.session("questions").read();
      expect(snapshot.pending.prompts[0]?.text).toContain("SQLite");
      expect(snapshot.attention).toEqual([]);
    },
    { timeout: 5_000, interval: 10 },
  );
});
