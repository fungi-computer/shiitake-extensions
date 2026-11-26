import { expect, it } from "vitest";

import * as Schema from "effect/Schema";
import { AskProjection, type ClosedOutcome } from "../src/question/contract.js";
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
  ).toBe("You chose: Work on a project");
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
  expect(line(value, "t")).toBe("You chose: Moss, “or Fern”");
  expect(line(value, "g")).toBe("An Agent answered: Keep");
  expect(line(value, "e")).toBe(
    "Nobody answered in time, so it went with: Keep",
  );
  expect(line(value, "s")).toBe(
    "Nobody answered in time, so nothing was decided",
  );
  expect(line(value, "d")).toBe("You declined the question");
});

it("leaves a message alone without outcomes, and never reads message text", () => {
  expect(line({ asks: [] }, "a1")).toBeUndefined();
  expect(line(slot([]), null)).toBeUndefined();
  // An outcome that is no longer kept reads as closed, never as a chosen answer.
  expect(line(slot([]), "gone")).toBe("Question closed");
});
