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
  /** Identity used to associate this question with its answer. */
  id: text(32).check(Schema.isPattern(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u)),
  /** Short label shown above the question. */
  header: text(12),
  /** Decision presented to the person. */
  question: text(1_000),
  /** Offered choices, with the recommended choice first. */
  options: Schema.Array(
    Schema.Struct({
      /** Choice label returned in an answer's selection. */
      label: text(60),
      /** Explanation of the choice's trade-off. */
      description: text(300),
    }),
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
  /** Whether the person may select more than one offered choice. */
  multiple: Schema.optionalKey(Schema.Boolean),
});
/** Bounded question set with distinct question identities. */
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
/** One decoded decision question. */
export type Question = Schema.Schema.Type<typeof Question>;

/** The complete question data shared by ordinary Session clients. */
export const OpenAsk = Schema.Struct({
  /** Durable identity of the open ask. */
  askId: Schema.String,
  /** Decisions awaiting the person's answers. */
  questions: Questions,
  /** Whether the ask is live in a turn or parked for later. */
  status: Schema.Literals(["live", "parked"]),
  /** Creation timestamp. */
  createdAt: Schema.Number,
  /** Expiry timestamp, or null when none is set. */
  expiresAt: Schema.NullOr(Schema.Number),
});
/** One live or parked ask visible to Session clients. */
export type OpenAsk = Schema.Schema.Type<typeof OpenAsk>;
/** Bounded set of open asks projected into the Session. */
export const AskProjection = Schema.Struct({
  /** Currently visible live and parked asks. */
  asks: Schema.Array(OpenAsk).check(Schema.isMaxLength(4)),
});

/** Stable identity for a human command and its retry. */
export const RequestId = text(256);
/** Answers keyed by question id, with selected choices and optional free text. */
export const Answers = Schema.Record(
  Question.fields.id,
  Schema.Struct({
    /** Labels of the offered choices selected by the person. */
    selected: Schema.Array(text(60)).check(Schema.isMaxLength(4)),
    /** Optional free-text answer supplied by the person. */
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  }),
);
/** Decoded answers indexed by question identity. */
export type Answers = Schema.Schema.Type<typeof Answers>;
/** Idempotent human submission of a complete answer set. */
export const AnswerInput = Schema.Struct({
  /** Ask being answered. */
  askId: text(256),
  /** Stable identity shared by this command and its retries. */
  requestId: RequestId,
  /** Answers to the ask's question set. */
  answers: Answers,
});
/** Decoded human answer submission. */
export type AnswerInput = Schema.Schema.Type<typeof AnswerInput>;
/** Idempotent human refusal to answer an ask. */
export const DeclineInput = Schema.Struct({
  /** Ask being declined. */
  askId: text(256),
  /** Stable identity shared by this command and its retries. */
  requestId: RequestId,
  /** Optional explanation for declining. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});
/** Decoded human decline submission. */
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
/** Admission, already-closed state, or absence returned to a human reply. */
export const HumanResult = Schema.Union([
  Schema.Struct({
    /** Reply was accepted. */
    result: Schema.Literal("accepted"),
    /** Whether the reply resumed its turn or became a follow-up. */
    via: Schema.Literals(["in_turn", "follow_up"]),
  }),
  Schema.Struct({
    /** Ask had already reached a terminal state. */
    result: Schema.Literal("closed"),
    /** Terminal state that prevented another answer. */
    status: ClosedStatus,
  }),
  Schema.Struct({
    /** No ask with this identity exists. */
    result: Schema.Literal("not_found"),
  }),
]);
/** Decoded outcome of a human answer or decline. */
export type HumanResult = Schema.Schema.Type<typeof HumanResult>;

const answerStep = {
  /** Ask whose answer draft is being edited. */
  askId: AnswerInput.fields.askId,
  /** Identity of the eventual answer command. */
  requestId: RequestId,
  /** Zero-based question being edited. */
  index: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 3 }),
  ),
  /** Answers accumulated by preceding conversation steps. */
  answers: Answers,
};
/** The ordinary /answer conversation carries its draft between typed steps. */
export const AnswerFlowInput = Schema.Union([
  Schema.Struct({
    /** Multiple-choice selection step. */
    stage: Schema.Literal("multiple"),
    ...answerStep,
    /** Encoded selection supplied by the human control. */
    selection: Schema.String.check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    /** Single-choice selection step. */
    stage: Schema.Literal("selection"),
    ...answerStep,
    /** Encoded selection supplied by the human control. */
    selection: Schema.String.check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    /** Free-text answer step. */
    stage: Schema.Literal("text"),
    ...answerStep,
    /** Offered choices retained while entering free text. */
    selected: Answers.value.fields.selected,
    /** Free-text answer supplied by the person. */
    text: Schema.String.check(Schema.isMaxLength(4_000)),
  }),
  Schema.Struct({
    /** Ask whose answer conversation should be opened. */
    askId: AnswerInput.fields.askId,
  }),
  Schema.Struct({}),
]);

/** Human reads and the ordinary projection slot; model operations belong to the host. */
export const questionContract = {
  /** Stable extension identity. */
  id: ExtensionId.make("botanical-session-question"),
  /** Human question controls admitted by the Session owner. */
  commands: {
    /** Advance the server-owned answer conversation. */
    answerFlow: {
      /** The Session owns its asks and replies. */
      scope: "session",
      /** Decode the current answer-draft step. */
      input: AnswerFlowInput,
      /** Return the next human conversation step. */
      output: CatalogStep,
    },
    /** Submit a person's completed answers. */
    answer: {
      /** The Session owns this ask. */
      scope: "session",
      /** Decode the answer submission. */
      input: AnswerInput,
      /** Return admission or the ask's terminal state. */
      output: HumanResult,
    },
    /** Decline an ask with an optional note. */
    decline: {
      /** The Session owns this ask. */
      scope: "session",
      /** Decode the decline submission. */
      input: DeclineInput,
      /** Return admission or the ask's terminal state. */
      output: HumanResult,
    },
    /** Read the Session's open asks. */
    list: {
      /** The Session owns the ask collection. */
      scope: "session",
      /** No additional arguments are required. */
      input: Schema.Struct({}),
      /** Decode the currently visible asks. */
      output: AskProjection,
    },
  },
  /** Open asks visible to Session clients. */
  projection: {
    /** Decoder for projected asks. */
    schema: AskProjection,
  },
} as const;
