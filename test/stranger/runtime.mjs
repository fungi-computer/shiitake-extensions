import assert from "node:assert/strict";
import * as Schema from "effect/Schema";
import {
  LoopCommandInput,
  loopContract,
} from "@fungi.computer/shiitake-extensions/loop";
import {
  agentSchedulePageSchema,
  agentScheduleTargetSchema,
} from "@fungi.computer/shiitake-extensions/schedules";
// Load the native entrypoint without invoking an owner operation in this codec smoke.
import "@fungi.computer/shiitake-extensions/schedules/client";
assert.deepEqual(
  Schema.decodeUnknownSync(LoopCommandInput)({ action: "pause" }),
  { action: "pause" },
);
assert.equal(loopContract.commands.loop.scope, "session");
assert.deepEqual(
  Schema.decodeUnknownSync(agentSchedulePageSchema)({ items: [], next: null }),
  { items: [], next: null },
);
const target = {
  agentId: "agent-a",
  kind: "loop",
  sessionId: "session-a",
  loopId: "loop-a",
};
assert.deepEqual(agentScheduleTargetSchema.parse(target), target);
