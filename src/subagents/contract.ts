import {
  ExtensionId,
  type CommandsV0,
} from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { CatalogStep } from "../internal/catalog.js";

const identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);

/** The most Agents one conversation's footer lists; the rest are counted. */
export const maximumSubagents = 16;

/**
 * What the human sees for one ordinary created Agent. `waiting` is any open attention on
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
/** Display state of one created Agent's conversation. */
export type SubagentState = typeof SubagentState.Type;

/** A footer row for an ordinary Agent created by this Agent, never merely sent work. */
export const Subagent = Schema.Struct({
  /** Identity of the created Agent. */
  agentId: identity,
  /** Display name of the created Agent. */
  name: identity,
  /** Its latest conversation; null when it has none. */
  sessionId: Schema.NullOr(identity),
  /** Observed conversation state, including unreadable status. */
  state: SubagentState,
  /** The child's own summary of what waits on the human, when waiting. */
  attention: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
/** Decoded footer row for a created Agent. */
export type Subagent = typeof Subagent.Type;

/**
 * This Agent's created Agents and how many are not listed.
 * `expanded` is whether the footer lists each one; a person toggles it with
 * `/agents`, and a collapsed footer keeps one summary row.
 */
export const SubagentsProjection = Schema.Struct({
  /** Created Agents currently listed in the footer. */
  agents: Schema.Array(Subagent).check(Schema.isMaxLength(maximumSubagents)),
  /** Additional created Agents not included in the visible rows. */
  more: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Whether individual rows are expanded instead of summarized. */
  expanded: Schema.Boolean,
});
/** Decoded list and expansion state projected into the footer. */
export type SubagentsProjection = typeof SubagentsProjection.Type;

/** The human `/agents` command: a bare call expands or collapses the footer rows. */
const commands = {
  /** Toggle the created-Agent footer between expanded and summarized views. */
  agents: {
    /** The Session owns its footer view. */
    scope: "session",
    /** No additional arguments are required. */
    input: Schema.Struct({}),
    /** Return the server-owned human control step. */
    output: CatalogStep,
  },
} satisfies CommandsV0;

/** Created-Agent footer control and its visible projection. */
export const subagentsContract = {
  /** Stable extension identity. */
  id: ExtensionId.make("botanical-session-subagents"),
  /** Human footer controls. */
  commands,
  /** Footer rows and expansion state. */
  projection: {
    /** Decoder for the projected footer. */
    schema: SubagentsProjection,
  },
} as const;
