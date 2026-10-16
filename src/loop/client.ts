import {
  defineClientEntry,
  type ClientContributionV1,
} from "@fungi.computer/shiitake/client-entry";
import type { RowV1 } from "@fungi.computer/gills";
import { loopContract, type Loop } from "./contract.js";

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
  contribute: (view): ClientContributionV1 => {
    if (view.status !== "running" || view.value === null)
      return {
        chips: [],
        panel: [],
        timeline: { cells: [], omitted: 0 },
        waiting: null,
      };
    const { loop, history } = view.value;
    const waiting =
      loop !== null && loop.state === "active" && loop.nextDueAt !== null;
    return {
      chips:
        loop === null || (loop.state !== "active" && loop.state !== "paused")
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
      panel:
        loop === null
          ? []
          : [
              {
                id: "loop",
                title: `Loop · ${loop.state} · ${loop.mode === "self_paced" ? "self-paced" : `${loop.cron?.expression ?? "fixed"} ${loop.cron?.timeZone ?? ""}`}${loop.nextDueAt === null ? "" : ` · Next ${due(loop.nextDueAt)}`}`,
                detail: loop.prompt.slice(0, 1024),
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
      timeline: {
        omitted: history.omitted,
        cells: history.events.map(({ event, ...cell }) => ({
          ...cell,
          rows: [
            {
              id: "loop",
              title: `Loop ${event.state}`,
              detail: (event.lastError ?? event.reason ?? event.prompt).slice(
                0,
                1024,
              ),
              tone: tone(event),
            },
          ],
        })),
      },
      waiting: waiting
        ? {
            summary: `Waiting until ${due(loop.nextDueAt)}`,
            cancel: {
              id: "loop",
              label: "stop loop",
              input: { action: "stop" },
            },
          }
        : null,
    };
  },
});
