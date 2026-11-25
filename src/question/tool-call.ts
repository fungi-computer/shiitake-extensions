import { CapabilityFailed } from "@fungi.computer/mycelium";
import { ExtensionStop } from "@fungi.computer/shiitake/extensions";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * Run one question transaction for a tool call. A stopped extension reaches
 * the Agent with its own reason, never as a bare "operation failed".
 */
export async function toolCall<A>(
  operation: string,
  run: Effect.Effect<A, unknown>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(run);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.squash(exit.cause);
  if (failure instanceof ExtensionStop)
    throw new CapabilityFailed({
      namespace: "question",
      operation,
      cause: {
        kind: "Unavailable",
        message: `The question tool stopped working in this Session: ${failure.reason}`,
      },
    });
  throw failure;
}
