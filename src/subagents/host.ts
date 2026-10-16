import type {
  SessionSummaryRow,
  ShiitakeAgent,
  ShiitakeSession,
} from "@fungi.computer/shiitake";
import {
  defineExtension,
  type ExtensionGrantV0,
  type RosteredExtensionV0,
} from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  maximumSubagents,
  subagentsContract,
  type Subagent,
  type SubagentsProjection,
} from "./contract.js";

/** One Agent the host recorded this Session sending work to or creating. */
export type SubagentRecord = Readonly<{
  agentId: string;
  name: string;
  /** The conversation it last addressed; null when it was only created. */
  sessionId: string | null;
}>;

/** The two owner reads a status needs from one child Agent. */
export type SubagentAgent = Readonly<{
  listSessions: ShiitakeAgent["listSessions"];
  session: (sessionId: string) => Pick<ShiitakeSession, "read">;
}>;

/**
 * The host's read-only facts. `read` returns this Session's sub-agents,
 * newest first and at most `limit`, with a count of the rest; `open` is the
 * host's existing per-operation Agent access (an `AgentControlDirectory`'s
 * `open` fits), and releasing it never stops the Agent's work.
 */
export type SubagentSource = Readonly<{
  read: (
    sessionId: string,
    limit: number,
  ) => Promise<Readonly<{ agents: readonly SubagentRecord[]; more: number }>>;
  open: (
    agentId: string,
    signal: AbortSignal,
  ) => Promise<
    Readonly<{ agent: SubagentAgent; release: () => Promise<void> }>
  >;
}>;

/** Private resource ceilings; none of them is product policy. */
export type SubagentTiming = Readonly<{
  /** A watcher's read refreshes rows at least this old. */
  refreshMs: number;
  /** While a row is working or waiting, rows refresh this often. */
  pollMs: number;
  /** Polling stops once no watcher has read the Session this long. */
  interestMs: number;
}>;

const defaultTiming: SubagentTiming = Object.freeze({
  refreshMs: 1_000,
  pollMs: 5_000,
  interestMs: 30_000,
});
/** Sessions whose rows are held at once; the least recently read go first. */
const cachedSessions = 64;
/** Owner pages scanned for one child's row: 400 conversations. */
const statusPages = 2;

export const subagentsGrant: ExtensionGrantV0 = {
  id: subagentsContract.id,
  capabilities: ["projection"],
};

const settledState = {
  running: "working",
  needs_you: "waiting",
  done: "idle",
  errored: "failed",
} as const;

/**
 * The owner orders a page needs_you, running, then settled rows; a bounded
 * scan finds the child's own row, and anything else is unavailable.
 */
async function findSession(
  agent: SubagentAgent,
  sessionId: string,
): Promise<SessionSummaryRow | undefined> {
  let after: string | undefined;
  for (let page = 0; page < statusPages; page += 1) {
    const listed = await agent.listSessions(after);
    const row = listed.sessions.find((item) => item.sessionId === sessionId);
    if (row !== undefined || listed.next === undefined) return row;
    after = listed.next;
  }
  return undefined;
}

/** Read one child's owner-decided state; a failed read is unavailable, never idle. */
async function status(
  source: SubagentSource,
  record: SubagentRecord,
  signal: AbortSignal,
): Promise<Subagent> {
  const base = {
    agentId: record.agentId,
    name: record.name,
    sessionId: record.sessionId,
  };
  try {
    const opened = await source.open(record.agentId, signal);
    try {
      if (record.sessionId === null) return { ...base, state: "idle" };
      const row = await findSession(opened.agent, record.sessionId);
      if (row === undefined || row.state === "unavailable")
        return { ...base, state: "unavailable" };
      if (row.state !== "needs_you")
        return { ...base, state: settledState[row.state] };
      const snapshot = await opened.agent
        .session(record.sessionId)
        .read({ limit: 1 });
      const attention = snapshot.attention[0]?.summary;
      return attention === undefined
        ? { ...base, state: "waiting" }
        : { ...base, state: "waiting", attention };
    } finally {
      await opened.release();
    }
  } catch (cause) {
    // The row shows unavailable; the operator log keeps why.
    Effect.runFork(Effect.logWarning("subagents.status", cause));
    return { ...base, state: "unavailable" };
  }
}

type Entry = {
  value: SubagentsProjection | undefined;
  refreshedAt: number;
  readAt: number;
  refreshing: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const live = (value: SubagentsProjection | undefined) =>
  value?.agents.some(
    (agent) => agent.state === "working" || agent.state === "waiting",
  ) === true;

/**
 * One activation's in-memory rows. A watcher's projection read refreshes
 * stale rows outside the snapshot transaction; a changed or still-live result
 * publishes one observation, whose re-read keeps interest alive.
 */
function createRoster(
  source: SubagentSource,
  timing: SubagentTiming,
  publish: (sessionId: string) => Promise<void>,
) {
  const entries = new Map<string, Entry>();
  const lifetime = new AbortController();

  function forget(sessionId: string) {
    clearTimeout(entries.get(sessionId)?.timer);
    entries.delete(sessionId);
  }

  async function refresh(sessionId: string, entry: Entry) {
    entry.refreshing = true;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    try {
      const page = await source.read(sessionId, maximumSubagents - 1);
      const value: SubagentsProjection = {
        agents: await Promise.all(
          page.agents
            .slice(0, maximumSubagents - 1)
            .map((record) => status(source, record, lifetime.signal)),
        ),
        more: page.more,
      };
      const changed = JSON.stringify(value) !== JSON.stringify(entry.value);
      entry.value = value;
      if (!lifetime.signal.aborted && (changed || live(value)))
        await publish(sessionId);
    } catch (cause) {
      Effect.runFork(Effect.logError("subagents.refresh", cause));
    } finally {
      entry.refreshedAt = Date.now();
      entry.refreshing = false;
    }
    if (
      !lifetime.signal.aborted &&
      entries.get(sessionId) === entry &&
      live(entry.value) &&
      Date.now() - entry.readAt < timing.interestMs
    )
      entry.timer = setTimeout(() => {
        void refresh(sessionId, entry);
      }, timing.pollMs);
  }

  return {
    read(sessionId: string): SubagentsProjection | undefined {
      const now = Date.now();
      let entry = entries.get(sessionId);
      if (entry === undefined) {
        entry = {
          value: undefined,
          refreshedAt: Number.NEGATIVE_INFINITY,
          readAt: now,
          refreshing: false,
          timer: undefined,
        };
        entries.set(sessionId, entry);
        if (entries.size > cachedSessions) {
          const oldest = [...entries].sort(
            ([, left], [, right]) => left.readAt - right.readAt,
          )[0];
          if (oldest !== undefined) forget(oldest[0]);
        }
      }
      entry.readAt = now;
      if (!entry.refreshing && now - entry.refreshedAt >= timing.refreshMs)
        void refresh(sessionId, entry);
      return entry.value;
    },
    close() {
      lifetime.abort();
      for (const sessionId of entries.keys()) forget(sessionId);
    },
  };
}

/**
 * The read-only sub-agent view: the Agents this conversation sent work to or
 * created, one row each, with their live status. It owns no relationship,
 * no durable state and no command; the collaboration App remains the only
 * relationship owner.
 */
export function subagentsExtension(
  options: Readonly<{ source: SubagentSource; timing?: SubagentTiming }>,
): RosteredExtensionV0 {
  const rosters = new WeakMap<object, ReturnType<typeof createRoster>>();
  return defineExtension({ id: subagentsContract.id, version: "1.0.0" })
    .config({})
    .define({
      hooks: {
        start: (ctx) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const roster = createRoster(
                options.source,
                options.timing ?? defaultTiming,
                (sessionId) =>
                  Effect.runPromise(
                    ctx.transact(ctx.observe(sessionId)).pipe(Effect.ignore),
                  ),
              );
              rosters.set(ctx, roster);
              return roster;
            }),
            (roster) =>
              Effect.sync(() => {
                roster.close();
                rosters.delete(ctx);
              }),
          ).pipe(Effect.asVoid),
      },
      projection: {
        schema: subagentsContract.projection.schema,
        read: (ctx, sessionId) =>
          Option.fromUndefinedOr(rosters.get(ctx)?.read(sessionId)),
      },
    });
}
