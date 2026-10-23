import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import { expect, it } from "vitest";
import { goalContract } from "../src/goal/contract.js";
import { goalExtension } from "../src/goal/host.js";
import { grantAll, openAgent, run, sqliteOwner } from "./fixtures/host.js";

it("commits a goal ending at the Session position, not its local event counter, and retains it after later work and reopen", async () => {
  const store = sqliteOwner();
  let host = await openAgent(store.owner, grantAll([goalExtension]));
  try {
    const session = host.session("garden");
    await run(
      host.agent.session("garden").send("Before the goal", {
        requestId: "before-goal",
      }),
    );
    await host.drain();
    const goal = bindSessionExtension(session, goalContract);
    await goal.call("set", {
      objective: "Rest",
      expectedRevision: null,
      requestId: "position-goal",
    });
    // This one-reply run commits command, run-start, turn-start, model-prompt,
    // message and run-terminal entries. The terminal is not a display message:
    // the ending must capture committed position 6, not the last text row 5.
    expect(
      (await session.read()).messages.map(({ sequence }) => sequence),
    ).toEqual([1, 5]);
    const position = 6;
    await goal.call("clear", {});
    const ending = { sequence: 1, afterSequence: position, outcome: "cleared" };
    expect(goal.view(await session.read())).toMatchObject({
      status: "running",
      value: { goal: null, ended: [ending] },
    });

    await run(
      host.agent.session("garden").send("After clearing", {
        requestId: "after-clear",
      }),
    );
    await host.drain();
    expect(
      Math.max(
        ...(await session.read()).messages.map(({ sequence }) => sequence),
      ),
    ).toBeGreaterThan(position);
    expect(goal.view(await session.read())).toMatchObject({
      value: { ended: [ending] },
    });

    await host.close();
    host = await openAgent(store.owner, grantAll([goalExtension]));
    const reopened = host.session("garden");
    expect(
      bindSessionExtension(reopened, goalContract).view(await reopened.read()),
    ).toMatchObject({ value: { goal: null, ended: [ending] } });
  } finally {
    await host.close();
    store.close();
  }
});
