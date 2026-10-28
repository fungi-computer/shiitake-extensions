import type { SandboxValue } from "@fungi.computer/mycelium";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  botanicalAgentExtensions,
  botanicalExtensionsWithSenderRouting,
} from "../src/roster.js";
import { openAgent, sqliteOwner } from "./fixtures/host.js";
import { questionHost, questions, mintedId } from "./fixtures/ask.js";

afterEach(() => vi.useRealTimers());

const scout = {
  agentId: "agent-shiitake",
  sessionId: "session-shiitake",
  name: "Shiitake",
};
const questionId = "botanical-session-question";

function questionOf(host: Awaited<ReturnType<typeof questionHost>>["host"]) {
  return host.session("questions").extension(questionId);
}

it("a mail-sent run's ask waits on its sender and parks", async () => {
  const fixture = await questionHost(
    { questions, mode: "wait" },
    { extensions: botanicalExtensionsWithSenderRouting(), sender: scout },
  );
  const { store, host } = fixture;
  try {
    const { askId } = await fixture.park();
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([
      expect.objectContaining({
        id: askId,
        kind: "question",
        inbox: false,
        waitingOn: scout,
      }),
    ]);
    await expect(questionOf(host).call("list", {})).resolves.toEqual({
      asks: [
        expect.objectContaining({
          askId,
          status: "parked",
          waitingOn: scout,
        }),
      ],
    });
    // The child's turn settles with the item named in its reply to the sender.
    expect(fixture.settlements).toEqual([
      expect.objectContaining({
        waitingOnYou: [{ itemId: askId, kind: "question", summary: "Storage" }],
      }),
    ]);
  } finally {
    await host.close();
    store.close();
  }
});

it("a person-sent run's ask still needs you", async () => {
  const fixture = await questionHost(
    { questions, mode: "continue" },
    { extensions: botanicalExtensionsWithSenderRouting() },
  );
  const { store, host } = fixture;
  try {
    const { askId } = await fixture.park();
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([
      expect.objectContaining({ id: askId, kind: "question" }),
    ]);
    expect(snapshot.attention[0]).not.toHaveProperty("waitingOn");
    expect(snapshot.attention[0]).not.toHaveProperty("inbox");
    expect(fixture.settlements).toEqual([]);
  } finally {
    await host.close();
    store.close();
  }
});

it("the shared roster sends a mail-sent run's ask to a person", async () => {
  const fixture = await questionHost(
    { questions, mode: "continue" },
    { sender: scout },
  );
  const { store, host } = fixture;
  try {
    await fixture.park();
    const [item] = (await host.session("questions").read()).attention;
    expect(item).not.toHaveProperty("waitingOn");
    expect(item).not.toHaveProperty("inbox");
  } finally {
    await host.close();
    store.close();
  }
});

it("answers a routed Ask only as the Agent Session it waits on, attributed in the reply", async () => {
  const fixture = await questionHost(
    { questions, mode: "continue" },
    { extensions: botanicalExtensionsWithSenderRouting(), sender: scout },
  );
  const { store, host } = fixture;
  let reopened = host;
  try {
    const { askId } = await fixture.park();
    const input = {
      askId,
      requestId: "agent-answer-1",
      answers: { storage: { selected: ["SQLite"], text: "Keep it local." } },
    };
    await expect(questionOf(host).call("answerAgent", input)).rejects.toThrow(
      "authenticated Agent",
    );
    const imposter = { agentId: "agent-other", sessionId: scout.sessionId };
    await expect(
      questionOf(host).call("answerAgent", input, imposter),
    ).resolves.toMatchObject({
      result: { result: "refused", reason: "not_sender" },
    });
    await expect(questionOf(host).call("list", {})).resolves.toMatchObject({
      asks: [{ askId, status: "parked" }],
    });
    const sender = { agentId: scout.agentId, sessionId: scout.sessionId };
    const accepted = {
      result: {
        result: "accepted",
        via: "follow_up",
        commandId: mintedId,
      },
      answeredBy: { kind: "agent", agentId: scout.agentId },
    };
    await expect(
      questionOf(host).call("answerAgent", input, sender),
    ).resolves.toEqual(accepted);
    await host.close();
    reopened = await openAgent(
      store.owner,
      botanicalExtensionsWithSenderRouting(),
    );
    await expect(
      questionOf(reopened).call("answerAgent", input, sender),
    ).resolves.toEqual(accepted);
    await expect(
      questionOf(reopened).call(
        "answerAgent",
        { ...input, answers: { storage: { selected: ["PostgreSQL"] } } },
        sender,
      ),
    ).rejects.toThrow("used for a different response");
    const snapshot = await reopened.session("questions").read();
    expect(snapshot.attention).toEqual([]);
    expect(snapshot.pending.prompts[0]?.text).toContain(
      `Answer from Agent ${scout.agentId} to ask ${askId}:`,
    );
  } finally {
    await reopened.close();
    store.close();
  }
});

it("a person may always answer a routed Ask", async () => {
  const fixture = await questionHost(
    { questions, mode: "continue" },
    { extensions: botanicalExtensionsWithSenderRouting(), sender: scout },
  );
  const { store, host } = fixture;
  try {
    const { askId } = await fixture.park();
    await expect(
      questionOf(host).call("answer", {
        askId,
        requestId: "person-answers-routed",
        answers: { storage: { selected: ["SQLite"] } },
      }),
    ).resolves.toMatchObject({
      result: "accepted",
      via: "follow_up",
      commandId: mintedId,
    });
  } finally {
    await host.close();
    store.close();
  }
});

it("escalation from the Agent a routed Ask waits on makes the child need you", async () => {
  const fixture = await questionHost(
    { questions, mode: "continue" },
    { extensions: botanicalExtensionsWithSenderRouting(), sender: scout },
  );
  const { store, host } = fixture;
  try {
    const { askId } = await fixture.park();
    const sender = { agentId: scout.agentId, sessionId: scout.sessionId };
    await expect(
      questionOf(host).call(
        "escalateAgent",
        { askId },
        { agentId: "agent-other", sessionId: scout.sessionId },
      ),
    ).resolves.toEqual({ result: "refused", reason: "not_sender" });
    expect((await host.session("questions").read()).attention[0]).toMatchObject(
      { inbox: false, waitingOn: scout },
    );
    await expect(
      questionOf(host).call("escalateAgent", { askId }, sender),
    ).resolves.toEqual({ result: "escalated", to: "person" });
    const [item] = (await host.session("questions").read()).attention;
    expect(item).toMatchObject({ id: askId, kind: "question" });
    expect(item).not.toHaveProperty("waitingOn");
    expect(item).not.toHaveProperty("inbox");
    // It no longer waits on the Agent, which can neither answer nor escalate again.
    await expect(
      questionOf(host).call(
        "answerAgent",
        {
          askId,
          requestId: "late-agent-answer",
          answers: { storage: { selected: ["SQLite"] } },
        },
        sender,
      ),
    ).resolves.toMatchObject({
      result: { result: "refused", reason: "not_sender" },
    });
    await expect(
      questionOf(host).call("answer", {
        askId,
        requestId: "person-answers-escalated",
        answers: { storage: { selected: ["PostgreSQL"] } },
      }),
    ).resolves.toMatchObject({ result: "accepted" });
  } finally {
    await host.close();
    store.close();
  }
});

it("a routed ask nobody answers goes to a person at its backstop", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const createdAt = Date.parse("2026-10-27T12:00:00Z");
  vi.setSystemTime(createdAt);
  const fixture = await questionHost(
    { questions, mode: "continue" },
    { extensions: botanicalExtensionsWithSenderRouting(), sender: scout },
  );
  const { store, host } = fixture;
  try {
    const { askId } = await fixture.park();
    // The backstop is core's own timer, not an expiry the asker chose.
    expect(
      (await host.session("questions").read()).attention[0],
    ).not.toHaveProperty("expiresAt");
    const expiresAt = createdAt + 900_000;
    vi.setSystemTime(expiresAt - 1);
    await host.reconcile();
    expect((await host.session("questions").read()).attention[0]).toMatchObject(
      { waitingOn: scout },
    );
    vi.setSystemTime(expiresAt);
    await host.reconcile();
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([
      expect.objectContaining({ id: askId, kind: "question" }),
    ]);
    expect(snapshot.attention[0]).not.toHaveProperty("waitingOn");
    expect(snapshot.attention[0]).not.toHaveProperty("expiresAt");
    // The default never stood in for a decision: the ask is still open.
    expect(snapshot.pending.prompts).toEqual([]);
    await expect(questionOf(host).call("list", {})).resolves.toMatchObject({
      asks: [{ askId, status: "parked" }],
    });
  } finally {
    await host.close();
    store.close();
  }
});

it("an escalated routed ask stays open for the person past the backstop", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const createdAt = Date.parse("2026-10-27T12:00:00Z");
  vi.setSystemTime(createdAt);
  const fixture = await questionHost(
    { questions, mode: "continue" },
    { extensions: botanicalExtensionsWithSenderRouting(), sender: scout },
  );
  const { store, host } = fixture;
  try {
    const { askId } = await fixture.park();
    await expect(
      questionOf(host).call(
        "escalateAgent",
        { askId },
        { agentId: scout.agentId, sessionId: scout.sessionId },
      ),
    ).resolves.toEqual({ result: "escalated", to: "person" });
    vi.setSystemTime(createdAt + 900_000 * 4);
    await host.reconcile();
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([
      expect.objectContaining({ id: askId, kind: "question" }),
    ]);
    // Nothing answered for the person: no expiry, no default, no follow-up.
    expect(snapshot.pending.prompts).toEqual([]);
    await expect(questionOf(host).call("list", {})).resolves.toMatchObject({
      asks: [{ askId, status: "parked" }],
    });
  } finally {
    await host.close();
    store.close();
  }
});

it("a routed ask with a long asker expiry still reaches a person at the backstop", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const createdAt = Date.parse("2026-10-27T12:00:00Z");
  vi.setSystemTime(createdAt);
  const fixture = await questionHost(
    {
      questions,
      mode: "continue",
      onExpire: { afterMinutes: 600, action: "proceed_with_recommended" },
    },
    { extensions: botanicalExtensionsWithSenderRouting(), sender: scout },
  );
  const { store, host } = fixture;
  try {
    const { askId } = await fixture.park();
    vi.setSystemTime(createdAt + 900_000);
    await host.reconcile();
    const [item] = (await host.session("questions").read()).attention;
    expect(item).toMatchObject({ id: askId, kind: "question" });
    expect(item).not.toHaveProperty("waitingOn");
  } finally {
    await host.close();
    store.close();
  }
});

it("parks a question through the ordinary roster and retains its attention and projection after reopen", async () => {
  const fixture = await questionHost();
  const { store } = fixture;
  let host = fixture.host;
  try {
    const parked = await fixture.park();
    const before = await host.session("questions").read();
    expect(before.attention).toEqual([
      expect.objectContaining({
        extensionId: "botanical-session-question",
        id: parked.askId,
        kind: "question",
      }),
    ]);
    expect(before.extensions["botanical-session-question"]).toMatchObject({
      status: "running",
      value: { asks: [{ askId: parked.askId, questions, status: "parked" }] },
    });
    await host.close();
    host = await openAgent(store.owner, botanicalAgentExtensions);
    const reopened = await host.session("questions").read();
    expect(reopened.attention).toEqual(before.attention);
    expect(reopened.extensions["botanical-session-question"]).toEqual(
      before.extensions["botanical-session-question"],
    );
  } finally {
    await host.close();
    store.close();
  }
});

it("recovers a live question after process loss without asking twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ask-restart-"));
  const path = join(directory, "owner.sqlite");
  const first = await questionHost({ questions });
  let { host, store } = first;
  let running: Promise<void> | undefined;
  try {
    await Effect.runPromise(
      host.agent.session("questions").send("Choose storage", {
        requestId: "restart-storage",
        delivery: "followUp",
      }),
    );
    running = host.reconcile();
    await expect
      .poll(() =>
        host
          .session("questions")
          .extension("botanical-session-question")
          .call("list", {}),
      )
      .toMatchObject({ asks: [{ status: "live" }] });
    const attention = (await host.session("questions").read()).attention;
    const askId = attention[0]?.id;
    if (askId === undefined) throw new Error("Expected a live question");
    store.copyTo(path);
    // Cleanup affects the original owner only; the copy retains the interrupted run.
    await Effect.runPromise(host.agent.session("questions").abort);
    await running;
    await host.close();
    store.close();
    store = sqliteOwner(path);
    const restored = await questionHost({ questions }, { store });
    host = restored.host;
    running = host.drain();
    await expect.poll(restored.result).toEqual({ status: "parked", askId });
    await running;
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual(attention);
    expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
      status: "running",
      value: { asks: [{ askId, status: "parked" }] },
    });
    const command = host
      .session("questions")
      .extension("botanical-session-question");
    expect(
      await command.call("answer", {
        askId,
        requestId: "answer-restored",
        answers: { storage: { selected: ["SQLite"] } },
      }),
    ).toEqual({
      result: "accepted",
      via: "follow_up",
      commandId: mintedId,
    });
    const pending = (await host.session("questions").read()).pending.prompts;
    expect(pending).toHaveLength(1);
    await host.close();
    host = await openAgent(store.owner, botanicalAgentExtensions);
    await host.drain();
    const settled = await host.session("questions").read();
    expect(
      settled.messages.filter(
        ({ value }) =>
          value.role === "user" && value.content === pending[0]?.text,
      ),
    ).toHaveLength(1);
    expect(settled.attention).toEqual([]);
  } finally {
    await Effect.runPromise(host.agent.session("questions").abort);
    await running;
    await host.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

it.each(["reask", "settlement", "refused settlement"] as const)(
  "delivers an answer committed before process loss exactly once through %s",
  async (recovery) => {
    const directory = mkdtempSync(join(tmpdir(), "ask-answer-restart-"));
    const path = join(directory, "owner.sqlite");
    const first = await questionHost({ questions });
    let { host, store } = first;
    let running: Promise<void> | undefined;
    try {
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "answer-before-restart",
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      await expect
        .poll(() =>
          host
            .session("questions")
            .extension("botanical-session-question")
            .call("list", {}),
        )
        .toMatchObject({ asks: [{ status: "live" }] });
      const askId = (await host.session("questions").read()).attention[0]?.id;
      if (askId === undefined) throw new Error("Expected a live question");
      const answer = {
        askId,
        requestId: "committed-answer",
        answers: { storage: { selected: ["SQLite"], text: "Keep it local." } },
      };
      const call = () =>
        host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", answer);
      const accepted = { result: "accepted", via: "in_turn" };
      expect(await call()).toEqual(accepted);
      expect(first.result()).toBeUndefined();
      if (recovery === "refused settlement")
        await Effect.runPromise(
          host.agent.session("questions").send("Conflicting follow-up", {
            requestId: `ask:${askId}`,
            delivery: "followUp",
          }),
        );
      store.copyTo(path);
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
      store = sqliteOwner(path);
      const restored =
        recovery === "reask"
          ? await questionHost({ questions }, { store })
          : undefined;
      host =
        restored?.host ??
        (await openAgent(store.owner, botanicalAgentExtensions));
      await host.drain();
      if (restored !== undefined)
        expect(restored.result()).toEqual({
          status: "answered",
          answers: answer.answers,
        });
      const expectedFollowUps = recovery === "reask" ? 0 : 1;
      const assertDelivery = async () => {
        const snapshot = await host.session("questions").read();
        expect(snapshot.attention).toEqual([]);
        expect(snapshot.pending.prompts).toEqual([]);
        expect(snapshot.extensions["botanical-session-question"]).toMatchObject(
          {
            status: "running",
            value: { asks: [] },
          },
        );
        const prompts = snapshot.messages.flatMap(({ value }) =>
          value.role === "user" ? [value] : [],
        );
        expect(prompts).toHaveLength(1 + expectedFollowUps);
        if (expectedFollowUps === 1)
          expect(prompts[1]?.content).toEqual(
            expect.stringContaining(
              recovery === "refused settlement"
                ? "Conflicting follow-up"
                : `Answer to ask ${askId}:`,
            ),
          );
        expect(await call()).toEqual(accepted);
        if (recovery === "refused settlement")
          expect(
            await host
              .session("questions")
              .extension("botanical-session-question")
              .call("answer", {
                ...answer,
                requestId: "new-attempt-after-refusal",
              }),
          ).toEqual({ result: "closed", status: "undeliverable" });
      };
      await assertDelivery();
      await host.close();
      host = await openAgent(store.owner, botanicalAgentExtensions);
      await host.drain();
      await assertDelivery();
    } finally {
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
      rmSync(directory, { recursive: true });
    }
  },
);

it.each(["reask", "settlement"] as const)(
  "recovers a consumed answer before tool-result commit through %s",
  async (recovery) => {
    const directory = mkdtempSync(join(tmpdir(), "ask-consumed-restart-"));
    const path = join(directory, "owner.sqlite");
    const release = Deferred.makeUnsafe<undefined>();
    const first = await questionHost(
      { questions },
      { afterResult: () => Effect.runPromise(Deferred.await(release)) },
    );
    let { host, store } = first;
    let running: Promise<void> | undefined;
    try {
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "consumed-before-restart",
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      await expect
        .poll(() =>
          host
            .session("questions")
            .extension("botanical-session-question")
            .call("list", {}),
        )
        .toMatchObject({ asks: [{ status: "live" }] });
      const askId = (await host.session("questions").read()).attention[0]?.id;
      if (askId === undefined) throw new Error("Expected a live question");
      const answer = {
        askId,
        requestId: "consumed-answer",
        answers: { storage: { selected: ["SQLite"] } },
      };
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", answer),
      ).toEqual({ result: "accepted", via: "in_turn" });
      const result = { status: "answered", answers: answer.answers };
      await expect.poll(first.result).toEqual(result);
      store.copyTo(path);
      Effect.runSync(Deferred.succeed(release, undefined));
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
      store = sqliteOwner(path);
      const restored =
        recovery === "reask"
          ? await questionHost({ questions }, { store })
          : undefined;
      host =
        restored?.host ??
        (await openAgent(store.owner, botanicalAgentExtensions));
      running = host.drain();
      if (restored !== undefined)
        await expect.poll(restored.result).toEqual(result);
      await running;
      const snapshot = await host.session("questions").read();
      expect(snapshot.attention).toEqual([]);
      expect(snapshot.pending.prompts).toEqual([]);
      expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
        status: "running",
        value: { asks: [] },
      });
      expect(
        snapshot.messages.filter(({ value }) => value.role === "user"),
      ).toHaveLength(recovery === "reask" ? 1 : 2);
      if (recovery === "settlement")
        expect(
          snapshot.messages.filter(({ value }) => value.role === "user")[1]
            ?.value.content,
        ).toContain(`Answer to ask ${askId}:`);
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", answer),
      ).toEqual({ result: "accepted", via: "in_turn" });
    } finally {
      Effect.runSync(Deferred.succeed(release, undefined));
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
      rmSync(directory, { recursive: true });
    }
  },
);

it.each(["stop", "proceed_with_recommended"] as const)(
  "expires a parked question after reopen with one explicit %s follow-up",
  async (action) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const createdAt = Date.parse("2026-10-08T12:00:00Z");
    const expiresAt = createdAt + 5 * 60_000;
    vi.setSystemTime(createdAt);
    const fixture = await questionHost({
      questions,
      mode: "continue",
      onExpire: { afterMinutes: 5, action },
    });
    const { store } = fixture;
    let { host } = fixture;
    try {
      const parked = await fixture.park();
      expect((await host.session("questions").read()).attention).toEqual([
        expect.objectContaining({
          id: parked.askId,
          since: createdAt,
          expiresAt,
        }),
      ]);
      await host.close();
      host = await openAgent(store.owner, botanicalAgentExtensions);
      vi.setSystemTime(expiresAt - 1);
      await host.drain();
      expect((await host.session("questions").read()).attention).toHaveLength(
        1,
      );
      vi.setSystemTime(expiresAt);
      await host.reconcile();
      const expired = await host.session("questions").read();
      expect(expired.attention).toEqual([]);
      expect(expired.pending.prompts).toHaveLength(1);
      const followUp = expired.pending.prompts[0]?.text;
      expect(followUp).toContain(questions[0]?.question);
      expect(followUp).toEqual(expect.stringContaining("expired"));
      expect(followUp).toEqual(
        expect.stringContaining(
          action === "stop" ? "do not proceed" : "recommended default",
        ),
      );
      if (action === "proceed_with_recommended")
        expect(followUp).toEqual(expect.stringContaining("SQLite"));
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", {
            askId: parked.askId,
            requestId: "answer-after-expiry",
            answers: { storage: { selected: ["SQLite"] } },
          }),
      ).toEqual({ result: "closed", status: "expired" });
      await host.drain();
      await host.close();
      host = await openAgent(store.owner, botanicalAgentExtensions);
      await host.drain();
      const settled = await host.session("questions").read();
      expect(settled.attention).toEqual([]);
      expect(settled.pending.prompts).toEqual([]);
      expect(
        settled.messages.filter(
          ({ value }) => value.role === "user" && value.content === followUp,
        ),
      ).toHaveLength(1);
    } finally {
      await host.close();
      store.close();
    }
  },
);

it.each(["stop", "proceed_with_recommended"] as const)(
  "expires a live question in-turn with %s while its serial tick is still held",
  async (action) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const createdAt = Date.parse("2026-10-08T13:00:00Z");
    vi.setSystemTime(createdAt);
    const fixture = await questionHost(
      {
        questions: questions.map((question) => ({
          ...question,
          multiple: true,
        })),
        onExpire: { afterMinutes: 5, action },
      },
      { timeoutMs: 900_000 },
    );
    const { host, store } = fixture;
    let running: Promise<void> | undefined;
    try {
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "live-expiry",
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      await expect
        .poll(() =>
          host
            .session("questions")
            .extension("botanical-session-question")
            .call("list", {}),
        )
        .toMatchObject({
          asks: [{ status: "live" }],
        });
      const attention = (await host.session("questions").read()).attention[0];
      if (attention?.expiresAt === undefined)
        throw new Error("Expected a live question with expiry");
      const askId = attention.id;
      expect(attention.expiresAt - attention.since).toBe(300_000);
      vi.setSystemTime(attention.expiresAt);
      await expect.poll(fixture.result, { timeout: 3_000 }).toEqual(
        action === "stop"
          ? { status: "expired", action: "stop" }
          : {
              status: "expired",
              action: "proceed_with_recommended",
              answers: { storage: { selected: ["SQLite"] } },
            },
      );
      await running;
      const snapshot = await host.session("questions").read();
      expect(snapshot.attention).toEqual([]);
      expect(snapshot.pending.prompts).toEqual([]);
      expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
        status: "running",
        value: { asks: [] },
      });
      expect(
        snapshot.messages.filter(({ value }) => value.role === "user"),
      ).toHaveLength(1);
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", {
            askId,
            requestId: "late-live-answer",
            answers: { storage: { selected: ["SQLite"] } },
          }),
      ).toEqual({ result: "closed", status: "expired" });
    } finally {
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
    }
  },
  10_000,
);

it("cancelling a run closes both its live and parked questions without a follow-up", async () => {
  const fixture = await questionHost(
    { questions },
    {
      priorInput: {
        questions: questions.map((question) => ({
          ...question,
          question: "Which store should hold the archive?",
        })),
        mode: "continue",
      },
    },
  );
  const { host, store } = fixture;
  const session = host.agent.session("questions");
  const commands = host
    .session("questions")
    .extension("botanical-session-question");
  let running: Promise<void> | undefined;
  try {
    await Effect.runPromise(
      session.send("Choose storage", {
        requestId: "cancel-questions",
        delivery: "followUp",
      }),
    );
    running = host.reconcile();
    await expect
      .poll(async () => {
        const list = z
          .object({ asks: z.array(z.object({ status: z.string() })) })
          .parse(await commands.call("list", {}));
        return list.asks.map((ask) => ask.status).sort();
      })
      .toEqual(["live", "parked"]);
    const items = (await host.session("questions").read()).attention;
    expect(items).toHaveLength(2);
    await Effect.runPromise(session.abort);
    await running;
    await host.drain();
    await Effect.runPromise(session.abort);
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([]);
    expect(snapshot.pending.prompts).toEqual([]);
    expect(fixture.result()).toBeUndefined();
    expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
      status: "running",
      value: { asks: [] },
    });
    for (const item of items) {
      expect(
        await commands.call("answer", {
          askId: item.id,
          requestId: `after-cancel:${item.id}`,
          answers: { storage: { selected: ["SQLite"] } },
        }),
      ).toEqual({ result: "closed", status: "cancelled" });
    }
  } finally {
    await Effect.runPromise(session.abort);
    await running;
    await host.close();
    store.close();
  }
});

it("answers a parked question once and replays the accepted result after restart", async () => {
  const fixture = await questionHost();
  const { store } = fixture;
  let host = fixture.host;
  try {
    const parked = await fixture.park();
    const answer = {
      askId: parked.askId,
      requestId: "answer-storage",
      answers: { storage: { selected: ["SQLite"], text: "Keep it local." } },
    };
    const call = (input: typeof answer) =>
      host
        .session("questions")
        .extension("botanical-session-question")
        .call("answer", input);
    const accepted = {
      result: "accepted",
      via: "follow_up",
      commandId: mintedId,
    };
    expect(await call(answer)).toEqual(accepted);
    expect(await call(answer)).toEqual(accepted);
    await expect(
      call({
        ...answer,
        answers: {
          storage: { selected: ["PostgreSQL"], text: "Keep it local." },
        },
      }),
    ).rejects.toMatchObject({ boundary: "store", cause: "conflict" });
    expect(await call({ ...answer, requestId: "another-answer" })).toEqual({
      result: "closed",
      status: "answered",
    });
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([]);
    expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
      status: "running",
      value: { asks: [] },
    });
    expect(snapshot.pending.prompts).toHaveLength(1);
    const prompt = snapshot.pending.prompts[0];
    expect(prompt?.delivery).toBe("followUp");
    expect(prompt?.text).toContain(questions[0]?.question);
    expect(prompt?.text).toContain("SQLite");
    expect(prompt?.text).toContain("Keep it local.");
    await host.close();
    host = await openAgent(store.owner, botanicalAgentExtensions);
    expect(await call(answer)).toEqual(accepted);
    await host.drain();
    expect(await call(answer)).toEqual(accepted);
    const settled = await host.session("questions").read();
    expect(
      settled.messages.filter(
        ({ value }) => value.role === "user" && value.content === prompt?.text,
      ),
    ).toHaveLength(1);
    expect(settled.pending.prompts).toEqual([]);
    expect(settled.attention).toEqual([]);
  } finally {
    await host.close();
    store.close();
  }
});

it("declines a parked question once, preserving the question and note in its follow-up", async () => {
  const fixture = await questionHost();
  const { host, store } = fixture;
  try {
    const parked = await fixture.park();
    const decline = {
      askId: parked.askId,
      requestId: "decline-storage",
      note: "I cannot choose yet; leave storage unchanged.",
    };
    const commands = host
      .session("questions")
      .extension("botanical-session-question");
    const accepted = {
      result: "accepted",
      via: "follow_up",
      commandId: mintedId,
    };
    expect(await commands.call("decline", decline)).toEqual(accepted);
    expect(await commands.call("decline", decline)).toEqual(accepted);
    await expect(
      commands.call("decline", { ...decline, note: "Different response" }),
    ).rejects.toMatchObject({ boundary: "store", cause: "conflict" });
    expect(
      await commands.call("answer", {
        askId: parked.askId,
        requestId: "answer-after-decline",
        answers: { storage: { selected: ["SQLite"] } },
      }),
    ).toEqual({ result: "closed", status: "declined" });
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([]);
    expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
      status: "running",
      value: { asks: [] },
    });
    expect(snapshot.pending.prompts).toHaveLength(1);
    expect(snapshot.pending.prompts[0]?.text).toContain("Declined");
    expect(snapshot.pending.prompts[0]?.text).toContain(questions[0]?.question);
    expect(snapshot.pending.prompts[0]?.text).toContain(decline.note);
    expect(snapshot.pending.prompts[0]?.delivery).toBe("followUp");
  } finally {
    await host.close();
    store.close();
  }
});

it("delivers an answer to the live waiting tool without admitting a follow-up", async () => {
  const fixture = await questionHost({ questions });
  const { host, store } = fixture;
  const session = host.agent.session("questions");
  const commands = host
    .session("questions")
    .extension("botanical-session-question");
  let running: Promise<void> | undefined;
  try {
    await Effect.runPromise(
      session.send("Choose storage", {
        requestId: "live-storage",
        delivery: "followUp",
      }),
    );
    running = host.reconcile();
    await expect
      .poll(() => commands.call("list", {}))
      .toMatchObject({
        asks: [{ status: "live" }],
      });
    expect(fixture.result()).toBeUndefined();
    const item = (await host.session("questions").read()).attention[0];
    if (item === undefined) throw new Error("Live question has no attention");
    const answer = {
      askId: item.id,
      requestId: "answer-live-storage",
      answers: { storage: { selected: ["SQLite"], text: "Keep it local." } },
    };
    expect(await commands.call("answer", answer)).toEqual({
      result: "accepted",
      via: "in_turn",
    });
    expect((await host.session("questions").read()).attention).toEqual([]);
    await running;
    expect(fixture.result()).toEqual({
      status: "answered",
      answers: answer.answers,
    });
    expect(await commands.call("answer", answer)).toEqual({
      result: "accepted",
      via: "in_turn",
    });
    const snapshot = await host.session("questions").read();
    expect(snapshot.pending.prompts).toEqual([]);
    expect(
      snapshot.messages.filter(({ value }) => value.role === "user"),
    ).toHaveLength(1);
    expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
      status: "running",
      value: { asks: [] },
    });
  } finally {
    await Effect.runPromise(session.abort);
    await running;
    await host.close();
    store.close();
  }
});

it("replays the withdrawn outcome when the same work re-asks a parked question", async () => {
  const fixture = await questionHost(undefined, {
    program: async (bindings) => {
      const ask = bindings.question?.ask;
      const withdraw = bindings.question?.withdraw;
      if (ask === undefined || withdraw === undefined)
        throw new Error("Missing Ask operations");
      const input = { questions, mode: "continue" };
      const parked = z.object({ askId: z.string() }).parse(await ask(input));
      expect(await withdraw({ askId: parked.askId })).toEqual({
        result: "closed",
        status: "withdrawn",
      });
      return ask(input);
    },
  });
  const { host, store } = fixture;
  try {
    await Effect.runPromise(
      host.agent.session("questions").send("Choose storage", {
        requestId: "reask-withdrawn",
        delivery: "followUp",
      }),
    );
    await host.drain();
    expect(fixture.result()).toEqual({ status: "withdrawn" });
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([]);
    expect(snapshot.pending.prompts).toEqual([]);
    expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
      value: { asks: [] },
    });
  } finally {
    await host.close();
    store.close();
  }
});

it("replays the closed outcome when the same work re-asks after an undeliverable follow-up", async () => {
  const retry = Deferred.makeUnsafe<undefined>();
  const fixture = await questionHost(undefined, {
    program: async (bindings) => {
      const ask = bindings.question?.ask;
      if (ask === undefined) throw new Error("Missing Ask operation");
      const input = { questions, mode: "continue" };
      await ask(input);
      await Effect.runPromise(Deferred.await(retry));
      return ask(input);
    },
  });
  const { host, store } = fixture;
  let running: Promise<void> | undefined;
  try {
    const session = host.session("questions");
    await Effect.runPromise(
      host.agent.session("questions").send("Choose storage", {
        requestId: "reask-undeliverable",
        delivery: "followUp",
      }),
    );
    running = host.reconcile();
    await expect
      .poll(async () => (await session.read()).attention.length)
      .toBe(1);
    const askId = (await session.read()).attention[0]?.id;
    if (askId === undefined) throw new Error("Expected parked Ask");
    await Effect.runPromise(
      host.agent.session("questions").send("Conflicting payload", {
        requestId: `ask:${askId}`,
        delivery: "followUp",
      }),
    );
    expect(
      await session.extension("botanical-session-question").call("answer", {
        askId,
        requestId: "undeliverable-answer",
        answers: { storage: { selected: ["SQLite"] } },
      }),
    ).toEqual({ result: "closed", status: "undeliverable" });
    Effect.runSync(Deferred.succeed(retry, undefined));
    await running;
    expect(fixture.result()).toMatchObject({
      status: "undeliverable",
    });
    expect(fixture.result()).toHaveProperty("reason", expect.any(String));
    expect((await session.read()).attention).toEqual([]);
    expect(
      await session.extension("botanical-session-question").call("list", {}),
    ).toMatchObject({
      asks: [],
    });
  } finally {
    Effect.runSync(Deferred.succeed(retry, undefined));
    await Effect.runPromise(host.agent.session("questions").abort);
    await running;
    await host.close();
    store.close();
  }
});

it.each(["wait", "continue"] as const)(
  "withdraws a %s question once through the model operation and rejects later answers",
  async (mode) => {
    const ready = Deferred.makeUnsafe<string>();
    const fixture = await questionHost(undefined, {
      program: async (bindings) => {
        const ask = bindings.question?.ask;
        const withdraw = bindings.question?.withdraw;
        if (ask === undefined) throw new Error("Missing Ask operation");
        expect(Object.keys(bindings.question ?? {})).not.toContain("answer");
        const [response, withdrawn] = await Promise.all([
          ask({
            questions,
            mode,
            onExpire: { afterMinutes: 5, action: "stop" },
          }),
          (async () => {
            const askId = await Effect.runPromise(Deferred.await(ready));
            if (withdraw === undefined)
              throw new Error("Missing withdraw operation");
            const first = await withdraw({ askId });
            const second = await withdraw({ askId });
            return { first, second };
          })(),
        ]);
        return { ...withdrawn, response };
      },
    });
    let { host } = fixture;
    const { store } = fixture;
    let running: Promise<void> | undefined;
    try {
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "withdraw-question",
          delivery: "followUp",
        }),
      );
      running = host.reconcile();
      await expect
        .poll(
          async () => (await host.session("questions").read()).attention.length,
        )
        .toBe(1);
      const askId = (await host.session("questions").read()).attention[0]?.id;
      if (askId === undefined) throw new Error("Expected question attention");
      Effect.runSync(Deferred.succeed(ready, askId));
      await expect.poll(fixture.result, { timeout: 3_000 }).toEqual({
        first: { result: "closed", status: "withdrawn" },
        second: { result: "closed", status: "withdrawn" },
        response:
          mode === "wait"
            ? { status: "withdrawn" }
            : { status: "parked", askId },
      });
      await running;
      await host.close();
      host = await openAgent(store.owner, botanicalAgentExtensions);
      await host.drain();
      const snapshot = await host.session("questions").read();
      expect(snapshot.attention).toEqual([]);
      expect(snapshot.pending.prompts).toEqual([]);
      expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
        status: "running",
        value: { asks: [] },
      });
      expect(await host.pendingWork()).toEqual({
        pending: false,
        nextWakeAt: null,
      });
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", {
            askId,
            requestId: "after-withdraw",
            answers: { storage: { selected: ["SQLite"] } },
          }),
      ).toEqual({ result: "closed", status: "withdrawn" });
    } finally {
      Effect.runSync(Deferred.succeed(ready, "cleanup"));
      await Effect.runPromise(host.agent.session("questions").abort);
      await running;
      await host.close();
      store.close();
    }
  },
  10_000,
);

it("parks before the Hub default execute deadline, reserving its last minute", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-08T15:00:00Z"));
  let startedAt = 0;
  const fixture = await questionHost(undefined, {
    program: async (bindings) => {
      startedAt = Date.now();
      const ask = bindings.question?.ask;
      if (ask === undefined) throw new Error("Missing Ask operation");
      return ask({ questions });
    },
  });
  const { host, store } = fixture;
  let running: Promise<void> | undefined;
  try {
    await Effect.runPromise(
      host.agent.session("questions").send("Choose storage", {
        requestId: "deadline",
        delivery: "followUp",
      }),
    );
    running = host.reconcile();
    await expect
      .poll(
        async () => (await host.session("questions").read()).attention.length,
      )
      .toBe(1);
    const askId = (await host.session("questions").read()).attention[0]?.id;
    expect(startedAt).toBeGreaterThan(0);
    vi.setSystemTime(startedAt + 119_000);
    expect(fixture.result()).toBeUndefined();
    vi.setSystemTime(startedAt + 121_000);
    await expect
      .poll(fixture.result, { timeout: 3_000 })
      .toEqual({ status: "parked", askId });
    await running;
    expect((await host.session("questions").read()).attention).toHaveLength(1);
  } finally {
    await Effect.runPromise(host.agent.session("questions").abort);
    await running;
    await host.close();
    store.close();
  }
});

it("parks immediately when earlier execute work spent the available live window", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const fixture = await questionHost(undefined, {
    program: async (bindings) => {
      const ask = bindings.question?.ask;
      if (ask === undefined) throw new Error("Missing Ask operation");
      vi.setSystemTime(Date.now() + 130_000);
      return ask({ questions });
    },
  });
  try {
    const parked = await fixture.park();
    expect(
      (await fixture.host.session("questions").read()).attention[0]?.id,
    ).toBe(parked.askId);
  } finally {
    await fixture.host.close();
    fixture.store.close();
  }
});

it("parks a live Ask for a pending steer and lets Mule deliver that steer once", async () => {
  const fixture = await questionHost({ questions });
  const { host, store } = fixture;
  let running: Promise<void> | undefined;
  try {
    const session = host.agent.session("questions");
    await Effect.runPromise(
      session.send("Choose storage", {
        requestId: "before-steer",
        delivery: "followUp",
      }),
    );
    running = host.reconcile();
    await expect
      .poll(
        async () => (await host.session("questions").read()).attention.length,
      )
      .toBe(1);
    const askId = (await host.session("questions").read()).attention[0]?.id;
    await Effect.runPromise(
      session.send("Work on the independent documentation first.", {
        requestId: "steer-during-question",
        delivery: "steer",
      }),
    );
    await expect
      .poll(fixture.result, { timeout: 3_000 })
      .toEqual({ status: "parked", askId });
    await running;
    const snapshot = await host.session("questions").read();
    expect(snapshot.pending.prompts).toEqual([]);
    expect(
      snapshot.messages.filter(
        ({ value }) =>
          value.role === "user" &&
          value.content === "Work on the independent documentation first.",
      ),
    ).toHaveLength(1);
    expect(snapshot.attention).toHaveLength(1);
  } finally {
    await Effect.runPromise(host.agent.session("questions").abort);
    await running;
    await host.close();
    store.close();
  }
});

it("refuses a fifth open question and names the four retained questions", async () => {
  const fixture = await questionHost(undefined, {
    program: async (bindings) => {
      const ask = bindings.question?.ask;
      if (ask === undefined) throw new Error("Missing Ask operation");
      const replies: SandboxValue[] = [];
      for (let index = 0; index < 5; index += 1) {
        replies.push(
          await ask({
            questions: questions.map((question) => ({
              ...question,
              question: `Which store should hold collection ${String(index)}?`,
            })),
            mode: "continue",
          }),
        );
      }
      return replies;
    },
  });
  const { host, store } = fixture;
  try {
    await Effect.runPromise(
      host.agent.session("questions").send("Choose five stores", {
        requestId: "five-questions",
        delivery: "followUp",
      }),
    );
    await host.drain();
    const replies = z
      .array(
        z.union([
          z.object({ status: z.literal("parked"), askId: z.string() }),
          z.object({
            status: z.literal("refused"),
            reason: z.literal("session_limit"),
            askIds: z.array(z.string()),
          }),
        ]),
      )
      .parse(fixture.result());
    expect(replies.slice(0, 4).map((reply) => reply.status)).toEqual([
      "parked",
      "parked",
      "parked",
      "parked",
    ]);
    const ids = (await host.session("questions").read()).attention.map(
      (item) => item.id,
    );
    expect(ids).toHaveLength(4);
    const refusal = replies[4];
    if (refusal?.status !== "refused")
      throw new Error("Expected fifth question refusal");
    expect(refusal.reason).toBe("session_limit");
    expect([...refusal.askIds].sort()).toEqual([...ids].sort());
  } finally {
    await host.close();
    store.close();
  }
});

it.each(["answer", "timer"] as const)(
  "records a %s follow-up admission conflict without stopping Ask",
  async (source) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = await questionHost({
      questions,
      mode: "continue",
      onExpire: { afterMinutes: 5, action: "stop" },
    });
    let { host } = fixture;
    const { store } = fixture;
    try {
      const { askId } = await fixture.park();
      const expiry = (await host.session("questions").read()).attention[0]
        ?.expiresAt;
      if (expiry === undefined) throw new Error("Expected question expiry");
      await Effect.runPromise(
        host.agent
          .session("questions")
          .send("Conflicting admission with another payload", {
            requestId: `ask:${askId}`,
            delivery: "followUp",
          }),
      );
      if (source === "answer") {
        expect(
          await host
            .session("questions")
            .extension("botanical-session-question")
            .call("answer", {
              askId,
              requestId: "conflicted-answer",
              answers: { storage: { selected: ["SQLite"] } },
            }),
        ).toEqual({ result: "closed", status: "undeliverable" });
      } else vi.setSystemTime(expiry);
      await host.drain();
      await host.close();
      host = await openAgent(store.owner, botanicalAgentExtensions);
      await host.drain();
      const snapshot = await host.session("questions").read();
      expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
        status: "running",
        value: { asks: [] },
      });
      expect(snapshot.attention).toEqual([]);
      expect(snapshot.pending.prompts).toEqual([]);
      expect(
        snapshot.messages.filter(({ value }) => value.role === "user"),
      ).toHaveLength(2);
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", {
            askId,
            requestId: "late-conflict-answer",
            answers: { storage: { selected: ["SQLite"] } },
          }),
      ).toEqual({ result: "closed", status: "undeliverable" });
    } finally {
      await host.close();
      store.close();
    }
  },
);

it.each(["answer", "timer"] as const)(
  "closes a deleted Session's Ask as undeliverable from %s without recreating it",
  async (source) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = await questionHost({
      questions,
      mode: "continue",
      onExpire: { afterMinutes: 5, action: "stop" },
    });
    let { host } = fixture;
    const { store } = fixture;
    try {
      const { askId } = await fixture.park();
      const expiry = (await host.session("questions").read()).attention[0]
        ?.expiresAt;
      if (expiry === undefined) throw new Error("Expected question expiry");
      expect(
        await Effect.runPromise(host.agent.deleteSession("questions")),
      ).toBe(true);
      const answer = {
        askId,
        requestId: "deleted-question-answer",
        answers: { storage: { selected: ["SQLite"] } },
      };
      if (source === "answer") {
        expect(
          await host
            .session("questions")
            .extension("botanical-session-question")
            .call("answer", answer),
        ).toEqual({ result: "closed", status: "undeliverable" });
      } else {
        vi.setSystemTime(expiry);
        await host.drain();
      }
      expect(
        (await Effect.runPromise(host.agent.listSessions())).sessions,
      ).toEqual([]);
      expect(
        (await host.extensions.list()).find(
          ({ id }) => id === "botanical-session-question",
        )?.status,
      ).toBe("running");
      await host.close();
      host = await openAgent(store.owner, botanicalAgentExtensions);
      await host.drain();
      expect(
        await host
          .session("questions")
          .extension("botanical-session-question")
          .call("answer", answer),
      ).toEqual({ result: "closed", status: "undeliverable" });
      expect(
        (await Effect.runPromise(host.agent.listSessions())).sessions,
      ).toEqual([]);
      expect(await host.pendingWork()).toEqual({
        pending: false,
        nextWakeAt: null,
      });
    } finally {
      await host.close();
      store.close();
    }
  },
);

it("does not resend a withdrawn follow-up after restart or an exact answer retry", async () => {
  const fixture = await questionHost();
  let { host } = fixture;
  const { store } = fixture;
  try {
    const { askId } = await fixture.park();
    const answer = {
      askId,
      requestId: "withdraw-follow-up",
      answers: { storage: { selected: ["SQLite"] } },
    };
    expect(
      await host
        .session("questions")
        .extension("botanical-session-question")
        .call("answer", answer),
    ).toEqual({
      result: "accepted",
      via: "follow_up",
      commandId: mintedId,
    });
    const followUp = (await host.session("questions").read()).pending
      .prompts[0];
    if (followUp === undefined) throw new Error("Expected answer follow-up");
    await Effect.runPromise(
      host.agent
        .session("questions")
        .cancel({ commandId: followUp.commandId, onlyIfPending: true }),
    );
    await host.drain();
    await host.close();
    host = await openAgent(store.owner, botanicalAgentExtensions);
    await host.drain();
    expect(
      await host
        .session("questions")
        .extension("botanical-session-question")
        .call("answer", answer),
    ).toEqual({
      result: "accepted",
      via: "follow_up",
      commandId: mintedId,
    });
    const snapshot = await host.session("questions").read();
    expect(snapshot.pending.prompts).toEqual([]);
    expect(snapshot.attention).toEqual([]);
    expect(
      snapshot.messages.filter(({ value }) => value.role === "user"),
    ).toHaveLength(1);
    expect(await host.pendingWork()).toEqual({
      pending: false,
      nextWakeAt: null,
    });
  } finally {
    await host.close();
    store.close();
  }
});

it("reuses a parked receipt after an answer commits before the original tool result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ask-parked-answer-restart-"));
  const path = join(directory, "owner.sqlite");
  const release = Deferred.makeUnsafe<undefined>();
  const first = await questionHost(undefined, {
    afterResult: () => Effect.runPromise(Deferred.await(release)),
  });
  let { host, store } = first;
  let running: Promise<void> | undefined;
  try {
    await Effect.runPromise(
      host.agent.session("questions").send("Choose storage", {
        requestId: "parked-answer-crash",
        delivery: "followUp",
      }),
    );
    running = host.reconcile();
    await expect.poll(first.result).toMatchObject({ status: "parked" });
    const parked = z
      .object({ status: z.literal("parked"), askId: z.string() })
      .parse(first.result());
    expect(
      await host
        .session("questions")
        .extension("botanical-session-question")
        .call("answer", {
          askId: parked.askId,
          requestId: "answer-before-original-commit",
          answers: { storage: { selected: ["SQLite"] } },
        }),
    ).toEqual({
      result: "accepted",
      via: "follow_up",
      commandId: mintedId,
    });
    store.copyTo(path);
    Effect.runSync(Deferred.succeed(release, undefined));
    await Effect.runPromise(host.agent.session("questions").abort);
    await running;
    await host.close();
    store.close();
    store = sqliteOwner(path);
    const restored = await questionHost(undefined, { store });
    host = restored.host;
    await host.drain();
    expect(restored.result()).toEqual(parked);
    const snapshot = await host.session("questions").read();
    expect(snapshot.attention).toEqual([]);
    expect(snapshot.pending.prompts).toEqual([]);
    expect(
      snapshot.messages.filter(({ value }) => value.role === "user"),
    ).toHaveLength(2);
    expect(snapshot.extensions["botanical-session-question"]).toMatchObject({
      status: "running",
      value: { asks: [] },
    });
  } finally {
    Effect.runSync(Deferred.succeed(release, undefined));
    await Effect.runPromise(host.agent.session("questions").abort);
    await running;
    await host.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});
