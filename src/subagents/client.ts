import {
  defineClientEntry,
  type ClientContributionV1,
} from "@fungi.computer/shiitake/client-entry";
import {
  subagentsContract,
  type Subagent,
  type SubagentsProjection,
  type SubagentState,
} from "./contract.js";

type PanelRow = ClientContributionV1["panel"][number];

const presentation = {
  working: { label: "working", tone: "running", status: "info" },
  waiting_on_agent: { label: "waiting", tone: "muted", status: "neutral" },
  needs_you: { label: "needs you", tone: "attention", status: "warning" },
  idle: { label: "idle", tone: "settled", status: "success" },
  failed: { label: "failed", tone: "error", status: "error" },
  unavailable: { label: "unavailable", tone: "muted", status: "neutral" },
} as const satisfies Record<
  SubagentState,
  Readonly<{
    label: string;
    tone: NonNullable<PanelRow["tone"]>;
    status: NonNullable<PanelRow["status"]>["tone"];
  }>
>;

/** "waiting on Shiitake": the Agent a calm child waits on, never "you". */
function label(agent: Subagent): string {
  return agent.state === "waiting_on_agent"
    ? `waiting on ${agent.waitingOn ?? "its parent"}`
    : presentation[agent.state].label;
}

function row(agent: Subagent): PanelRow {
  const shown = presentation[agent.state];
  const base: PanelRow = {
    id: agent.agentId,
    title: `${agent.name} · ${label(agent)}`,
    tone: shown.tone,
    status: { label: label(agent), tone: shown.status },
  };
  // The question itself, so a person can decide without opening the child.
  const asked = agent.ask?.questions[0]?.question;
  const text = asked ?? agent.attention;
  const detailed =
    text === undefined ? base : { ...base, detail: text.slice(0, 200) };
  // An Agent created but never messaged has no conversation to open yet.
  if (agent.sessionId === null)
    return { ...detailed, detail: agent.attention ?? "not messaged yet" };
  const opened = {
    ...detailed,
    open: {
      params: [
        { key: "agent", value: agent.agentId },
        { key: "session", value: agent.sessionId },
      ],
    },
  };
  if (agent.ask === undefined) return opened;
  const answer = {
    id: "answerChild",
    label: "Answer",
    input: {
      agentId: agent.agentId,
      sessionId: agent.sessionId,
      askId: agent.ask.askId,
    },
  };
  // A question offers the one Answer action, calm or not: a person may always
  // answer, and the first answer wins. Only a question that needs the person
  // takes over the composer.
  return {
    ...opened,
    actions: [
      agent.state === "needs_you"
        ? { ...answer, awaiting: "question" as const }
        : answer,
    ],
  };
}

/**
 * One summary row while the footer is collapsed: how
 * many sub-agents there are and what needs attention, so a collapse never
 * hides an Agent waiting on them.
 */
function summary(view: SubagentsProjection): PanelRow {
  const count = (state: SubagentState) =>
    view.agents.filter((agent) => agent.state === state).length;
  const calm = view.agents.filter(
    (agent) => agent.state === "waiting_on_agent",
  );
  // Calm children name who they wait on; only needs-you children are amber.
  const waiting = [
    ...new Set(calm.map((agent) => agent.waitingOn ?? "its parent")),
  ].map(
    (name) =>
      `${String(calm.filter((agent) => (agent.waitingOn ?? "its parent") === name).length)} waiting on ${name}`,
  );
  const counts = [
    ...(["working"] as const)
      .map((state) => [state, count(state)] as const)
      .filter(([, n]) => n > 0)
      .map(([state, n]) => `${String(n)} ${presentation[state].label}`),
    ...waiting,
    ...(["needs_you", "failed", "unavailable"] as const)
      .map((state) => [state, count(state)] as const)
      .filter(([, n]) => n > 0)
      .map(([state, n]) => `${String(n)} ${presentation[state].label}`),
  ];
  const total = view.agents.length + view.more;
  const tone: PanelRow["tone"] =
    count("needs_you") > 0
      ? "attention"
      : count("failed") > 0
        ? "error"
        : count("working") > 0
          ? "running"
          : "muted";
  return {
    id: "summary",
    title: [
      `${String(total)} sub-agent${total === 1 ? "" : "s"}`,
      ...counts,
      "/agents shows them",
    ].join(" · "),
    tone,
  };
}

/** One footer row per sub-agent; opening a row shows its conversation beside this one. */
export default defineClientEntry(subagentsContract, {
  contribute: (view): ClientContributionV1 => ({
    chips: [],
    panel:
      view.status !== "running" || view.value === null
        ? []
        : view.value.agents.length > 0 && !view.value.expanded
          ? [summary(view.value)]
          : [
              ...view.value.agents.map(row),
              ...(view.value.more === 0
                ? []
                : [
                    {
                      id: "more",
                      title: `${String(view.value.more)} more sub-agent${view.value.more === 1 ? "" : "s"}`,
                      tone: "muted" as const,
                    },
                  ]),
            ],
    timeline: { cells: [], omitted: 0 },
    waiting: null,
  }),
});
