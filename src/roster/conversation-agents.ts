import {
  AgentCreateRefused,
  createAgentControlSource,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import type { CapabilitySource } from "@fungi.computer/mycelium";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import * as Schema from "effect/Schema";
import { botanicalAgentExtensions } from "../roster.js";
import {
  subagentsExtension,
  subagentsGrant,
  type SubagentSource,
} from "../subagents/host.js";

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

/**
 * This host's own record of the Agents each conversation created or sent
 * accepted work to, written as its Agent-control directory accepts them
 * (Wiki: agent-runtime-tools-and-clients, read-only sub-agent view). It feeds
 * the footer only; it owns no relationship and grants nothing.
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
  /** A send names the conversation to open and moves the row to the front. */
  function sent(parentSessionId: string, agentId: string, sessionId: string) {
    sql().exec(
      "INSERT INTO oyster_conversation_agents(parent_session_id, agent_id, session_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET session_id = excluded.session_id, at = excluded.at",
      parentSessionId,
      agentId,
      sessionId,
      Date.now(),
    );
  }
  /** One conversation's directory: its accepted creates and sends are recorded. */
  function recording(
    parentSessionId: string | undefined,
    directory: AgentControlDirectory,
  ): AgentControlDirectory {
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
          sent(sourceSessionId, task.agentId, task.sessionId);
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
      directory: Pick<AgentControlDirectory, "list" | "open">,
    ): SubagentSource => ({
      read: async (sessionId, limit) => {
        const rows = sql()
          .exec(
            "SELECT agent_id, session_id FROM oyster_conversation_agents WHERE parent_session_id = ? ORDER BY at DESC, agent_id",
            sessionId,
          )
          .toArray()
          .map((row) => Schema.decodeUnknownSync(conversationAgentRow)(row));
        const known = new Map(
          (await directory.list(new AbortController().signal)).map((agent) => [
            agent.agentId,
            agent.name,
          ]),
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
    }),
  };
}

/** Both hosts compose the ordinary roster and its read-only created-Agent footer. */
export function oysterAgentExtensions(source: SubagentSource) {
  return {
    /** Ordinary extensions plus the read-only created-Agent footer. */
    roster: [
      ...botanicalAgentExtensions.roster,
      subagentsExtension({ source }),
    ],
    /** Host grants corresponding to the composed extension roster. */
    grants: [...botanicalAgentExtensions.grants, subagentsGrant],
  };
}
