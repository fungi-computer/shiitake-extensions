import {
  defineClientEntry,
  type ClientContributionV1,
} from "@fungi.computer/shiitake/client-entry";
import type { RowV1 } from "@fungi.computer/gills";
import { loopContract, type Loop } from "./contract.js";

/** One footer line: the full prompt stays in the row's detail. */
const summary = (text: string) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
};
const tone = (loop: Loop): RowV1["tone"] =>
  loop.state === "failed"
    ? "error"
    : loop.state === "active"
      ? "running"
      : loop.state === "paused"
        ? "muted"
        : "settled";
const due = (at: number) =>
  new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
/** Loop supplies its own absolute due copy and advertised stop intent. */
export default defineClientEntry(loopContract, {
  promptPresentation: "footer",
  contribute: (view): ClientContributionV1 => {
    if (view.status !== "running" || view.value === null)
      return {
        chips: [],
        panel: [],
        timeline: { cells: [], omitted: 0 },
        waiting: null,
      };
    const { loop } = view.value;
    const waiting = loop.state === "active" && loop.nextDueAt !== null;
    return {
      chips:
        loop.state !== "active" && loop.state !== "paused"
          ? []
          : [
              {
                id: "loop",
                order: 2,
                row: {
                  id: "loop",
                  title: `Loop ${loop.mode === "self_paced" ? "self-paced" : "fixed"}${waiting ? " (waiting)" : ""}`,
                  tone: tone(loop),
                },
              },
            ],
      panel: [
        {
          id: "loop",
          title: `Loop · ${loop.state} · ${loop.mode === "self_paced" ? "self-paced" : `${loop.cron?.expression ?? "fixed"} ${loop.cron?.timeZone ?? ""}`}${loop.nextDueAt === null ? "" : ` · Next ${due(loop.nextDueAt)}`} · ${summary(loop.prompt)}`,
          detail: [loop.reason, loop.prompt]
            .filter((part) => part !== null)
            .join("\n")
            .slice(0, 1024),
          tone: tone(loop),
        },
        ...(loop.lastError === null
          ? []
          : [
              {
                id: "error",
                title: loop.lastError.slice(0, 4096),
                tone: "error" as const,
              },
            ]),
      ],
      timeline: { cells: [], omitted: 0 },
      waiting: waiting
        ? {
            summary: `Waiting until ${due(loop.nextDueAt)}`,
            cancel: {
              id: "loop",
              label: "stop loop",
              input: { action: "stop-ask" },
            },
          }
        : null,
    };
  },
});
