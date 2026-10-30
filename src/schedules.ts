import type { ShiitakeAgent } from "@fungi.computer/shiitake";
import { bindAgentExtension } from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import { z } from "zod";

import { almanacContract, Schedule } from "./almanac/contract.js";
import { Loop, loopContract } from "./loop/contract.js";

const identity = z.string().min(1).max(256);

/** Exclusive native key within one Agent's Almanac-then-Loop traversal. */
export const agentScheduleCursorSchema = z
  .strictObject({
    /** Agent whose retained schedules this continuation traverses. */
    agentId: identity,
    /** Native owner to continue; Almanac precedes Loop in a fresh traversal. */
    kind: z.union([z.literal("almanac"), z.literal("loop")]),
    /** Exclusive Almanac schedule ID or Loop Session ID; absent starts the kind. */
    after: identity.optional(),
  })
  .refine(
    ({ kind, after }) =>
      Schema.is(
        kind === "almanac"
          ? almanacContract.commands.list.input
          : loopContract.commands.list.input,
      )(after === undefined ? {} : { after }),
    { message: "Invalid schedule continuation key" },
  );

/** One bounded read; a full native page conservatively carries continuation. */
export const agentScheduleListInputSchema = z.strictObject({
  /** Native continuation from the previous page of this Agent's schedules. */
  after: agentScheduleCursorSchema.optional(),
  /** Shared row budget across both native kinds; defaults to and cannot exceed 64. */
  limit: z.number().int().min(1).max(64).default(64),
});

/** Content-bearing read projection, decoded by the retained native contracts. */
export const agentScheduleRowSchema = Schema.Union([
  Schema.Struct({
    /** Agent that owns this Almanac schedule. */
    agentId: Schema.String,
    /** Identifies the native Almanac schedule representation. */
    kind: Schema.Literal("almanac"),
    /** Retained Almanac row, including its instruction and lifecycle state. */
    schedule: Schedule,
  }),
  Schema.Struct({
    /** Agent that owns this Session's Loop. */
    agentId: Schema.String,
    /** Identifies the native Loop representation. */
    kind: Schema.Literal("loop"),
    /** Retained Loop row with the Session identity used to address its owner. */
    schedule: Schema.Struct({
      ...Loop.fields,
      /** Session containing this exact Loop. */
      sessionId: loopContract.commands.pauseLoop.input.fields.sessionId,
    }),
  }),
]);
/** One Agent's retained schedule, including its native content. */
export type AgentScheduleRow = typeof agentScheduleRowSchema.Type;

/** Exact listed identity; a Loop target never selects its later replacement. */
export const agentScheduleTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    /** Selects the native Almanac control. */
    kind: z.literal("almanac"),
    /** Agent whose owner the caller must admit before controlling this target. */
    agentId: identity,
    /** Exact native Almanac schedule to pause or cancel. */
    scheduleId: identity.refine(Schema.is(Schedule.fields.id)),
  }),
  z.strictObject({
    /** Selects an identified native Loop control. */
    kind: z.literal("loop"),
    /** Agent whose owner the caller must admit before controlling this target. */
    agentId: identity,
    /** Session containing the listed Loop. */
    sessionId: identity.refine(
      Schema.is(loopContract.commands.pauseLoop.input.fields.sessionId),
    ),
    /** Exact listed Loop identity; a replacement must not be controlled instead. */
    loopId: identity.refine(Schema.is(Loop.fields.loopId)),
  }),
]);
/** Identity to admit before acquiring the corresponding Agent owner. */
export type AgentScheduleTarget = z.output<typeof agentScheduleTargetSchema>;

/** A bounded content-bearing page; owner failures reject rather than look empty. */
export const agentSchedulePageSchema = Schema.Struct({
  /** At most 64 retained rows, ordered Almanac first and then Loop. */
  items: Schema.Array(agentScheduleRowSchema).check(Schema.isMaxLength(64)),
  /** Exclusive continuation on a full page, or null when both kinds are exhausted. */
  next: Schema.NullOr(
    Schema.Struct({
      /** Agent whose traversal the next request must continue. */
      agentId: Schema.String,
      /** Native owner to continue within that Agent. */
      kind: Schema.Literals(["almanac", "loop"]),
      /** Exclusive schedule ID or Session ID; absent starts the native kind. */
      after: Schema.optionalKey(Schema.String),
    }),
  ),
});
/** One Agent's page, with no directory fan-out or availability policy. */
export type AgentSchedulePage = typeof agentSchedulePageSchema.Type;

/** Manage-only result: exact target and native state, never prompt or history. */
export const agentScheduleControlReceiptSchema = Schema.Union([
  Schema.Struct({
    /** Agent whose Almanac owner completed the transition. */
    agentId: Schema.String,
    /** Identifies the controlled native Almanac schedule. */
    kind: Schema.Literal("almanac"),
    /** Identity of the schedule that was paused or cancelled. */
    scheduleId: Schedule.fields.id,
    /** Native lifecycle state returned after the transition. */
    state: Schedule.fields.state,
  }),
  Schema.Struct({
    /** Agent whose Loop owner completed the transition. */
    agentId: Schema.String,
    /** Identifies the controlled native Loop. */
    kind: Schema.Literal("loop"),
    /** Session containing the controlled Loop. */
    sessionId: loopContract.commands.pauseLoop.input.fields.sessionId,
    /** Exact Loop identity checked by the native transition. */
    loopId: Loop.fields.loopId,
    /** Native lifecycle state returned after the transition. */
    state: Loop.fields.state,
  }),
]);
/** Content-free acknowledgement of the native owner's completed transition. */
export type AgentScheduleControlReceipt =
  typeof agentScheduleControlReceiptSchema.Type;

/**
 * Read one already-admitted Agent, without scanning Sessions or draining pages.
 * The caller owns Agent, home and resource authorization and the owner's lifetime.
 */
export async function readAgentSchedulePage(
  agentId: string,
  owner: Pick<ShiitakeAgent, "extensions">,
  input: z.input<typeof agentScheduleListInputSchema> = {},
): Promise<AgentSchedulePage> {
  const { after, limit } = agentScheduleListInputSchema.parse(input);
  if (after !== undefined && after.agentId !== agentId)
    throw new Error("Schedule continuation belongs to another Agent");
  const items: AgentScheduleRow[] = [];
  if (after?.kind !== "loop") {
    const nativeInput =
      after?.after === undefined ? { limit } : { limit, after: after.after };
    const rows = await bindAgentExtension(owner, almanacContract).call(
      "list",
      nativeInput,
    );
    for (const schedule of rows)
      items.push({ agentId, kind: "almanac", schedule });
    const last = rows.at(-1);
    if (items.length === limit && last !== undefined)
      return {
        items,
        next: { agentId, kind: "almanac", after: last.id },
      };
  }
  const remaining = limit - items.length;
  const cursor = after?.kind === "loop" ? after.after : undefined;
  const nativeInput =
    cursor === undefined
      ? { limit: remaining }
      : { limit: remaining, after: cursor };
  const rows = await bindAgentExtension(owner, loopContract).call(
    "list",
    nativeInput,
  );
  for (const schedule of rows) items.push({ agentId, kind: "loop", schedule });
  const last = rows.at(-1);
  return {
    items,
    next:
      items.length === limit && last !== undefined
        ? { agentId, kind: "loop", after: last.sessionId }
        : null,
  };
}

/**
 * Explicit content-returning control for callers admitted to both read and manage.
 * In particular, private Local retains its native-row reply. The supplied owner
 * must already be admitted for target.agentId; this helper grants no authority.
 */
export async function controlAgentScheduleWithContent(
  owner: Pick<ShiitakeAgent, "extensions">,
  input: AgentScheduleTarget,
  action: "pause" | "delete",
): Promise<AgentScheduleRow> {
  const target = agentScheduleTargetSchema.parse(input);
  if (target.kind === "almanac") {
    const schedule = await bindAgentExtension(owner, almanacContract).call(
      action === "pause" ? "pause" : "cancel",
      { scheduleId: target.scheduleId },
    );
    return { agentId: target.agentId, kind: "almanac", schedule };
  }
  const loop = await bindAgentExtension(owner, loopContract).call(
    action === "pause" ? "pauseLoop" : "stopLoop",
    { sessionId: target.sessionId, loopId: target.loopId },
  );
  return {
    agentId: target.agentId,
    kind: "loop",
    schedule: { ...loop, sessionId: target.sessionId },
  };
}

/** Control an already-admitted owner; manage-only callers receive no read content. */
export async function controlAgentSchedule(
  owner: Pick<ShiitakeAgent, "extensions">,
  target: AgentScheduleTarget,
  action: "pause" | "delete",
): Promise<AgentScheduleControlReceipt> {
  const row = await controlAgentScheduleWithContent(owner, target, action);
  return row.kind === "almanac"
    ? {
        agentId: row.agentId,
        kind: "almanac",
        scheduleId: row.schedule.id,
        state: row.schedule.state,
      }
    : {
        agentId: row.agentId,
        kind: "loop",
        sessionId: row.schedule.sessionId,
        loopId: row.schedule.loopId,
        state: row.schedule.state,
      };
}
