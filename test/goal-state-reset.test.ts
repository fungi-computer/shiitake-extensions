import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import {
  defineCollection,
  defineExtension,
} from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { goalContract } from "../src/goal/contract.js";
import { goalExtension } from "../src/goal/host.js";
import { grantAll, openAgent, run, sqliteOwner } from "./fixtures/host.js";

// The actual pre-correction v6 record, including its old command anchor.
// This is a test-only producer, not a decoder or migration in installed code.
const oldEnding = {
  sequence: 1,
  objective: "An already cleared v6 goal",
  outcome: "cleared" as const,
  reason: null,
  endedAt: 1,
  commandId: "old-goal-work",
};
const oldRow = { sessionId: "garden", ended: [oldEnding], total: 1 };
const oldEndings = Schema.Struct({
  sessionId: Schema.String,
  ended: Schema.Array(
    Schema.Struct({
      sequence: Schema.Int,
      objective: Schema.String,
      outcome: Schema.Literals(["achieved", "cleared"]),
      reason: Schema.NullOr(Schema.String),
      endedAt: Schema.Int,
      commandId: Schema.NullOr(Schema.String),
    }),
  ),
  total: Schema.Int,
});
const v6Producer = defineExtension({
  id: goalContract.id,
  version: "6.0.0",
})
  .state({
    version: 6,
    migrations: {},
    collections: {
      endings: defineCollection(oldEndings, { key: (row) => row.sessionId }),
    },
  })
  .define({
    commands: {
      specs: {
        seed: {
          scope: "agent",
          input: Schema.Struct({}),
          output: oldEndings,
        },
        read: {
          scope: "agent",
          input: Schema.Struct({}),
          output: Schema.NullOr(oldEndings),
        },
      },
      handlers: (ctx) => ({
        seed: () =>
          Effect.gen(function* () {
            yield* ctx.state.endings.put(oldRow);
            return oldRow;
          }),
        read: () =>
          ctx.state.endings.get("garden").pipe(Effect.map(Option.getOrNull)),
      }),
    },
  });

it("keeps the Session running with a typed visible state-reset diagnostic for a real old-shape v6 Goal row", async () => {
  const store = sqliteOwner();
  let host = await openAgent(store.owner, grantAll([v6Producer]));
  try {
    await run(
      host.agent.session("garden").send("Before the installed upgrade", {
        requestId: "before-upgrade",
      }),
    );
    await host.drain();
    expect(
      await run(host.agent.extensions.call(goalContract.id, "seed", {})),
    ).toEqual(oldRow);
    const before = await host.session("garden").read();
    await host.close();

    host = await openAgent(store.owner, grantAll([goalExtension]));
    await run(
      host.agent.session("garden").send("The Session still works", {
        requestId: "after-upgrade",
      }),
    );
    await host.drain();
    const session = host.session("garden");
    const after = await session.read();
    // Check service/Session survival before checking the diagnostic: the
    // baseline must fail for the installed behavior, not a wording mismatch.
    expect(after.terminals.map(({ outcome }) => outcome)).toEqual([
      "completed",
      "completed",
    ]);
    expect(after.messages.slice(0, before.messages.length)).toEqual(
      before.messages,
    );
    const goal = bindSessionExtension(session, goalContract);
    const view = goal.view(after);
    expect(view.status).toBe("stopped");
    if (view.status !== "stopped") expect.fail("Goal must refuse old state");
    expect(view.reason).toContain("State reset required");
    await expect(goal.call("clear", {})).rejects.toMatchObject({
      _tag: "ShiitakeError",
      boundary: "extensions",
      cause: "state_reset_required",
    });
    await host.close();
    // Reopen the original producer to read, not reseed, its record. The v7
    // refusal must leave both the old ledger and old row intact.
    host = await openAgent(store.owner, grantAll([v6Producer]));
    expect(
      await run(host.agent.extensions.call(goalContract.id, "read", {})),
    ).toEqual(oldRow);
  } finally {
    await host.close();
    store.close();
  }
});
