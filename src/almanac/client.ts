import { defineClientEntry } from "@fungi.computer/shiitake/client-entry";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import { almanacContract, type Schedule } from "./contract.js";

/** Effect owns cron syntax; only common normalized cadences get shorter copy. */
function cadence(schedule: Schedule): string {
  if (schedule.cron === null) return "Once";
  const parsed = Cron.parse(schedule.cron.expression, schedule.cron.timeZone);
  if (Result.isFailure(parsed)) return schedule.cron.expression;
  const cron = parsed.success;
  if (
    cron.days.size === 0 &&
    cron.months.size === 0 &&
    cron.seconds.size === 1 &&
    cron.seconds.has(0) &&
    cron.hours.size === 1 &&
    cron.minutes.size === 1
  ) {
    const time = `${String([...cron.hours][0]).padStart(2, "0")}:${String([...cron.minutes][0]).padStart(2, "0")}`;
    if (cron.weekdays.size === 0 || cron.weekdays.size === 7)
      return `Every day ${time}`;
    if (
      cron.weekdays.size === 5 &&
      [1, 2, 3, 4, 5].every((day) => cron.weekdays.has(day))
    )
      return `Every weekday ${time}`;
  }
  return schedule.cron.expression;
}

function due(schedule: Schedule): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: schedule.cron?.timeZone,
    timeZoneName: "short",
  }).format(schedule.nextDueAt);
}

/** One shared footer for Grove and the terminal, over committed Session state. */
export default defineClientEntry(almanacContract, {
  contribute: (view) => ({
    chips: [],
    panel:
      view.status !== "running" || view.value === null
        ? []
        : [
            ...view.value.schedules
              .filter(
                (schedule) =>
                  schedule.state === "active" || schedule.state === "paused",
              )
              .map((schedule) => ({
                id: schedule.id,
                title: `${cadence(schedule)} · ${schedule.state === "paused" ? "paused" : `next ${due(schedule)}`}`,
                detail: [
                  schedule.prompt,
                  schedule.cron?.timeZone ?? null,
                  schedule.lastError,
                ]
                  .filter((part) => part !== null)
                  .join("\n")
                  .slice(0, 1024),
                tone:
                  schedule.lastError !== null
                    ? ("error" as const)
                    : schedule.state === "paused"
                      ? ("muted" as const)
                      : ("running" as const),
                actions: [
                  {
                    id:
                      schedule.state === "paused"
                        ? "resumeSchedule"
                        : "pauseSchedule",
                    label: schedule.state === "paused" ? "Resume" : "Pause",
                    input: {
                      scheduleId: schedule.id,
                    },
                  },
                  {
                    id: "cancelSchedule",
                    label: "Cancel",
                    input: { scheduleId: schedule.id },
                  },
                ],
              })),
            ...(view.value.more === 0
              ? []
              : [
                  {
                    id: "more schedules",
                    title: `${String(view.value.more)} more schedules — ask the Agent to list them`,
                    tone: "muted" as const,
                  },
                ]),
          ],
    timeline: { cells: [], omitted: 0 },
    waiting: null,
  }),
});
