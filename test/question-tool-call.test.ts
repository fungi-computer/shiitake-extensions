import { CapabilityFailed } from "@fungi.computer/mycelium";
import { ExtensionStop } from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { toolCall } from "../src/question/tool-call.js";

it("fails a call on a stopped extension with CapabilityFailed naming the reason", async () => {
  const failure = await toolCall(
    "ask",
    Effect.fail(new ExtensionStop({ reason: "transact defect: disk full" })),
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(CapabilityFailed);
  expect(failure).toMatchObject({
    namespace: "question",
    operation: "ask",
    cause: {
      kind: "Unavailable",
      message:
        "The question tool stopped working in this Session: transact defect: disk full",
    },
  });
});

it("passes any other failure through unchanged", async () => {
  const other = new Error("invalid");
  await expect(toolCall("ask", Effect.fail(other))).rejects.toBe(other);
});

it("returns the value of a successful call", async () => {
  await expect(toolCall("ask", Effect.succeed(7))).resolves.toBe(7);
});
