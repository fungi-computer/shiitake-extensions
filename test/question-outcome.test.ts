import { expect, it } from "vitest";

import * as Schema from "effect/Schema";
import { AskProjection, ClosedOutcome } from "../src/question/contract.js";
import questionClient from "../src/question/client.js";

const id = "botanical-session-question";
const line = (value: typeof AskProjection.Type, correlation: string | null) =>
  questionClient.describeMessage?.(
    { correlation },
    {
      status: "running",
      revision: "sha256:test",
      value: Schema.encodeSync(AskProjection)(value),
      catalog: { protocol: "whistle.catalog/v1", commands: [] },
    },
  );
const slot = (closed: ClosedOutcome[]) => ({ asks: [], closed });

it("is the question client's own reading of its follow-up message", () => {
  expect(questionClient.id).toBe(id);
  expect(questionClient.describeMessage).toBeDefined();
});

it("names the person's choice from the closed outcome, not from message text", () => {
  expect(
    line(
      slot([
        {
          askId: "a1",
          status: "answered",
          answers: { setup: { selected: ["Work on a project"] } },
        },
      ]),
      "a1",
    ),
  ).toEqual({ text: "Work on a project", own: true });
});

it("shows typed text with a pick, an Agent's answer, a default applied on expiry, and a decline", () => {
  const value = slot([
    {
      askId: "t",
      status: "answered",
      answers: { n: { selected: ["Moss"], text: "or Fern" } },
    },
    {
      askId: "g",
      status: "answered",
      answeredBy: { kind: "agent", agentId: "agent-1" },
      answers: { n: { selected: ["Keep"] } },
    },
    {
      askId: "e",
      status: "expired",
      action: "proceed_with_recommended",
      answers: { n: { selected: ["Keep"] } },
    },
    { askId: "s", status: "expired", action: "stop" },
    { askId: "d", status: "declined" },
  ]);
  expect(line(value, "t")).toEqual({ text: "Moss, “or Fern”", own: true });
  expect(line(value, "g")).toEqual({
    text: "An Agent answered: Keep",
    own: false,
  });
  expect(line(value, "e")).toEqual({
    text: "Nobody answered in time, so it went with: Keep",
    own: false,
  });
  expect(line(value, "s")).toEqual({
    text: "Nobody answered in time, so nothing was decided",
    own: false,
  });
  expect(line(value, "d")).toEqual({
    text: "You declined the question",
    own: false,
  });
});

it("leaves a message alone without outcomes, and never reads message text", () => {
  expect(line({ asks: [] }, "a1")).toBeUndefined();
  expect(line(slot([]), null)).toBeUndefined();
  // An outcome that is no longer kept reads as closed, never as a chosen answer.
  expect(line(slot([]), "gone")).toEqual({
    text: "Question closed",
    own: false,
  });
});

it("names the person's answer to the tool call that asked, and nothing for another call", () => {
  const value = Schema.encodeSync(AskProjection)(
    slot([
      {
        askId: "a1",
        toolCallId: "call-1",
        status: "answered",
        answers: { setup: { selected: ["Explore together"] } },
      },
    ]),
  );
  const read = (toolCallId: string) =>
    questionClient.describeToolCall?.(toolCallId, {
      status: "running",
      revision: "sha256:test",
      value,
      catalog: { protocol: "whistle.catalog/v1", commands: [] },
    });
  expect(read("call-1")).toEqual({ text: "Explore together", own: true });
  expect(read("call-2")).toBeUndefined();
});

it("shows no tool-call line for an answer that reached the Agent as a follow-up message", () => {
  const value = Schema.encodeSync(AskProjection)(
    slot([
      {
        // No toolCallId: a parked ask's answer is shown at its follow-up.
        askId: "a1",
        status: "answered",
        answers: { setup: { selected: ["Explore together"] } },
      },
    ]),
  );
  const view = {
    status: "running" as const,
    revision: "sha256:test",
    value,
    catalog: { protocol: "whistle.catalog/v1" as const, commands: [] },
  };
  expect(questionClient.describeToolCall?.("call-1", view)).toBeUndefined();
  expect(questionClient.describeMessage?.({ correlation: "a1" }, view)).toEqual(
    {
      text: "Explore together",
      own: true,
    },
  );
});

// Stored data: closed outcomes written before the tool call was recorded have
// no toolCallId, and an older reader meets rows that have one.
const oldOutcomes = Schema.Struct({
  askId: Schema.String,
  status: Schema.Literals(["answered", "declined", "expired"]),
  answers: Schema.optionalKey(ClosedOutcome.fields.answers),
});

it("reads an outcome stored without a toolCallId and renders it", () => {
  const stored = {
    askId: "a1",
    status: "answered",
    answers: { s: { selected: ["Moss"] } },
  };
  const decoded = Schema.decodeUnknownSync(ClosedOutcome)(stored);
  expect(decoded.toolCallId).toBeUndefined();
  expect(line(slot([decoded]), "a1")).toEqual({ text: "Moss", own: true });
});

it("lets an older reader decode an outcome that has a toolCallId, ignoring the key", () => {
  const written = Schema.encodeSync(ClosedOutcome)({
    askId: "a1",
    toolCallId: "call-1",
    status: "answered",
    answers: { s: { selected: ["Moss"] } },
  });
  const decoded = Schema.decodeUnknownSync(oldOutcomes)(written);
  expect(decoded.askId).toBe("a1");
  expect("toolCallId" in decoded).toBe(false);
});
