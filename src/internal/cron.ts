import { nextOccurrence as coreNextOccurrence } from "@fungi.computer/almanac";
import { ExtensionCommandError } from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/** The first occurrence strictly after `after`; missed occurrences coalesce. */
export function nextOccurrence(
  cadence: Parameters<typeof coreNextOccurrence>[0],
  after: number,
): Effect.Effect<number, ExtensionCommandError> {
  const next = coreNextOccurrence(cadence, after);
  return Result.isFailure(next)
    ? Effect.fail(
        new ExtensionCommandError({
          reason: "invalid",
          message: next.failure.message,
        }),
      )
    : Effect.succeed(next.success);
}
