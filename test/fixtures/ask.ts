import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import type { SandboxRequest, SandboxValue } from "@fungi.computer/mycelium";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { z } from "zod";
import { botanicalAgentExtensions } from "../../src/roster.js";
import { openAgent, sqliteOwner } from "./host.js";

export const questions = [
  {
    id: "storage",
    header: "Storage",
    question: "Which store should hold the notes?",
    options: [
      { label: "SQLite", description: "Keep notes on this computer." },
      { label: "PostgreSQL", description: "Use the shared database." },
    ],
  },
];

export async function questionHost(
  input: SandboxValue = { questions, mode: "continue" },
  options: Readonly<{
    priorInput?: SandboxValue;
    store?: ReturnType<typeof sqliteOwner>;
    afterResult?: () => Promise<void>;
    timeoutMs?: number;
    codes?: readonly string[];
    program?: (
      bindings: SandboxRequest["bindings"],
      code: string,
    ) => Promise<SandboxValue>;
  }> = {},
) {
  const store = options.store ?? sqliteOwner();
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage(
      (options.codes ?? ["question.ask"]).map((code) =>
        fauxToolCall("execute", { code }),
      ),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage("Continuing independent work."),
  ]);
  let result: SandboxValue;
  let offered: string[] = [];
  const host = await openAgent(store.owner, botanicalAgentExtensions, {
    model: {
      acquire: () =>
        Effect.succeed({
          model: faux.model,
          stream: faux.stream,
          release: Effect.void,
        }),
    },
    tools: {
      modules: [],
      sources: [],
      execution: { timeoutMs: options.timeoutMs ?? 180_000 },
      sandbox: fromTypedSandbox({
        execute: async (request) => {
          offered = Object.keys(request.bindings);
          const ask = request.bindings.question?.ask;
          if (ask === undefined)
            throw new Error("Ask capability is not offered");
          if (options.priorInput !== undefined) await ask(options.priorInput);
          const response =
            options.program === undefined
              ? await ask(input)
              : await options.program(request.bindings, request.code);
          result = response;
          await options.afterResult?.();
          return response;
        },
      }),
    },
  });
  return {
    store,
    host,
    result: () => result,
    park: async () => {
      await Effect.runPromise(
        host.agent.session("questions").send("Choose storage", {
          requestId: "choose-storage",
          delivery: "followUp",
        }),
      );
      await host.drain();
      expect(offered).toContain("question");
      return z
        .object({ status: z.literal("parked"), askId: z.string() })
        .parse(result);
    },
  };
}
