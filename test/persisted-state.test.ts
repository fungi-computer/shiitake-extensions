import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import { expect, it } from "vitest";

import { goalContract } from "../src/goal/contract.js";
import { goalExtension } from "../src/goal/host.js";
import { loopExtension } from "../src/loop/host.js";
import { planExtension } from "../src/plan/host.js";
import { questionContract } from "../src/question/contract.js";
import { questionExtension } from "../src/question/host.js";
import { grantAll, openAgent, sqliteOwner } from "./fixtures/host.js";

it("reopens the installed Goal/Loop/Plan state versions without rewriting their records", async () => {
  const store = sqliteOwner();
  const roster = grantAll([goalExtension, loopExtension, planExtension]);
  let host = await openAgent(store.owner, roster);
  try {
    const goal = bindSessionExtension(host.session("garden"), goalContract);
    const admitted = await goal.call("set", {
      objective: "Keep the installed conversation usable",
      expectedRevision: null,
      requestId: "installed-goal",
    });
    await host.close();
    // These are the ledger versions written by the installed pre-reset build.
    // Its collection schemas are unchanged; only the declarations were reset.
    for (const [id, version] of [
      ["botanical-session-goal", 4],
      ["botanical-session-loop", 3],
      ["botanical-session-plan", 2],
    ] as const)
      store.owner.sql.exec(
        "UPDATE shiitake_extension_state SET state_version = ? WHERE extension_id = ?",
        version,
        id,
      );
    const records = () =>
      store.owner.sql
        .exec(
          "SELECT * FROM shiitake_extension_records ORDER BY extension_id, collection, key",
        )
        .toArray();
    const before = records();
    host = await openAgent(store.owner, roster);
    const session = host.session("garden");
    const reopened = bindSessionExtension(session, goalContract);
    expect(reopened.view(await session.read())).toMatchObject({
      status: "running",
      value: { goal: admitted.goal },
    });
    expect(records()).toEqual(before);
    expect(
      store.owner.sql
        .exec(
          "SELECT extension_id, state_version FROM shiitake_extension_state ORDER BY extension_id",
        )
        .toArray(),
    ).toEqual([
      { extension_id: "botanical-session-goal", state_version: 4 },
      { extension_id: "botanical-session-loop", state_version: 3 },
      { extension_id: "botanical-session-plan", state_version: 2 },
    ]);
  } finally {
    await host.close();
    store.close();
  }
});

it("reopens Question v1 while leaving the retired installed Ask ledger untouched", async () => {
  const store = sqliteOwner();
  const roster = grantAll([
    goalExtension,
    loopExtension,
    planExtension,
    questionExtension,
  ]);
  let host = await openAgent(store.owner, roster);
  try {
    const goal = bindSessionExtension(host.session("garden"), goalContract);
    const admitted = await goal.call("set", {
      objective: "Preserve the installed state through the Question rename",
      expectedRevision: null,
      requestId: "question-rename-goal",
    });
    await host.close();
    // The collections and v1 are unchanged. Represent the old installed
    // owner identity without introducing a runtime alias or migration.
    store.owner.sql.exec(
      "UPDATE shiitake_extension_state SET extension_id = ? WHERE extension_id = ?",
      "botanical-session-ask",
      "botanical-session-question",
    );
    const records = () =>
      store.owner.sql
        .exec(
          "SELECT * FROM shiitake_extension_records ORDER BY extension_id, collection, key",
        )
        .toArray();
    const before = records();
    host = await openAgent(store.owner, roster);
    const session = host.session("garden");
    const snapshot = await session.read();
    expect(
      bindSessionExtension(session, goalContract).view(snapshot),
    ).toMatchObject({
      status: "running",
      value: { goal: admitted.goal },
    });
    expect(
      bindSessionExtension(session, questionContract).view(snapshot),
    ).toMatchObject({
      status: "running",
      value: { asks: [] },
    });
    expect(records()).toEqual(before);
    expect(
      store.owner.sql
        .exec(
          "SELECT extension_id,state_version FROM shiitake_extension_state ORDER BY extension_id",
        )
        .toArray(),
    ).toEqual([
      { extension_id: "botanical-session-ask", state_version: 1 },
      { extension_id: "botanical-session-goal", state_version: 4 },
      { extension_id: "botanical-session-loop", state_version: 3 },
      { extension_id: "botanical-session-plan", state_version: 2 },
      { extension_id: "botanical-session-question", state_version: 1 },
    ]);
  } finally {
    await host.close();
    store.close();
  }
});
