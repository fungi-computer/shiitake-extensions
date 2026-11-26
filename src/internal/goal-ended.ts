import type {
  ExtensionContextV0,
  ExtensionRead,
  ExtensionStateError,
} from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EndedGoal, goalContract } from "../goal/contract.js";

const GoalEndings = Schema.Struct({
  ended: Schema.Array(EndedGoal),
  omitted: Schema.Int,
});
const decodeEndings = Schema.decodeUnknownOption(GoalEndings);

/** The goals that have ended on one Session, and how the newest one ended. */
export type GoalEndings = Readonly<{
  total: number;
  newest: EndedGoal | undefined;
}>;

/**
 * The goals that have ended on one Session, read from the goal extension's own
 * projection (never its state). None when there is no goal extension or none
 * has ended. The goal commits an ending in its own settled hook, which runs
 * before any extension listed after it, so a peer sees it on the same run.
 */
export function goalEndings(
  ctx: Pick<ExtensionContextV0<never, never>, "peerProjection">,
  sessionId: string,
): Effect.Effect<GoalEndings, ExtensionStateError, ExtensionRead> {
  return ctx.peerProjection(goalContract.id, sessionId).pipe(
    Effect.map((slot) =>
      Option.match(Option.flatMap(slot, decodeEndings), {
        onNone: () => ({ total: 0, newest: undefined }),
        onSome: (endings) => ({
          total: endings.omitted + endings.ended.length,
          newest: endings.ended.at(-1),
        }),
      }),
    ),
  );
}

/**
 * What a Session's goal endings mean for work this extension holds: nothing
 * when the work predates this count (a Session from before it existed has no
 * baseline, which is recorded now and never acted on), else the newest ending
 * if one came since the baseline.
 */
export function endingSince(
  seen: number | undefined,
  endings: GoalEndings,
): EndedGoal | "baseline" | undefined {
  if (seen === undefined) return "baseline";
  return endings.total > seen ? endings.newest : undefined;
}
