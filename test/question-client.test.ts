import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { clientContributionSchemaV1 } from "@fungi.computer/shiitake/client-entry";
import questionClient from "../src/question/client.js";
import { AskProjection } from "../src/question/contract.js";

const question = {
  id: "color",
  header: "Color",
  question: "Which color should we use?",
  options: [
    { label: "Blue", description: "Use the blue theme" },
    { label: "Green", description: "Use the green theme" },
  ],
};
const ask = (askId: string) => ({
  askId,
  questions: [question],
  status: "parked" as const,
  createdAt: 1,
  expiresAt: null,
});
const encode = Schema.encodeSync(AskProjection);
const admitted = Schema.decodeUnknownSync(clientContributionSchemaV1);
function rows(asks: ReturnType<typeof ask>[]) {
  if (questionClient.contribute === undefined)
    throw new Error("Missing Ask contribution");
  return admitted(
    questionClient.contribute({
      status: "running",
      revision: "sha256:ask-test",
      value: encode({ asks }),
      catalog: { protocol: "whistle.catalog/v1", commands: [] },
    }),
  ).panel;
}

it("publishes pending questions as footer rows with their existing advertised answer intent", () => {
  expect(rows([ask("ask-one")])).toEqual([
    {
      id: "ask-one",
      title: "Which color should we use?",
      detail: "Blue · Green",
      tone: "attention",
      actions: [
        { id: "answerFlow", label: "Answer", input: { askId: "ask-one" } },
      ],
    },
  ]);
});

it("keeps independent pending questions and removes answered or declined projections", () => {
  expect(rows([ask("ask-one"), ask("ask-two")]).map((row) => row.id)).toEqual([
    "ask-one",
    "ask-two",
  ]);
  expect(rows([ask("ask-two")]).map((row) => row.id)).toEqual(["ask-two"]);
  expect(rows([])).toEqual([]);
});

it("contributes nothing before observation or after detach", () => {
  expect(questionClient.contribute?.(undefined).panel).toEqual([]);
  expect(
    questionClient.contribute?.({
      status: "stopped",
      revision: "sha256:stopped",
      reason: "Detached",
    }).panel,
  ).toEqual([]);
});
