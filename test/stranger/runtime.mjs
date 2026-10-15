import assert from "node:assert/strict";
import * as Schema from "effect/Schema";
import {
  LoopCommandInput,
  loopContract,
} from "@fungi.computer/shiitake-extensions/loop";
assert.deepEqual(
  Schema.decodeUnknownSync(LoopCommandInput)({ action: "pause" }),
  { action: "pause" },
);
assert.equal(loopContract.commands.loop.scope, "session");
