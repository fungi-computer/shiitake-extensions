import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";

const identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);

/** The most Agents one conversation's footer lists; the rest are counted. */
export const maximumSubagents = 16;

/**
 * What the human sees for one sub-agent. `waiting` is any open attention on
 * its conversation (a question or a tool approval); `unavailable` means its
 * status could not be read, and is never shown as idle.
 */
export const SubagentState = Schema.Literals([
  "working",
  "waiting",
  "idle",
  "failed",
  "unavailable",
]);
export type SubagentState = typeof SubagentState.Type;

/** One Agent this conversation sent work to or created. */
export const Subagent = Schema.Struct({
  agentId: identity,
  name: identity,
  /** The conversation this one last addressed; null when never messaged. */
  sessionId: Schema.NullOr(identity),
  state: SubagentState,
  /** The child's own summary of what waits on the human, when waiting. */
  attention: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type Subagent = typeof Subagent.Type;

/** This conversation's sub-agents, newest first, and how many are not listed. */
export const SubagentsProjection = Schema.Struct({
  agents: Schema.Array(Subagent).check(Schema.isMaxLength(maximumSubagents)),
  more: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SubagentsProjection = typeof SubagentsProjection.Type;

/** A read-only view: no commands, one projection slot. */
export const subagentsContract = {
  id: ExtensionId.make("botanical-session-subagents"),
  commands: {},
  projection: { schema: SubagentsProjection },
} as const;
