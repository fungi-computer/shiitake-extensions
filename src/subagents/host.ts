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
import { catalog, done } from "../internal/catalog.js";
import type { WhistleCatalogStepV1 } from "@fungi.computer/whistle/catalog";
import {
  maximumSubagents,
  subagentsContract,
  type Subagent,
  type SubagentsProjection,
} from "./contract.js";

/** A footer row for an ordinary Agent created by the current Agent. */
export type SubagentRecord = Readonly<{
  /** Identity of the ordinary created Agent. */
  agentId: string;
  /** Display name supplied by the host. */
  name: string;
  /** A host-selected conversation; null asks the view to read its latest one. */
  sessionId: string | null;
}>;

/** Owner reads used for status and exact delegated command settlement. */
export type SubagentAgent = Readonly<{
  /** Read the child's owner-ordered conversation summaries. */
  listSessions: ShiitakeAgent["listSessions"];
  /** Open the read-only view of a selected child conversation. */
  session: (
    sessionId: string,
  ) => Pick<ShiitakeSession, "read" | "readSettlement">;
}>;

/**
 * The host's read-only facts. `read` returns ordinary created Agents,
 * at most `limit`, with a count of the rest; `open` is the
 * host's existing per-operation Agent access (an `AgentControlDirectory`'s
 * `open` fits), and releasing it never stops the Agent's work.
 */
export type SubagentSource = Readonly<{
  /** A recorded accepted child command is still pending or running. Synchronous for settlement. */
  hasLiveChildCommand: (sessionId: string) => boolean;
  /** Read a bounded list of this conversation's created Agents. */
  read: (
    sessionId: string,
    limit: number,
  ) => Promise<
    Readonly<{
      /** Created Agents included in this page. */
      agents: readonly SubagentRecord[];
      /** Additional created Agents not included in this page. */
      more: number;
    }>
  >;
  /** Acquire existing owner access for one child Agent. */
  open: (
    agentId: string,
    signal: AbortSignal,
  ) => Promise<
    Readonly<{
      /** Read-only Agent access held by this acquisition. */
      agent: SubagentAgent;
      /** Release this acquisition without stopping the Agent's work. */
      release: () => Promise<void>;
    }>
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

/** Host admission for the read-only created-Agent footer and human toggle. */
export const subagentsGrant: ExtensionGrantV0 = {
  id: subagentsContract.id,
  capabilities: ["projection", "commands"],
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
  const base: Omit<Subagent, "state"> = {
    agentId: record.agentId,
    name: record.name,
    sessionId: record.sessionId,
  };
  try {
    const opened = await source.open(record.agentId, signal);
    try {
      const row =
        record.sessionId === null
          ? (await opened.agent.listSessions()).sessions[0]
          : await findSession(opened.agent, record.sessionId);
      if (row === undefined && record.sessionId === null)
        return { ...base, state: "idle" };
      if (row === undefined || row.state === "unavailable")
        return { ...base, state: "unavailable" };
      const selected = { ...base, sessionId: row.sessionId };
      if (row.state !== "needs_you")
        return { ...selected, state: settledState[row.state] };
      const snapshot = await opened.agent
        .session(row.sessionId)
        .read({ limit: 1 });
      const attention = snapshot.attention[0]?.summary;
      return attention === undefined
        ? { ...selected, state: "waiting" }
        : { ...selected, state: "waiting", attention };
    } finally {
      await opened.release();
    }
  } catch (cause) {
    // The row shows unavailable; the operator log keeps why.
    Effect.runFork(Effect.logWarning("subagents.status", cause));
    return { ...base, state: "unavailable" };
  }
}

/** The rows a refresh reads; whether they are listed is the person's choice. */
type Rows = Omit<SubagentsProjection, "expanded">;

type Entry = {
  value: Rows | undefined;
  /** Collapsed initially; `/agents` toggles whether the footer lists rows. */
  expanded: boolean;
  refreshedAt: number;
  readAt: number;
  refreshing: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const live = (value: Rows | undefined) =>
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
      const value: Rows = {
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
    /** Flip whether the footer lists the rows; undefined while there is nothing to list. */
    toggle(sessionId: string): boolean | undefined {
      const entry = entries.get(sessionId);
      if (entry?.value === undefined || entry.value.agents.length === 0)
        return undefined;
      entry.expanded = !entry.expanded;
      return entry.expanded;
    },
    read(sessionId: string): SubagentsProjection | undefined {
      const now = Date.now();
      let entry = entries.get(sessionId);
      if (entry === undefined) {
        entry = {
          value: undefined,
          expanded: false,
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
      return entry.value === undefined
        ? undefined
        : { ...entry.value, expanded: entry.expanded };
    },
    close() {
      lifetime.abort();
      for (const sessionId of entries.keys()) forget(sessionId);
    },
  };
}

/**
 * The read-only footer: ordinary Agents created by this Agent, one row each,
 * with their live status. It owns neither relationships nor durable state;
 * the Agent directory owns immutable creation attribution.
 * Its one command, `/agents`, only expands or collapses
 * the footer rows.
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
      catalog: catalog([
        {
          id: "agents",
          title: "Agents",
          category: "Conversation",
          description: "Show or hide this conversation's sub-agents",
          projections: {
            help: { order: 6 },
            palette: { order: 6 },
            slash: { aliases: ["agents"], order: 6 },
          },
        },
      ]),
      projection: {
        schema: subagentsContract.projection.schema,
        read: (ctx, sessionId) =>
          Option.fromUndefinedOr(rosters.get(ctx)?.read(sessionId)),
      },
      commands: {
        specs: subagentsContract.commands,
        handlers: (ctx) => ({
          agents: ({ sessionId }) =>
            Effect.gen(function* () {
              const expanded = rosters.get(ctx)?.toggle(sessionId);
              if (expanded === undefined)
                return done({
                  type: "info",
                  message: "This conversation has no sub-agents.",
                });
              yield* ctx.observe(sessionId);
              // The changed rows already show the result; don't echo the toggle.
              return { type: "done" } satisfies WhistleCatalogStepV1;
            }),
        }),
      },
    });
}
