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
import { sqliteOwner } from "./fixtures/host.js";

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
