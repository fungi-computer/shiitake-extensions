import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { questionHost } from "./fixtures/ask.js";

it("keeps questions across a same-Session branch and copies none to a fork", async () => {
  const fixture = await questionHost();
  const { host, store } = fixture;
  try {
    const { askId } = await fixture.park();
    const session = host.agent.session("questions");
    const before = await host.session("questions").read();
    const entryId = before.messages[0]?.id;
    if (entryId === undefined) throw new Error("Missing branch target");
    await Effect.runPromise(session.command({ type: "branch", entryId }));
    expect((await host.session("questions").read()).attention).toEqual(
      before.attention,
    );
    const fork = await Effect.runPromise(
      session.command({ type: "fork", entryId }),
    );
    const forked = await host.session(fork.sessionId).read();
    expect(forked.attention).toEqual([]);
    expect(forked.extensions["botanical-session-question"]).toMatchObject({
      status: "running",
      value: { asks: [] },
    });
    expect(
      await host
        .session(fork.sessionId)
        .extension("botanical-session-question")
        .call("answer", {
          askId,
          requestId: "wrong-session",
          answers: { storage: { selected: ["SQLite"] } },
        }),
    ).toEqual({ result: "not_found" });
    expect(
      await host
        .session("questions")
        .extension("botanical-session-question")
        .call("answer", {
          askId,
          requestId: "after-branch",
          answers: { storage: { selected: ["SQLite"] } },
        }),
    ).toEqual({ result: "accepted", via: "follow_up" });
    expect(
      (await host.session("questions").read()).pending.prompts,
    ).toHaveLength(1);
    expect((await host.session(fork.sessionId).read()).pending.prompts).toEqual(
      [],
    );
  } finally {
    await host.close();
    store.close();
  }
});
