import {
  AgentCreateRefused,
  createAgentControlSource,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import type { CapabilitySource } from "@fungi.computer/mycelium";
import type { SqliteRow } from "@fungi.computer/shiitake";
import {
  bindSessionExtension,
  type ShiitakeSession,
} from "@fungi.computer/shiitake/client";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  botanicalAgentExtensions,
  botanicalExtensionsWithSubagents,
} from "../roster.js";
import { goalContract } from "../goal/contract.js";
import type { SubagentSource } from "../subagents/host.js";

/** Host-pack creation admission; attachments/model selection retain their own owners. */
export function assertOrdinaryAgentCreation(
  input: Parameters<NonNullable<AgentControlDirectory["create"]>>[0],
) {
  if (input.model !== undefined)
    throw new Error(
      "Per-Agent model selection is unavailable on this creation door",
    );
  const held = new Set<string>(
    botanicalAgentExtensions.grants.map(({ id }) => id),
  );
  if (input.extensions?.some((id) => !held.has(id)))
    throw new AgentCreateRefused(
      "exceeds_creator",
      "this creation door grants only the ordinary base roster",
    );
}

const conversationAgentRow = Schema.Struct({
  agent_id: Schema.String,
  session_id: Schema.NullOr(Schema.String),
});
const delegatedCommandRow = Schema.Struct({
  parent_session_id: Schema.String,
  agent_id: Schema.String,
  session_id: Schema.String,
  command_id: Schema.String,
  at: Schema.Number,
});
/** Private safety ceilings for command-status polling; not a delegation policy. */
const maxWatchedCommands = 64;
const pollMs = 2_000;
const maxWatchMs = 30 * 60_000;

/** The directory a conversation sends through; opening a recipient only needs its Sessions' extension doors. */
export type SendingDirectory = Omit<AgentControlDirectory, "open"> &
  Readonly<{
    /** Open the recipient's Session extension door for goal adoption. */
    open: (
      agentId: string,
      signal: AbortSignal,
    ) => Promise<
      Readonly<{
        /** Recipient Agent with a Session extension door. */
        agent: Readonly<{
          /** Address a recipient Session without loading its conversation. */
          session: (sessionId: string) => Pick<ShiitakeSession, "extension">;
        }>;
        /** Release the acquired recipient without stopping its work. */
        release: () => Promise<void>;
      }>
    >;
  }>;

/** The objective of a delegated lane: the named goal, else the send's first line. */
function laneObjective(text: string, goal: string | undefined): string {
  const named = goal?.trim();
  if (named !== undefined && named !== "") return named;
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? text.trim()
  ).slice(0, 4_000);
}

/** Adopt the first accepted turn once, even when the sender was offline at delivery. */
export async function adoptDelegatedGoal(
  session: Pick<ShiitakeSession, "extension">,
  input: Readonly<{
    text: string;
    goal: string | false | undefined;
    commandId: string;
  }>,
): Promise<void> {
  if (input.goal === false) return;
  await bindSessionExtension(session, goalContract).call("set", {
    objective: laneObjective(input.text, input.goal),
    expectedRevision: null,
    requestId: `lane-goal:${input.commandId}`,
    // The delegated prompt is already admitted; never enqueue it twice.
    adoptCommandId: input.commandId,
  });
}

/**
 * This host's own record of the Agents each conversation created or sent
 * accepted work to, written as its Agent-control directory accepts them
 * (Wiki: agent-runtime-tools-and-clients, read-only sub-agent view). Accepted
 * child command receipts are separately reconciled against their owner's
 * settlement records for the parent's goal guard. Neither record grants
 * authority over a child.
 */
export function createConversationAgents(storage: WatchdogSqliteOwner) {
  // Composing a host does no storage I/O; the first record or read prepares it.
  let prepared = false;
  function sql() {
    if (!prepared) {
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS oyster_conversation_agents (parent_session_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (parent_session_id, agent_id)) STRICT",
      );
      storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_oyster_conversation_agents_parent ON oyster_conversation_agents(parent_session_id, at)",
      );
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS oyster_delegated_commands (parent_session_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL PRIMARY KEY, at INTEGER NOT NULL) STRICT",
      );
      prepared = true;
    }
    return storage.sql;
  }
  /** A retried create keeps its first row. */
  function created(parentSessionId: string, agentId: string) {
    sql().exec(
      "INSERT OR IGNORE INTO oyster_conversation_agents(parent_session_id, agent_id, session_id, at) VALUES (?, ?, NULL, ?)",
      parentSessionId,
      agentId,
      Date.now(),
    );
  }
  /** A send may not know its Session until the recipient accepts it. */
  function sent(
    parentSessionId: string,
    agentId: string,
    sessionId: string | undefined,
    commandId: string,
  ) {
    sql().exec(
      "INSERT INTO oyster_conversation_agents(parent_session_id, agent_id, session_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET session_id = excluded.session_id, at = excluded.at",
      parentSessionId,
      agentId,
      sessionId ?? null,
      Date.now(),
    );
    if (sessionId !== undefined) {
      sql().exec(
        "INSERT OR REPLACE INTO oyster_delegated_commands(parent_session_id, agent_id, session_id, command_id, at) VALUES (?, ?, ?, ?, ?)",
        parentSessionId,
        agentId,
        sessionId,
        commandId,
        Date.now(),
      );
      sql().exec(
        "DELETE FROM oyster_delegated_commands WHERE command_id NOT IN (SELECT command_id FROM oyster_delegated_commands ORDER BY at DESC LIMIT ?)",
        maxWatchedCommands,
      );
    }
  }
  /** One conversation's directory: its accepted creates and sends are recorded. */
  function recording<Directory extends SendingDirectory>(
    parentSessionId: string | undefined,
    directory: Directory,
  ): Directory {
    const { create, send } = directory;
    let recorded = directory;
    if (create !== undefined && parentSessionId !== undefined)
      recorded = {
        ...recorded,
        create: async (request, signal) => {
          const agent = await create(request, signal);
          created(parentSessionId, agent.agentId);
          return agent;
        },
      };
    if (send !== undefined)
      recorded = {
        ...recorded,
        send: async (task, sourceSessionId, signal, invocation) => {
          const accepted = await send(
            task,
            sourceSessionId,
            signal,
            invocation,
          );
          if (accepted.status === "accepted") {
            const sessionId = accepted.sessionId ?? task.sessionId;
            sent(sourceSessionId, task.agentId, sessionId, accepted.commandId);
            // A send that opens a new Session puts it under a goal, so the
            // lane keeps working until it reports complete or blocked. A
            // retry replays the same request id, so the goal is set once.
            if (
              task.delivery === "followUp" &&
              task.sessionId === undefined &&
              task.goal !== false &&
              sessionId !== undefined
            ) {
              const opened = await directory.open(task.agentId, signal);
              try {
                await adoptDelegatedGoal(opened.agent.session(sessionId), {
                  text: task.text,
                  goal: task.goal,
                  commandId: accepted.commandId,
                });
              } finally {
                await opened.release();
              }
            }
          }
          return accepted;
        },
      };
    return recorded;
  }
  return {
    /** Bind acceptance recording to this conversation's existing directory. */
    recording,
    /** Agent-control tools bound to the conversation that acquires them. */
    control: (
      directoryFor: (
        parentSessionId: string | undefined,
      ) => AgentControlDirectory,
    ): CapabilitySource => ({
      id: createAgentControlSource(
        recording(undefined, directoryFor(undefined)),
      ).id,
      acquire: (context) => {
        const parentSessionId = context.session?.sessionId;
        return createAgentControlSource(
          recording(parentSessionId, directoryFor(parentSessionId)),
        ).acquire(context);
      },
    }),
    /** The footer rows for one conversation; archived and unknown Agents leave it. */
    source: (
      directory: Pick<AgentControlDirectory, "list"> &
        Pick<SubagentSource, "open">,
    ): SubagentSource => {
      const polling = new Set<string>();
      const signal = new AbortController().signal;
      function poll(commandId: string) {
        if (polling.has(commandId) || polling.size >= maxWatchedCommands)
          return;
        polling.add(commandId);
        const check = async () => {
          let raw: SqliteRow | undefined;
          try {
            raw = sql()
              .exec(
                "SELECT parent_session_id, agent_id, session_id, command_id, at FROM oyster_delegated_commands WHERE command_id = ?",
                commandId,
              )
              .toArray()[0];
          } catch (cause) {
            // The host's store was closed; no orphan poller may keep using it.
            Effect.runFork(
              Effect.logError("subagents.command-store-read", cause),
            );
            polling.delete(commandId);
            return;
          }
          if (raw === undefined) {
            polling.delete(commandId);
            return;
          }
          const row = Schema.decodeUnknownSync(delegatedCommandRow)(raw);
          // An unobservable command cannot justify an indefinite live wait.
          if (Date.now() - row.at >= maxWatchMs) {
            sql().exec(
              "DELETE FROM oyster_delegated_commands WHERE command_id = ?",
              commandId,
            );
            polling.delete(commandId);
            return;
          }
          try {
            const opened = await directory.open(row.agent_id, signal);
            let settled: Awaited<
              ReturnType<
                ReturnType<typeof opened.agent.session>["readSettlement"]
              >
            >;
            try {
              settled = await opened.agent
                .session(row.session_id)
                .readSettlement(commandId, {
                  timeoutMs: 0,
                  signal,
                });
            } finally {
              await opened.release();
            }
            if (settled !== undefined) {
              sql().exec(
                "DELETE FROM oyster_delegated_commands WHERE command_id = ?",
                commandId,
              );
              polling.delete(commandId);
              return;
            }
          } catch (cause) {
            // An unreadable child is not proof of live work; do not hold the guard.
            Effect.runFork(Effect.logError("subagents.command-status", cause));
            try {
              sql().exec(
                "DELETE FROM oyster_delegated_commands WHERE command_id = ?",
                commandId,
              );
            } catch (closed) {
              // Host teardown closed storage while the remote read was pending.
              Effect.runFork(
                Effect.logError("subagents.command-store-closed", closed),
              );
            }
            polling.delete(commandId);
            return;
          }
          setTimeout(() => void check(), pollMs);
        };
        void check();
      }
      return {
        // Polling is demand-driven: only a parent whose goal asks about its
        // live children watches their receipts, including ones recorded
        // before a restart. Composing a host or sending mail does no polling.
        hasLiveChildCommand: (sessionId) => {
          const live = sql()
            .exec(
              "SELECT command_id FROM oyster_delegated_commands WHERE parent_session_id = ? AND at > ? ORDER BY at DESC LIMIT ?",
              sessionId,
              Date.now() - maxWatchMs,
              maxWatchedCommands,
            )
            .toArray()
            .map(
              (row) =>
                Schema.decodeUnknownSync(
                  Schema.Struct({ command_id: Schema.String }),
                )(row).command_id,
            );
          for (const commandId of live) poll(commandId);
          return live.length > 0;
        },
        read: async (sessionId, limit) => {
          const rows = sql()
            .exec(
              "SELECT agent_id, session_id FROM oyster_conversation_agents WHERE parent_session_id = ? ORDER BY at DESC, agent_id",
              sessionId,
            )
            .toArray()
            .map((row) => Schema.decodeUnknownSync(conversationAgentRow)(row));
          const known = new Map(
            (await directory.list(new AbortController().signal)).map(
              (agent) => [agent.agentId, agent.name],
            ),
          );
          const agents = rows.flatMap((row) => {
            const name = known.get(row.agent_id);
            return name === undefined
              ? []
              : [{ agentId: row.agent_id, name, sessionId: row.session_id }];
          });
          return {
            agents: agents.slice(0, limit),
            more: Math.max(0, agents.length - limit),
          };
        },
        open: directory.open,
      };
    },
  };
}

/** Both hosts compose the ordinary roster and its read-only created-Agent footer. */
export function oysterAgentExtensions(source: SubagentSource) {
  return botanicalExtensionsWithSubagents(botanicalAgentExtensions, source);
}
