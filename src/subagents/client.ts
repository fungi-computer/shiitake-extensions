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
  waiting: { label: "waiting on you", tone: "attention", status: "warning" },
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

function row(agent: Subagent): PanelRow {
  const shown = presentation[agent.state];
  const base: PanelRow = {
    id: agent.agentId,
    title: `${agent.name} · ${shown.label}`,
    tone: shown.tone,
    status: { label: shown.label, tone: shown.status },
  };
  const detailed =
    agent.attention === undefined ? base : { ...base, detail: agent.attention };
  // An Agent created but never messaged has no conversation to open yet.
  return agent.sessionId === null
    ? { ...detailed, detail: agent.attention ?? "not messaged yet" }
    : {
        ...detailed,
        open: {
          params: [
            { key: "agent", value: agent.agentId },
            { key: "session", value: agent.sessionId },
          ],
        },
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
  const counts = (["working", "waiting", "failed", "unavailable"] as const)
    .map((state) => [state, count(state)] as const)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${String(n)} ${presentation[state].label}`);
  const total = view.agents.length + view.more;
  const tone: PanelRow["tone"] =
    count("waiting") > 0
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
