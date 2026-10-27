import {
  AgentCreateRefused,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertOrdinaryAgentCreation,
  createConversationAgents,
  oysterAgentExtensions,
} from "../src/roster/conversation-agents.js";
import { botanicalAgentExtensions } from "../src/roster.js";
import { subagentsGrant } from "../src/subagents/host.js";
import { openAgent, run, sqliteOwner } from "./fixtures/host.js";

afterEach(() => vi.restoreAllMocks());

function directory(): AgentControlDirectory {
  return {
    list: () => Promise.resolve([{ agentId: "child", name: "Child" }]),
    create: () => Promise.resolve({ agentId: "child", name: "Child" }),
    send: () =>
      Promise.resolve({ status: "accepted", commandId: "accepted-work" }),
    open: () =>
      Promise.reject(
        new Error("This roster-only fixture does not open Agents"),
      ),
  };
}

it("composes lazily without touching host storage", () => {
  const fixture = sqliteOwner();
  try {
    const exec = vi.spyOn(fixture.owner.sql, "exec");
    createConversationAgents(fixture.owner);
    expect(exec).not.toHaveBeenCalled();
  } finally {
    fixture.close();
  }
});

it("records accepted create/send once and reads the same footer after reconstructing the roster", async () => {
  const fixture = sqliteOwner();
  try {
    const host = directory();
    const conversations = createConversationAgents(fixture.owner);
    const recorded = conversations.recording("parent", host);
    if (recorded.create === undefined || recorded.send === undefined)
      throw new Error("Expected the host's create and send doors");
    const signal = new AbortController().signal;
    await recorded.create({ requestId: "create" }, signal);
    await recorded.create({ requestId: "create" }, signal);
    expect(conversations.source(host).hasLiveChildCommand("parent")).toBe(
      false,
    );
    expect(await conversations.source(host).read("parent", 10)).toEqual({
      agents: [{ agentId: "child", name: "Child", sessionId: null }],
      more: 0,
    });
    await recorded.send(
      {
        agentId: "child",
        sessionId: "child-session",
        requestId: "child-work",
        text: "work",
        delivery: "followUp",
      },
      "parent",
      signal,
    );
    const reopened = createConversationAgents(fixture.owner).source(host);
    await expect.poll(() => reopened.hasLiveChildCommand("parent")).toBe(false);
    expect(reopened.hasLiveChildCommand("another-parent")).toBe(false);
    expect(await reopened.read("parent", 10)).toEqual({
      agents: [{ agentId: "child", name: "Child", sessionId: "child-session" }],
      more: 0,
    });
    expect(await reopened.read("another-parent", 10)).toEqual({
      agents: [],
      more: 0,
    });
    expect(reopened.open).toBe(host.open);
    expect(await reopened.read("parent", 0)).toEqual({ agents: [], more: 1 });
    const archived = { ...host, list: () => Promise.resolve([]) };
    expect(await conversations.source(archived).read("parent", 10)).toEqual({
      agents: [],
      more: 0,
    });
  } finally {
    fixture.close();
  }
});

it("does not record refused create or send operations", async () => {
  const fixture = sqliteOwner();
  try {
    const conversations = createConversationAgents(fixture.owner);
    const host: AgentControlDirectory = {
      ...directory(),
      create: () => Promise.reject(new Error("creation refused")),
      send: () => Promise.reject(new Error("send refused")),
    };
    const recorded = conversations.recording("parent", host);
    if (recorded.create === undefined || recorded.send === undefined)
      throw new Error("Expected the host's create and send doors");
    const signal = new AbortController().signal;
    await expect(
      recorded.create({ requestId: "create" }, signal),
    ).rejects.toThrow("creation refused");
    await expect(
      recorded.send(
        {
          agentId: "child",
          sessionId: "child-session",
          requestId: "child-work",
          text: "work",
          delivery: "followUp",
        },
        "parent",
        signal,
      ),
    ).rejects.toThrow("send refused");
    expect(await conversations.source(host).read("parent", 10)).toEqual({
      agents: [],
      more: 0,
    });
  } finally {
    fixture.close();
  }
});

it("does not count relay-held mail as accepted delegated work", async () => {
  const fixture = sqliteOwner();
  try {
    const conversations = createConversationAgents(fixture.owner);
    const host: AgentControlDirectory = {
      ...directory(),
      send: () =>
        Promise.resolve({
          status: "held",
          reason: "recipient_offline",
          message: "waiting: recipient offline",
        }),
    };
    const recorded = conversations.recording("parent", host);
    if (recorded.send === undefined) throw new Error("Expected send door");
    await recorded.send(
      {
        agentId: "child",
        requestId: "held-work",
        text: "work",
        delivery: "followUp",
      },
      "parent",
      new AbortController().signal,
    );
    expect(conversations.source(host).hasLiveChildCommand("parent")).toBe(
      false,
    );
  } finally {
    fixture.close();
  }
});

it("tracks a recorded child command only until its owner's settlement is visible", async () => {
  const fixture = sqliteOwner();
  const childStore = sqliteOwner();
  const child = await openAgent(childStore.owner, {
    roster: [],
    grants: [],
  });
  try {
    const accepted = await run(
      child.agent.session("child-session").send("work", {
        requestId: "child-work",
        delivery: "followUp",
      }),
    );
    const host: AgentControlDirectory = {
      ...directory(),
      send: () => Promise.resolve(accepted),
    };
    const conversations = createConversationAgents(fixture.owner);
    let reads = 0;
    const source = conversations.source({
      list: host.list,
      open: () =>
        Promise.resolve({
          agent: {
            listSessions: () => run(child.agent.listSessions()),
            session: () => ({
              read: (options) =>
                run(child.agent.session("child-session").read(options)),
              readSettlement: (commandId, options) => {
                return run(
                  child.agent
                    .session("child-session")
                    .readSettlement(commandId, options?.timeoutMs),
                ).then((settlement) => {
                  reads += 1;
                  return settlement;
                });
              },
            }),
          },
          release: () => Promise.resolve(),
        }),
    });
    const recorded = conversations.recording("parent", host);
    if (recorded.send === undefined) throw new Error("Expected send door");
    await recorded.send(
      {
        agentId: "child",
        sessionId: "child-session",
        requestId: "child-work",
        text: "work",
        delivery: "followUp",
      },
      "parent",
      new AbortController().signal,
    );
    expect(source.hasLiveChildCommand("parent")).toBe(true);
    expect(source.hasLiveChildCommand("not-parent")).toBe(false);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
    expect(source.hasLiveChildCommand("parent")).toBe(true);
    await child.drain();
    await expect
      .poll(() => source.hasLiveChildCommand("parent"), { timeout: 7_000 })
      .toBe(false);
  } finally {
    await child.close();
    childStore.close();
    fixture.close();
  }
}, 10_000);

it("uses the recipient's admitted Session when a delegated send omits one", async () => {
  const fixture = sqliteOwner();
  try {
    const conversations = createConversationAgents(fixture.owner);
    const host: AgentControlDirectory = {
      ...directory(),
      send: () =>
        Promise.resolve({
          status: "accepted",
          commandId: "first-command",
          sessionId: "recipient-session",
        }),
    };
    const recorded = conversations.recording("parent", host);
    if (recorded.send === undefined) throw new Error("Expected send door");
    await recorded.send(
      {
        agentId: "child",
        requestId: "first-send",
        text: "work",
        delivery: "followUp",
      },
      "parent",
      new AbortController().signal,
    );
    const source = conversations.source(host);
    await expect.poll(() => source.hasLiveChildCommand("parent")).toBe(false);
    expect(await source.read("parent", 1)).toEqual({
      agents: [
        { agentId: "child", name: "Child", sessionId: "recipient-session" },
      ],
      more: 0,
    });
  } finally {
    fixture.close();
  }
});

it("retains ordinary creation admission and the base roster plus subagent grant", () => {
  expect(() => {
    assertOrdinaryAgentCreation({
      requestId: "allowed",
      extensions: botanicalAgentExtensions.grants.map(({ id }) => id),
    });
  }).not.toThrow();
  expect(() => {
    assertOrdinaryAgentCreation({
      requestId: "denied",
      extensions: ["unheld-extension"],
    });
  }).toThrow(AgentCreateRefused);
  const host = directory();
  const fixture = sqliteOwner();
  try {
    const extensions = oysterAgentExtensions(
      createConversationAgents(fixture.owner).source(host),
    );
    expect(extensions.roster).toHaveLength(
      botanicalAgentExtensions.roster.length + 1,
    );
    expect(extensions.grants).toEqual([
      ...botanicalAgentExtensions.grants,
      subagentsGrant,
    ]);
  } finally {
    fixture.close();
  }
});
