import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { CatalogStep } from "../internal/catalog.js";

const text = (maximum: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
    Schema.isPattern(/\S/u),
  );
/** A decision question: first option is recommended, free text belongs to the host. */
export const Question = Schema.Struct({
  id: text(32).check(Schema.isPattern(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u)),
  header: text(12),
  question: text(1_000),
  options: Schema.Array(
    Schema.Struct({ label: text(60), description: text(300) }),
  ).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(4),
    Schema.makeFilter(
      (options) =>
        new Set(options.map((option) => option.label)).size ===
          options.length || "Option labels must be unique",
      {
        representation: {
          id: "botanical/ask/unique-option-labels",
          payload: null,
        },
      },
    ),
  ),
  multiple: Schema.optionalKey(Schema.Boolean),
});
export const Questions = Schema.Array(Question).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4),
  Schema.makeFilter(
    (questions) =>
      new Set(questions.map((question) => question.id)).size ===
        questions.length || "Question ids must be unique",
    {
      representation: {
        id: "botanical/ask/unique-question-ids",
        payload: null,
      },
    },
  ),
);
export type Question = Schema.Schema.Type<typeof Question>;

/** The complete question data shared by ordinary Session clients. */
export const OpenAsk = Schema.Struct({
  askId: Schema.String,
  questions: Questions,
  status: Schema.Literals(["live", "parked"]),
  createdAt: Schema.Number,
  expiresAt: Schema.NullOr(Schema.Number),
});
export type OpenAsk = Schema.Schema.Type<typeof OpenAsk>;
export const AskProjection = Schema.Struct({
  asks: Schema.Array(OpenAsk).check(Schema.isMaxLength(4)),
});

/** Stable identity for a human command and its retry. */
export const RequestId = text(256);
export const Answers = Schema.Record(
  Question.fields.id,
  Schema.Struct({
    selected: Schema.Array(text(60)).check(Schema.isMaxLength(4)),
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  }),
);
export type Answers = Schema.Schema.Type<typeof Answers>;
export const AnswerInput = Schema.Struct({
  askId: text(256),
  requestId: RequestId,
  answers: Answers,
});
export type AnswerInput = Schema.Schema.Type<typeof AnswerInput>;
export const DeclineInput = Schema.Struct({
  askId: text(256),
  requestId: RequestId,
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type DeclineInput = Schema.Schema.Type<typeof DeclineInput>;
/** Terminal question outcomes, shared by human replies and model withdrawal. */
export const ClosedStatus = Schema.Literals([
  "answered",
  "declined",
  "withdrawn",
  "expired",
  "cancelled",
  "undeliverable",
]);
export const HumanResult = Schema.Union([
  Schema.Struct({
    result: Schema.Literal("accepted"),
    via: Schema.Literals(["in_turn", "follow_up"]),
  }),
  Schema.Struct({
    result: Schema.Literal("closed"),
    status: ClosedStatus,
  }),
  Schema.Struct({ result: Schema.Literal("not_found") }),
]);
export type HumanResult = Schema.Schema.Type<typeof HumanResult>;

const answerStep = {
  askId: AnswerInput.fields.askId,
  requestId: RequestId,
  index: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 3 }),
  ),
  answers: Answers,
};
/** The ordinary /answer conversation carries its draft between typed steps. */
export const AnswerFlowInput = Schema.Union([
  Schema.Struct({
    stage: Schema.Literal("multiple"),
    ...answerStep,
    selection: Schema.String.check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    stage: Schema.Literal("selection"),
    ...answerStep,
    selection: Schema.String.check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    stage: Schema.Literal("text"),
    ...answerStep,
    selected: Answers.value.fields.selected,
    text: Schema.String.check(Schema.isMaxLength(4_000)),
  }),
  Schema.Struct({ askId: AnswerInput.fields.askId }),
  Schema.Struct({}),
]);

/** Human reads and the ordinary projection slot; model operations belong to the host. */
export const questionContract = {
  id: ExtensionId.make("botanical-session-question"),
  commands: {
    answerFlow: {
      scope: "session",
      input: AnswerFlowInput,
      output: CatalogStep,
    },
    answer: { scope: "session", input: AnswerInput, output: HumanResult },
    decline: { scope: "session", input: DeclineInput, output: HumanResult },
    list: { scope: "session", input: Schema.Struct({}), output: AskProjection },
  },
  projection: { schema: AskProjection },
} as const;
