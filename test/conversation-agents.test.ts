import {
  AgentCreateRefused,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import { afterEach, expect, it, vi } from "vitest";
import { goalContract } from "../src/goal/contract.js";
import { goalExtension } from "../src/goal/host.js";
import {
  assertOrdinaryAgentCreation,
  createConversationAgents,
  oysterAgentExtensions,
} from "../src/roster/conversation-agents.js";
import { botanicalAgentExtensions } from "../src/roster.js";
import { subagentsGrant } from "../src/subagents/host.js";
import { grantAll, openAgent, run, sqliteOwner } from "./fixtures/host.js";

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

it("bounds each live child-command tick to three owner reads, then stops at settlement", async () => {
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
              extension: () => ({
                call: () => Promise.reject(new Error("unused")),
              }),
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
    const childReads = vi.spyOn(childStore.owner.sql, "exec");
    expect(source.hasLiveChildCommand("parent")).toBe(true);
    expect(source.hasLiveChildCommand("not-parent")).toBe(false);
    await expect.poll(() => reads).toBe(1);
    expect(childReads.mock.calls.length).toBeLessThanOrEqual(3);
    expect(source.hasLiveChildCommand("parent")).toBe(true);
    childReads.mockClear();
    await expect.poll(() => reads, { timeout: 3_000 }).toBe(2);
    expect(childReads.mock.calls.length).toBeLessThanOrEqual(3);
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
        goal: false,
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

it("a sessionless send puts the recipient's new Session under a goal; goal:false and existing Sessions do not", async () => {
  const fixture = sqliteOwner();
  const childStore = sqliteOwner();
  const child = await openAgent(childStore.owner, grantAll([goalExtension]));
  try {
    const conversations = createConversationAgents(fixture.owner);
    // The recipient admits the send into its new Session, as delivery does.
    const accept: NonNullable<AgentControlDirectory["send"]> = async (task) => {
      const sessionId = `lane-${task.requestId}`;
      const admitted = await run(
        child.agent.session(sessionId).send(task.text, {
          requestId: task.requestId,
          delivery: "followUp",
        }),
      );
      return { ...admitted, sessionId };
    };
    const host = {
      ...directory(),
      send: accept,
      open: () =>
        Promise.resolve({
          agent: { session: (sessionId: string) => child.session(sessionId) },
          release: () => Promise.resolve(),
        }),
    };
    const recorded = conversations.recording("parent", host);
    const signal = new AbortController().signal;
    const objectiveOf = async (requestId: string) => {
      const session = child.session(`lane-${requestId}`);
      const view = bindSessionExtension(session, goalContract).view(
        await session.read(),
      );
      return view.status === "running"
        ? view.value?.goal?.objective
        : "stopped";
    };
    const base = {
      agentId: "child",
      text: "\nBuild the fern lane\nwith details",
      delivery: "followUp" as const,
    };
    await recorded.send({ ...base, requestId: "default" }, "parent", signal);
    await recorded.send(
      { ...base, requestId: "named", goal: "Ship the fern lane" },
      "parent",
      signal,
    );
    await recorded.send(
      { ...base, requestId: "quick", goal: false },
      "parent",
      signal,
    );
    expect(await objectiveOf("default")).toBe("Build the fern lane");
    expect(await objectiveOf("named")).toBe("Ship the fern lane");
    expect(await objectiveOf("quick")).toBeUndefined();
    // The goal adopts the send: the lane's own prompt is never repeated,
    // and its settlement starts the goal turns.
    await child.drain();
    const prompts = (await child.session("lane-named").read()).messages.flatMap(
      ({ value }) => {
        if (value.role !== "user") return [];
        const { content } = value;
        return Array.isArray(content)
          ? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [content];
      },
    );
    expect(prompts[0]).toBe(base.text);
    expect(prompts.filter((text) => text === "Ship the fern lane")).toEqual([]);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.slice(1).every((text) => text.startsWith("Goal turn"))).toBe(
      true,
    );
    await recorded.send(
      { ...base, requestId: "existing", sessionId: "lane-existing" },
      "parent",
      signal,
    );
    expect(await objectiveOf("existing")).toBeUndefined();
  } finally {
    await child.close();
    childStore.close();
    fixture.close();
  }
});
