import type { ShiitakeAgent } from "@fungi.computer/shiitake";
import { bindAgentExtension } from "@fungi.computer/shiitake/client";
import type * as z from "zod";

import { almanacContract } from "../almanac/contract.js";
import { loopContract } from "../loop/contract.js";
import {
  agentScheduleListInputSchema,
  agentScheduleTargetSchema,
  type AgentScheduleRow,
  type AgentSchedulePage,
  type AgentScheduleTarget,
  type AgentScheduleControlReceipt,
} from "../schedules.js";

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
  action: "pause" | "resume" | "delete",
): Promise<AgentScheduleRow> {
  const target = agentScheduleTargetSchema.parse(input);
  if (target.kind === "almanac") {
    const schedule = await bindAgentExtension(owner, almanacContract).call(
      action === "delete" ? "cancel" : action,
      { scheduleId: target.scheduleId },
    );
    return { agentId: target.agentId, kind: "almanac", schedule };
  }
  const loop = await bindAgentExtension(owner, loopContract).call(
    action === "pause"
      ? "pauseLoop"
      : action === "resume"
        ? "resumeLoop"
        : "stopLoop",
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
  action: "pause" | "resume" | "delete",
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
