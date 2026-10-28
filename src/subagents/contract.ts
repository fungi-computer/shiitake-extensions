import {
  ExtensionId,
  type CommandsV0,
} from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { CatalogStep } from "../internal/catalog.js";
import { AnswerFlowInput, Questions } from "../question/contract.js";

const identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);

/** The most Agents one conversation's footer lists; the rest are counted. */
export const maximumSubagents = 16;

/**
 * What the human sees for one ordinary created Agent. `waiting_on_agent` is an
 * open question that waits on the Agent that sent the work, calm until it is
 * escalated; `needs_you` is attention that waits on a person; `unavailable`
 * means its status could not be read, and is never shown as idle.
 */
export const SubagentState = Schema.Literals([
  "working",
  "waiting_on_agent",
  "needs_you",
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
  /** The child's own summary of what it waits on, when waiting. */
  attention: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /** Display name of the Agent a `waiting_on_agent` child waits on. */
  waitingOn: Schema.optionalKey(identity),
  /** The question a waiting child asks, so a person can answer from here. */
  ask: Schema.optionalKey(
    Schema.Struct({
      /** Durable identity of the child's open Ask. */
      askId: identity,
      /** The decisions the child asks, so they can be answered from here. */
      questions: Questions,
    }),
  ),
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

/** One child, as an answer step names it beside the draft it advances. */
const child = {
  /** Identity of the child Agent whose Ask is being answered. */
  agentId: identity,
  /** The child's conversation that holds the Ask. */
  sessionId: identity,
};
/**
 * The question flow's own steps, each naming the child whose Ask they answer.
 * The footer owns the conversation; the child's question owner commits it.
 */
export const AnswerChildInput = Schema.Union(
  AnswerFlowInput.members.map((member) =>
    Schema.Struct({ ...member.fields, ...child }),
  ),
);

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
  /** Answer a question an escalated sub-agent asks, from this conversation. */
  answerChild: {
    /** The Session owns its footer. */
    scope: "session",
    /** The next step of the child's answer conversation. */
    input: AnswerChildInput,
    /** Return the next human conversation step. */
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
