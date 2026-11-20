import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import * as Effect from "effect/Effect";
import { almanacContract } from "../../src/almanac/contract.js";
import { almanacExtension } from "../../src/almanac/host.js";
import { botanicalAgentExtensions } from "../../src/roster.js";
import { openAgent, sqliteOwner } from "./host.js";
import assert from "node:assert/strict";

/** Real schedule tool and owner with a deterministic model for Grove browser proof. */
export async function openBrowserAlmanac() {
  const store = sqliteOwner();
  const model = fauxModel([]);
  model.setResponses([
    fauxAssistantMessage(
      fauxToolCall("execute", { code: "create-weekday-schedule" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      "I will summarise your inbox every weekday at 08:00 UTC.",
    ),
  ]);
  const host = await openAgent(
    store.owner,
    {
      roster: [almanacExtension],
      grants: botanicalAgentExtensions.grants.filter(
        (grant) => grant.id === almanacContract.id,
      ),
    },
    {
      model: {
        acquire: () =>
          Effect.succeed({
            model: model.model,
            stream: model.stream,
            retryable: () => false,
            release: Effect.void,
          }),
      },
      tools: {
        modules: [],
        sources: [],
        sandbox: fromTypedSandbox({
          execute: async (request) => {
            assert.equal(request.code, "create-weekday-schedule");
            const schedule = request.bindings.schedule;
            assert.ok(schedule);
            if (!schedule.create) throw new Error("Schedule create is missing");
            return schedule.create({
              prompt: "Summarise my inbox",
              when: {
                kind: "cron",
                expression: "0 8 * * 1-5",
                timeZone: "UTC",
              },
            });
          },
        }),
      },
    },
  );
  return { host, store };
}
