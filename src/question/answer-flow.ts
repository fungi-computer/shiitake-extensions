import type { WhistleCatalogStepV1 } from "@fungi.computer/whistle/catalog";
import { ExtensionCommandError } from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import { ask, done, freshRequestId } from "../internal/catalog.js";
import { titleLimit } from "../internal/headline.js";
import {
  type Answers,
  type AnswerFlowInput,
  type Question,
} from "./contract.js";
import type * as Schema from "effect/Schema";

/** Drafts travel in catalog arguments; only an owner's answer commits them. */
export type FlowInput = Schema.Schema.Type<typeof AnswerFlowInput>;
type FlowDraft = Pick<
  Extract<FlowInput, { stage: "decision" }>,
  "askId" | "requestId" | "index" | "answers"
>;

/** Accept only picks the question offered, and a non-empty answer. */
function decisionAnswer(
  question: Question,
  answer: Extract<FlowInput, { stage: "decision" }>["answer"],
): Effect.Effect<Answers[string], ExtensionCommandError> {
  const offered = new Set(question.options.map((option) => option.label));
  const written = answer.text?.trim() ?? "";
  if (
    answer.selected.some((label) => !offered.has(label)) ||
    new Set(answer.selected).size !== answer.selected.length ||
    (question.multiple !== true && answer.selected.length > 1) ||
    (answer.selected.length === 0 && written === "")
  )
    return Effect.fail(
      new ExtensionCommandError({
        reason: "invalid",
        message: "Choose offered options or write an answer",
      }),
    );
  return Effect.succeed(
    written === ""
      ? { selected: answer.selected }
      : { selected: answer.selected, text: answer.text ?? "" },
  );
}

/**
 * The Agent's own words are the title only when they fit one; a longer
 * question gets a plain title and sits in the body, whole in the details.
 */
function questionHeading(question: Question) {
  const text = question.question.replace(/\s+/gu, " ").trim();
  if (text.length <= titleLimit) return { message: text };
  return {
    message: "The Agent has a question",
    body: question.question.slice(0, 4_000),
    bodyLabel: "Question",
    details: [{ label: "Question", value: question.question.slice(0, 4_000) }],
  };
}

function promptQuestion(
  nextQuestion: Question,
  next: FlowDraft,
  total: number,
) {
  const base = {
    type: "decision" as const,
    ...questionHeading(nextQuestion),
    options: nextQuestion.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
    other: {
      label: "Other…",
      placeholder: "Write your own answer",
      maxLength: 4_000,
    },
  };
  // Only present fields travel: the wire is JSON, which has no undefined.
  const numbered =
    total > 1
      ? {
          ...base,
          summary: `Question ${String(next.index + 1)} of ${String(total)}`,
        }
      : base;
  return ask(
    nextQuestion.multiple === true ? { ...numbered, multiple: true } : numbered,
    { stage: "decision", ...next },
    "answer",
  );
}

/** What the answer conversation does next for one open Ask. */
export type AnswerFlowOutcome =
  | Readonly<{ type: "step"; step: WhistleCatalogStepV1 }>
  | Readonly<{
      type: "complete";
      askId: string;
      requestId: string;
      answers: Answers;
    }>;

/**
 * Progress one Ask's answer draft by a single human step. The owner of the
 * Ask commits a completed set; a step only ever returns the next prompt, so
 * the same conversation serves the Ask's own Session and a parent's footer.
 */
export function advanceAnswerFlow(
  row: Readonly<{
    askId: string;
    questions: readonly Question[];
    closed: boolean;
  }>,
  input: FlowInput,
): Effect.Effect<AnswerFlowOutcome, ExtensionCommandError> {
  return Effect.gen(function* () {
    const draft =
      "stage" in input
        ? input
        : {
            stage: "start" as const,
            index: 0,
            requestId: yield* freshRequestId,
            answers: {},
          };
    let { index, answers } = draft;
    const { requestId } = draft;
    const question = row.questions[index];
    if (question === undefined)
      return yield* Effect.fail(
        new ExtensionCommandError({
          reason: "invalid",
          message: "Unknown question step",
        }),
      );
    const answer =
      draft.stage === "decision"
        ? yield* decisionAnswer(question, draft.answer)
        : undefined;
    if (answer !== undefined) {
      answers = { ...answers, [question.id]: answer };
      index += 1;
      if (index === row.questions.length)
        return {
          type: "complete" as const,
          askId: row.askId,
          requestId,
          answers,
        };
    }
    if (row.closed)
      return {
        type: "step" as const,
        step: done({
          type: "info",
          message: "That question is already closed.",
        }),
      };
    const next = { askId: row.askId, requestId, index, answers };
    const nextQuestion = row.questions[index];
    if (nextQuestion === undefined)
      throw new Error("Expected the next question");
    return {
      type: "step" as const,
      step: promptQuestion(nextQuestion, next, row.questions.length),
    };
  });
}
