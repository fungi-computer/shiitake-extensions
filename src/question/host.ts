import { nanoid } from "@fungi.computer/cairn";
import { Mycelium, type InvocationContext } from "@fungi.computer/mycelium";
import {
  defineCollection,
  defineExtension,
  ExtensionCommandError,
  type RosteredExtensionV0,
  type ExtensionContextV0,
  type ExtensionCommandCallerV0,
  AttentionRecipientSchema,
  type AttentionRecipient,
  AttentionEscalationSchema,
  type AttentionEscalation,
  type SettledRunV0,
} from "@fungi.computer/shiitake/extensions";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { z } from "zod";
import { catalog, done } from "../internal/catalog.js";
import { toolCall } from "./tool-call.js";
import { endingSince, goalEndings } from "../internal/goal-ended.js";
import {
  questionContract,
  OpenAsk,
  Questions,
  Answers,
  HumanResult,
  AgentAnswerResult,
  AnsweredBy,
  EscalateResult,
  type AnswerInput,
  DeclineInput,
  ClosedStatus,
  ClosedOutcome,
  recentOutcomeLimit,
  AnswerFlowInput,
  hubApprovalCaller,
} from "./contract.js";
import {
  advanceAnswerFlow,
  closedQuestionNotice,
  type FlowInput,
} from "./answer-flow.js";

const config = {
  maximumOpen: 4,
  // A live wait holds one tool call open; the sandbox gate cuts a call at 120 s,
  // so the wait parks well before that and the answer arrives as a follow-up.
  liveWindowMs: 90_000,
  // The sandbox gate cuts a call 120 s after the execute starts, however late
  // the ask comes, so the live wait never runs past 110 s from that start.
  transportBoundMs: 110_000,
  // Check presence, never escalate merely because a present Agent took time.
  senderCheckMs: 900_000,
  routesToSender: false,
  idle: "Need a person's decision? forage.describe({path:'question'}) first.",
  guide:
    "Question tools: ask, withdraw. Use question.ask for decisions that need a person's answer. Put the recommended option first; do not add Other, since free text is always available. Use credential tools for secrets. While a question is parked, finish independent work and end the turn.",
  askDescription:
    'Ask a person one or more questions; options follow the question module rules. The call waits up to 90 seconds for the answer, then parks: end your turn and the answer arrives later as a follow-up (mode "continue" parks at once). Asking the same question again joins the open one. When another Agent sent you this work, your question goes to that Agent first and always parks: end your turn, and its answer arrives as a follow-up.',
};
const Response = Schema.Union([
  Schema.Struct({ status: Schema.Literal("answered"), answers: Answers }),
  Schema.Struct({
    status: Schema.Literal("answered"),
    answers: Answers,
    answeredBy: AnsweredBy,
  }),
  Schema.Struct({
    status: Schema.Literal("declined"),
    note: DeclineInput.fields.note,
  }),
  Schema.Struct({
    status: Schema.Literal("expired"),
    action: Schema.Literal("stop"),
  }),
  Schema.Struct({
    status: Schema.Literal("expired"),
    action: Schema.Literal("proceed_with_recommended"),
    answers: Answers,
  }),
]);
type Response = Schema.Schema.Type<typeof Response>;
const AskRow = Schema.Struct({
  askId: OpenAsk.fields.askId,
  waitingOn: Schema.optional(AttentionRecipientSchema),
  escalated: Schema.optional(AttentionEscalationSchema),
  toolCallId: Schema.optional(Schema.String),
  questions: Questions,
  status: OpenAsk.fields.status,
  createdAt: OpenAsk.fields.createdAt,
  expiry: Schema.NullOr(
    Schema.Struct({
      at: Schema.Number,
      action: Schema.Literals(["stop", "proceed_with_recommended"]),
    }),
  ),
  sessionId: Schema.String,
  workId: Schema.String,
  digest: Schema.String,
  runAttemptId: Schema.NullOr(Schema.String),
  pending: Schema.NullOr(Response),
});
type AskRow = Schema.Schema.Type<typeof AskRow>;
const Outcome = Schema.Union([
  Response,
  Schema.Struct({ status: Schema.Literal("withdrawn") }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({
    status: Schema.Literal("undeliverable"),
    reason: Schema.String,
  }),
]);
const ClosedAsk = Schema.Struct({
  ...AskRow.fields,
  status: Schema.Literal("settled"),
  outcome: Outcome,
  replay: Schema.Literals(["parked", "outcome", "none"]),
  delivery: Schema.Union([
    Schema.Struct({ via: Schema.Literal("none") }),
    Schema.Struct({
      via: Schema.Literal("in_turn"),
      status: Schema.Literals(["pending", "settled"]),
    }),
    Schema.Struct({
      via: Schema.Literal("follow_up"),
      workId: Schema.String,
      status: Schema.Literals(["pending", "settled", "withdrawn"]),
    }),
  ]),
});
const Receipt = Schema.Struct({
  id: Schema.String,
  digest: Schema.String,
  sessionId: Schema.String,
  requestId: Schema.String,
  payload: Schema.String,
  result: AgentAnswerResult,
});
const collections = {
  deliveries: defineCollection(
    Schema.Struct({
      id: Schema.String,
      workId: Schema.String,
      askId: Schema.String,
      toolCallId: Schema.String,
    }),
    {
      key: (row) => row.id,
      index: (row) => row.workId,
    },
  ),
  recent: defineCollection(
    Schema.Struct({
      sessionId: Schema.String,
      outcomes: Schema.Array(ClosedOutcome),
    }),
    { key: (row) => row.sessionId, index: () => null },
  ),
  closed: defineCollection(ClosedAsk, {
    key: (row) => row.askId,
    index: (row) => (row.replay === "none" ? null : row.digest),
  }),
  receipts: defineCollection(Receipt, {
    key: (row) => row.id,
    index: (row) => row.digest,
  }),
  /** The Session and approval a hold's expiry timer clears; its id is the timer's hashed key. */
  holds: defineCollection(
    Schema.Struct({
      id: Schema.String,
      sessionId: Schema.String,
      approvalId: Schema.String,
    }),
    { key: (row) => row.id, index: (row) => row.sessionId },
  ),
  /** How many ended goals each Session's open asks were last reconciled against. */
  goalEnds: defineCollection(
    Schema.Struct({ sessionId: Schema.String, total: Schema.Int }),
    { key: (row) => row.sessionId, index: () => null },
  ),
  asks: defineCollection(AskRow, {
    key: (row) => row.askId,
    index: (row) => row.sessionId,
  }),
};
type Context = ExtensionContextV0<typeof collections, typeof config>;

/** Property order and an omitted false flag do not make a different question. */
function questionDigest(
  sessionId: string,
  workId: string,
  questions: AskRow["questions"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        sessionId,
        workId,
        questions.map((question) => [
          question.id,
          question.header,
          question.question,
          question.options.map((option) => [option.label, option.description]),
          question.multiple ?? false,
        ]),
      ]),
    )
    .digest("hex");
}

function parkAsk(ctx: Context, row: AskRow) {
  return Effect.gen(function* () {
    const parked: AskRow = { ...row, status: "parked", runAttemptId: null };
    yield* ctx.state.asks.put(parked);
    yield* ctx.observe(row.sessionId);
    return parked;
  });
}

function closedReplay(
  outcome: Schema.Schema.Type<typeof Outcome>,
  followUpWorkId: string | null,
) {
  if (outcome.status === "cancelled") return "none" as const;
  if (followUpWorkId !== null) return "parked" as const;
  return "outcome" as const;
}

/** Every terminal transition commits outcome, delivery and visibility together. */
function closeAsk(
  ctx: Context,
  row: AskRow,
  outcome: Schema.Schema.Type<typeof Outcome>,
  followUpWorkId: string | null = null,
  toolCallId?: string,
) {
  return Effect.gen(function* () {
    yield* ctx.state.closed.put({
      ...row,
      pending: null,
      runAttemptId: null,
      status: "settled",
      outcome,
      replay: closedReplay(outcome, followUpWorkId),
      delivery:
        followUpWorkId !== null
          ? { via: "follow_up", workId: followUpWorkId, status: "pending" }
          : outcome.status === "answered" ||
              outcome.status === "declined" ||
              outcome.status === "expired"
            ? {
                via: "in_turn",
                status: toolCallId === undefined ? "settled" : "pending",
              }
            : { via: "none" },
    });
    if (toolCallId !== undefined) yield* recordDelivery(ctx, row, toolCallId);
    yield* rememberOutcome(
      ctx,
      row,
      outcome,
      followUpWorkId === null ? toolCallId : undefined,
    );
    yield* ctx.state.asks.remove(row.askId);
    if (row.expiry !== null) yield* ctx.timers.cancel(`ask:${row.askId}`);
    if (row.waitingOn !== undefined)
      yield* ctx.timers.cancel(checkTimer(row.askId));
    yield* ctx.attention.clear(row.sessionId, row.askId);
    yield* ctx.observe(row.sessionId);
  });
}

/** The longest typed answer kept for the timeline; the Agent still gets all of it. */
const rememberedTextLimit = 500;

/** Keep what a closed ask resolved to, so the person's timeline can name it. */
function rememberOutcome(
  ctx: Context,
  row: AskRow,
  outcome: Schema.Schema.Type<typeof Outcome>,
  deliveredBy: string | undefined,
) {
  return Effect.gen(function* () {
    if (
      outcome.status !== "answered" &&
      outcome.status !== "declined" &&
      outcome.status !== "expired"
    )
      return;
    const remembered: ClosedOutcome = {
      askId: row.askId,
      status: outcome.status,
    };
    // Only an answer that went back as the tool call's result carries the call;
    // one that reached the Agent as a follow-up message shows at that message.
    if (deliveredBy !== undefined)
      Object.assign(remembered, { toolCallId: deliveredBy });
    if ("answers" in outcome)
      Object.assign(remembered, {
        answers: Object.fromEntries(
          Object.entries(outcome.answers).map(([id, answer]) => [
            id,
            answer.text === undefined
              ? answer
              : {
                  ...answer,
                  // By code point, so an emoji is never split.
                  text: Array.from(answer.text)
                    .slice(0, rememberedTextLimit)
                    .join(""),
                },
          ]),
        ),
      });
    if ("answeredBy" in outcome)
      Object.assign(remembered, { answeredBy: outcome.answeredBy });
    if (outcome.status === "expired")
      Object.assign(remembered, { action: outcome.action });
    const prior = yield* ctx.state.recent.get(row.sessionId);
    const outcomes = [
      remembered,
      ...(Option.isSome(prior)
        ? prior.value.outcomes.filter((entry) => entry.askId !== row.askId)
        : []),
    ].slice(0, recentOutcomeLimit);
    yield* ctx.state.recent.put({ sessionId: row.sessionId, outcomes });
  });
}

function recordDelivery(
  ctx: Context,
  row: Pick<AskRow, "askId" | "workId">,
  toolCallId: string,
) {
  return ctx.state.deliveries.put({
    id: JSON.stringify([row.askId, toolCallId]),
    askId: row.askId,
    workId: row.workId,
    toolCallId,
  });
}

function acknowledgeDelivery(
  ctx: Context,
  run: SettledRunV0,
  receipt: { askId: string; toolCallId: string },
) {
  return Effect.gen(function* () {
    const closed = yield* ctx.state.closed.get(receipt.askId);
    if (
      Option.isSome(closed) &&
      closed.value.delivery.via === "in_turn" &&
      closed.value.delivery.status === "pending" &&
      (yield* ctx.hasSuccessfulToolResult(run, receipt.toolCallId))
    )
      yield* ctx.state.closed.put({
        ...closed.value,
        delivery: { via: "in_turn", status: "settled" },
      });
  });
}

function recoverDelivery(ctx: Context, run: SettledRunV0, askId: string) {
  return Effect.gen(function* () {
    const closed = yield* ctx.state.closed.get(askId);
    if (
      Option.isSome(closed) &&
      closed.value.delivery.via === "in_turn" &&
      closed.value.delivery.status === "pending"
    ) {
      const row = closed.value;
      if (run.outcome === "cancelled")
        yield* closeAsk(
          ctx,
          { ...row, status: "parked" },
          { status: "cancelled" },
        );
      else if (
        row.outcome.status === "answered" ||
        row.outcome.status === "declined" ||
        row.outcome.status === "expired"
      )
        yield* deliverResponse(ctx, { ...row, status: "parked" }, row.outcome);
    }
  });
}

/** A returned value is acknowledged only after Mule has durably saved its result. */
function reconcileDeliveries(ctx: Context, run: SettledRunV0) {
  return Effect.gen(function* () {
    // First acknowledge every successful consumer. A failed parallel consumer
    // must not resend an answer another consumer durably received.
    let after: string | undefined;
    for (;;) {
      const page = yield* ctx.state.deliveries.page({
        index: run.workId,
        after,
        limit: 64,
      });
      if (page.length === 0) break;
      for (const receipt of page) {
        yield* acknowledgeDelivery(ctx, run, receipt);
        after = receipt.id;
      }
    }
    for (;;) {
      const page = yield* ctx.state.deliveries.page({
        index: run.workId,
        limit: 64,
      });
      if (page.length === 0) break;
      for (const receipt of page) {
        yield* recoverDelivery(ctx, run, receipt.askId);
        yield* ctx.state.deliveries.remove(receipt.id);
      }
    }
  });
}

function settleFollowUp(ctx: Context, run: SettledRunV0) {
  return Effect.gen(function* () {
    if (
      run.origin?.extensionId === questionContract.id &&
      run.origin.correlation !== null
    ) {
      const closed = yield* ctx.state.closed.get(run.origin.correlation);
      if (Option.isSome(closed) && closed.value.sessionId === run.sessionId) {
        const row = closed.value;
        if (
          row.delivery.via === "follow_up" &&
          row.delivery.workId === run.workId &&
          row.delivery.status === "pending"
        )
          yield* ctx.state.closed.put({
            ...row,
            delivery: {
              ...row.delivery,
              status: run.outcome === "cancelled" ? "withdrawn" : "settled",
            },
          });
      }
    }
  });
}

function settle(ctx: Context, run: SettledRunV0) {
  return Effect.gen(function* () {
    yield* reconcileDeliveries(ctx, run);
    yield* settleFollowUp(ctx, run);
    const open = yield* ctx.state.asks.page({
      index: run.sessionId,
      limit: ctx.config.maximumOpen,
    });
    for (const row of open) {
      if (row.workId !== run.workId) continue;
      if (run.outcome === "cancelled")
        yield* closeAsk(ctx, row, { status: "cancelled" });
      else if (row.pending !== null)
        yield* deliverResponse(ctx, row, row.pending);
      else if (row.status === "live") yield* parkAsk(ctx, row);
    }
  });
}

/**
 * A goal that ended leaves no question behind: the asks still open on its
 * Session are withdrawn by code, never by the model remembering to.
 */
/** Record how many goals had ended when this ask opened; only later endings withdraw it. */
function baselineGoalEnds(ctx: Context, sessionId: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* ctx.state.goalEnds.get(sessionId))) return;
    const { total } = yield* goalEndings(ctx, sessionId);
    yield* ctx.state.goalEnds.put({ sessionId, total });
  });
}

function withdrawForEndedGoals(ctx: Context, sessionId: string) {
  return Effect.gen(function* () {
    const endings = yield* goalEndings(ctx, sessionId);
    const { total } = endings;
    const seen = yield* ctx.state.goalEnds.get(sessionId);
    const ending = endingSince(
      Option.isSome(seen) ? seen.value.total : undefined,
      endings,
    );
    if (ending === "baseline") {
      // Asks that predate the count are not this goal's to withdraw.
      yield* ctx.state.goalEnds.put({ sessionId, total });
      return;
    }
    if (ending === undefined) return;
    const open = yield* ctx.state.asks.page({
      index: sessionId,
      limit: ctx.config.maximumOpen,
    });
    for (const row of open)
      if (row.pending === null)
        yield* closeAsk(ctx, row, { status: "withdrawn" });
    yield* ctx.state.goalEnds.put({ sessionId, total });
    yield* ctx.observe(sessionId);
  });
}

function project(row: AskRow): OpenAsk {
  const open: OpenAsk = {
    askId: row.askId,
    questions: row.questions,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiry?.at ?? null,
  };
  if (row.toolCallId !== undefined)
    Object.assign(open, { toolCallId: row.toolCallId });
  if (row.escalated !== undefined)
    Object.assign(open, { escalated: row.escalated });
  return row.waitingOn === undefined
    ? open
    : { ...open, waitingOn: row.waitingOn };
}
const encoder = new TextEncoder();
/** Keep every question and selection represented within the follow-up byte budget. */
function clip(text: string, budget: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= budget) return text;
  const suffix = "… [truncated]";
  const room = budget - encoder.encode(suffix).length;
  if (room <= 0) return "";
  return (
    new TextDecoder().decode(bytes.subarray(0, room), { stream: true }) + suffix
  );
}
function responsePrompt(row: AskRow, response: Response): string {
  const prefix =
    response.status === "answered"
      ? "answeredBy" in response
        ? `Answer from Agent ${response.answeredBy.agentId} to ask ${row.askId}:\n`
        : `Answer to ask ${row.askId}:\n`
      : response.status === "declined"
        ? `Declined ask ${row.askId}:\n${response.note === undefined ? "" : `Note: ${clip(response.note, 2_048)}\n`}`
        : `Ask ${row.askId} expired; ${response.action === "stop" ? "do not proceed with this decision" : "recommended default"}:\n`;
  const perQuestion =
    Math.floor((8_192 - encoder.encode(prefix).length) / row.questions.length) -
    1;
  const byId =
    response.status === "answered" ||
    (response.status === "expired" &&
      response.action === "proceed_with_recommended")
      ? new Map(Object.entries(response.answers))
      : undefined;
  return (
    prefix +
    row.questions
      .map((question) => {
        const questionText = `${question.header} (${question.id}): ${clip(question.question, Math.floor(perQuestion / 3))}`;
        if (byId === undefined) return questionText;
        const answer = byId.get(question.id);
        if (answer === undefined)
          throw new Error("Validated answer is missing");
        const selection =
          answer.selected.length === 0
            ? "(free text)"
            : answer.selected.join(", ");
        const base = `${questionText}\nSelected: ${selection}`;
        if (answer.text === undefined || answer.text.length === 0) return base;
        const heading = base + "\nText: ";
        return (
          heading +
          clip(answer.text, perQuestion - encoder.encode(heading).length)
        );
      })
      .join("\n")
  );
}

/** Commands and settlement use the same atomic follow-up admission and closure. */
function deliverResponse(ctx: Context, row: AskRow, response: Response) {
  return Effect.gen(function* () {
    const delivered = yield* ctx
      .send({
        sessionId: row.sessionId,
        requireExistingSession: true,
        when: "now",
        correlation: row.askId,
        // The continued work keeps its sender, so a second question still waits on that Agent.
        continuesWorkId: row.workId,
        prompt: {
          text: responsePrompt(row, response),
          requestId: `ask:${row.askId}`,
          delivery: "followUp",
        },
      })
      .pipe(
        Effect.map((sent) =>
          sent._tag === "Accepted"
            ? { status: "sent" as const, workId: sent.commandId }
            : { status: "failed" as const, reason: "not_ready" },
        ),
        Effect.catchTag("AdmissionError", (error) =>
          Effect.succeed({ status: "failed" as const, reason: error.reason }),
        ),
      );
    const outcome: Schema.Schema.Type<typeof Outcome> =
      delivered.status === "sent"
        ? response
        : { status: "undeliverable", reason: delivered.reason };
    yield* closeAsk(
      ctx,
      row,
      outcome,
      delivered.status === "sent" ? delivered.workId : null,
    );
    return delivered.status === "sent"
      ? {
          result: "accepted" as const,
          via: "follow_up" as const,
          commandId: delivered.workId,
        }
      : { result: "closed" as const, status: "undeliverable" as const };
  });
}

/** Live responses await the tool; parked responses cross the send door now. */
function offerResponse(ctx: Context, row: AskRow, response: Response) {
  return Effect.gen(function* () {
    if (row.status === "parked")
      return yield* deliverResponse(ctx, row, response);
    yield* ctx.state.asks.put({ ...row, pending: response });
    yield* ctx.attention.clear(row.sessionId, row.askId);
    yield* ctx.observe(row.sessionId);
    return { result: "accepted" as const, via: "in_turn" as const };
  });
}

/** One expiry transition, shared by durable timers and a live waiter. */
function expireAsk(ctx: Context, row: AskRow, now: number) {
  return Effect.gen(function* () {
    if (row.expiry === null || now < row.expiry.at || row.pending !== null)
      return undefined;
    const response: Response =
      row.expiry.action === "stop"
        ? { status: "expired", action: "stop" }
        : {
            status: "expired",
            action: "proceed_with_recommended",
            answers: Object.fromEntries(
              row.questions.map((question) => [
                question.id,
                {
                  selected: question.options
                    .slice(0, 1)
                    .map((option) => option.label),
                },
              ]),
            ),
          };
    yield* offerResponse(ctx, row, response);
    return response;
  });
}

type ResponseInput =
  | ({ kind: "answer" } & AnswerInput)
  | ({ kind: "agent_answer"; caller: ExtensionCommandCallerV0 } & AnswerInput)
  | ({ kind: "decline" } & DeclineInput);
type ResponseResult = AgentAnswerResult;
function validAnswers(
  questions: AskRow["questions"],
  values: AnswerInput["answers"],
) {
  const answers = new Map(Object.entries(values));
  const valid =
    answers.size === questions.length &&
    questions.every((question) => {
      const answer = answers.get(question.id);
      return (
        answer !== undefined &&
        (question.multiple === true || answer.selected.length <= 1) &&
        new Set(answer.selected).size === answer.selected.length &&
        answer.selected.every((label) =>
          question.options.some((option) => option.label === label),
        ) &&
        (answer.selected.length > 0 || (answer.text?.trim().length ?? 0) > 0)
      );
    });
  return valid;
}

function responseIdentity(input: ResponseInput) {
  const response: Response =
    input.kind === "answer" || input.kind === "agent_answer"
      ? input.kind === "agent_answer"
        ? {
            status: "answered",
            answers: input.answers,
            answeredBy: { kind: "agent", agentId: input.caller.agentId },
          }
        : { status: "answered", answers: input.answers }
      : input.note === undefined
        ? { status: "declined" }
        : { status: "declined", note: input.note };
  const payload = JSON.stringify([
    input.kind,
    input.askId,
    input.kind === "answer" || input.kind === "agent_answer"
      ? Object.entries(input.answers)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, answer]) => [
            id,
            [...answer.selected].sort(),
            answer.text ?? null,
          ])
      : (input.note ?? null),
    input.kind === "agent_answer"
      ? [input.caller.agentId, input.caller.sessionId]
      : null,
  ]);
  return { response, payload };
}

function respond(ctx: Context, sessionId: string, input: ResponseInput) {
  return Effect.gen(function* () {
    const { response, payload } = responseIdentity(input);
    const receiptDigest = createHash("sha256")
      .update(JSON.stringify([sessionId, input.requestId]))
      .digest("hex");
    const prior = (yield* ctx.state.receipts.page({
      index: receiptDigest,
      limit: 1,
    }))[0];
    if (prior !== undefined) {
      if (prior.payload !== payload)
        return yield* Effect.fail(
          new ExtensionCommandError({
            reason: "conflict",
            message: "This request id was used for a different response",
          }),
        );
      return prior.result;
    }
    const record = (result: ResponseResult) =>
      ctx.state.receipts
        .put({
          id: nanoid(),
          digest: receiptDigest,
          sessionId,
          requestId: input.requestId,
          payload,
          result,
        })
        .pipe(Effect.as(result));
    const found = yield* ctx.state.asks.get(input.askId);
    if (Option.isNone(found) || found.value.sessionId !== sessionId) {
      const closed = yield* ctx.state.closed.get(input.askId);
      return yield* record(
        Option.isSome(closed) && closed.value.sessionId === sessionId
          ? { result: "closed", status: closed.value.outcome.status }
          : { result: "not_found" },
      );
    }
    const row = found.value;
    if (row.pending !== null)
      return yield* record({ result: "closed", status: row.pending.status });
    // A person may always answer; an Agent only when the ask waits on it.
    if (input.kind === "agent_answer" && !waitsOn(row, input.caller.agentId))
      // A refusal changes nothing, so it must not spend the request id.
      return { result: "refused", reason: "not_sender" } as const;
    if (input.kind === "answer" || input.kind === "agent_answer") {
      const valid = validAnswers(row.questions, input.answers);
      if (!valid)
        return yield* Effect.fail(
          new ExtensionCommandError({
            reason: "invalid",
            message:
              "Answer every question using its offered labels or nonempty text",
          }),
        );
    }
    return yield* record(yield* offerResponse(ctx, row, response));
  });
}

/**
 * Whether this ask waits on this Agent. Custody is the Agent's, not one of its
 * Sessions: any Session of the Agent may answer, escalate or be reminded.
 */
function waitsOn(row: AskRow, agentId: string): boolean {
  return row.waitingOn?.agentId === agentId;
}

function respondPerson(
  ctx: Context,
  sessionId: string,
  input: Exclude<ResponseInput, { kind: "agent_answer" }>,
) {
  return respond(ctx, sessionId, input).pipe(
    Effect.flatMap((result) =>
      result.result === "refused"
        ? Effect.fail(
            new ExtensionCommandError({
              reason: "rejected",
              message: "A person's response cannot be refused",
            }),
          )
        : Effect.succeed(result),
    ),
  );
}

/** The attention id of one Hub-parked approval, apart from the asks' own ids. */
function approvalAttentionId(approvalId: string): string {
  return `approval:${approvalId}`.slice(0, 128);
}

/** The id of a hold's row, hashed so a long Session and approval id never pass a timer key's cap. */
const holdId = (sessionId: string, approvalId: string) =>
  createHash("sha256")
    .update(JSON.stringify([sessionId, approvalId]))
    .digest("hex");
const holdTimerKey = (id: string) => `hold:${id}`;
/** A hold is cleared this long after its approval would have expired, if nothing released it. */
const holdExpiryMarginMs = 10 * 60_000;

/** Only the Hub host holds or releases an approval; a human client has no caller. */
function requireHub(
  caller: Readonly<{ agentId: string }> | undefined,
): Effect.Effect<void, ExtensionCommandError> {
  return caller?.agentId === hubApprovalCaller
    ? Effect.void
    : Effect.fail(
        new ExtensionCommandError({
          reason: "rejected",
          message: "Only the Hub host holds or releases an approval",
        }),
      );
}

/** The attention item for one open ask, waiting on an Agent or a person. */
function askAttention(row: AskRow) {
  const item = {
    id: row.askId,
    kind: "question" as const,
    summary: row.questions.map((question) => question.header).join(", "),
    since: row.createdAt,
  };
  if (row.escalated !== undefined)
    Object.assign(item, { escalated: row.escalated });
  const timed =
    row.expiry === null ? item : { ...item, expiresAt: row.expiry.at };
  return row.waitingOn === undefined
    ? timed
    : { ...timed, waitingOn: row.waitingOn };
}

/**
 * Durable presence checks are separate from the asker's own expiry.
 */
function checkTimer(askId: string): string {
  return `check:${askId}`;
}

/** Rows one reconciliation page reads; the collection's own page ceiling. */
const reconcilePage = 64;

/**
 * In an Agent another Agent made, a parked question that waits on a person
 * only because it was asked before its turns carried their maker goes to
 * that maker, as a new question would. A question a parent escalated stays
 * with the person. Running it again changes nothing.
 */
function routeParkedAsksToMaker(ctx: Context) {
  return Effect.gen(function* () {
    let after: string | undefined;
    for (;;) {
      const page = yield* ctx.state.asks.page({ after, limit: reconcilePage });
      for (const row of page) {
        if (
          row.status !== "parked" ||
          row.pending !== null ||
          row.waitingOn !== undefined ||
          row.escalated !== undefined
        )
          continue;
        const maker = yield* ctx.sessionMaker(row.sessionId);
        if (maker === null) continue;
        const moved: AskRow = { ...row, waitingOn: maker };
        yield* ctx.state.asks.put(moved);
        yield* ctx.timers.set(
          checkTimer(row.askId),
          (yield* Clock.currentTimeMillis) + ctx.config.senderCheckMs,
        );
        yield* ctx.attention.set(row.sessionId, askAttention(moved));
        yield* ctx.observe(row.sessionId);
      }
      const last = page.at(-1);
      if (page.length < reconcilePage || last === undefined) return;
      after = last.askId;
    }
  });
}

/** Hand an ask to a person, preserving why it left the Agent chain. */
function escalateAsk(
  ctx: Context,
  row: AskRow,
  escalated: AttentionEscalation,
) {
  return Effect.gen(function* () {
    const moved: AskRow = { ...row, waitingOn: undefined, escalated };
    yield* ctx.timers.cancel(checkTimer(row.askId));
    yield* ctx.state.asks.put(moved);
    yield* ctx.attention.set(row.sessionId, askAttention(moved));
    yield* ctx.observe(row.sessionId);
    return moved;
  });
}

function escalateFromAgent(
  ctx: Context,
  sessionId: string,
  askId: string,
  caller: ExtensionCommandCallerV0,
  note?: string,
  next?: AttentionRecipient | null,
) {
  return Effect.gen(function* () {
    const found = yield* ctx.state.asks.get(askId);
    if (Option.isNone(found) || found.value.sessionId !== sessionId) {
      const closed = yield* ctx.state.closed.get(askId);
      const missing: EscalateResult =
        Option.isSome(closed) && closed.value.sessionId === sessionId
          ? { result: "closed", status: closed.value.outcome.status }
          : { result: "not_found" };
      return missing;
    }
    const row = found.value;
    if (row.pending !== null) {
      const answered: EscalateResult = {
        result: "closed",
        status: row.pending.status,
      };
      return answered;
    }
    if (row.waitingOn === undefined || !waitsOn(row, caller.agentId)) {
      // Replaying the same handoff lets the host retry its idempotent parent
      // notification after an ambiguous transport failure, without moving it again.
      if (
        row.escalated?.reason === "escalated" &&
        row.escalated.by.agentId === caller.agentId &&
        row.escalated.note === note
      )
        return row.waitingOn === undefined
          ? ({ result: "escalated", to: "person" } as const)
          : ({
              result: "escalated",
              to: "agent",
              waitingOn: row.waitingOn,
            } as const);
      const refused: EscalateResult = {
        result: "refused",
        reason: "not_sender",
      };
      return refused;
    }
    // The escalating Session acts for the Agent the ask waits on.
    const by = {
      agentId: caller.agentId,
      sessionId: caller.sessionId,
      name: row.waitingOn.name,
    };
    // Preparation read the host outside SQLite. Do not use absent/stale evidence
    // as proof of a root; closed/replayed items above need no host lookup.
    if (next === undefined)
      return { result: "refused", reason: "not_sender" } as const;
    const provenance = {
      by,
      reason: "escalated",
    } satisfies AttentionEscalation;
    if (note !== undefined) Object.assign(provenance, { note });
    if (next !== null) {
      const moved: AskRow = {
        ...row,
        waitingOn: next,
        escalated: provenance,
      };
      yield* ctx.state.asks.put(moved);
      yield* ctx.attention.set(row.sessionId, askAttention(moved));
      yield* ctx.timers.set(
        checkTimer(row.askId),
        (yield* Clock.currentTimeMillis) + ctx.config.senderCheckMs,
      );
      yield* ctx.observe(row.sessionId);
      return { result: "escalated", to: "agent", waitingOn: next } as const;
    }
    // An explicit action keeps its actor even when the next parent is gone.
    // Automatic presence-check promotions still name the missing recipient.
    yield* escalateAsk(ctx, row, provenance);
    const escalated: EscalateResult = { result: "escalated", to: "person" };
    return escalated;
  });
}

// Mycelium's maintained operation interface uses Zod. The owner additionally
// decodes Questions for shared domain refinements and durable state.
const baseInput = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(32),
        header: z
          .string()
          .min(1)
          .max(12, "Question header must be at most 12 characters."),
        question: z.string().min(1).max(1_000),
        options: z
          .array(
            z.strictObject({
              label: z.string().min(1).max(60),
              description: z.string().min(1).max(300),
            }),
          )
          .min(2)
          .max(4),
        multiple: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(4),
  mode: z.enum(["wait", "continue"]).default("wait"),
});
const input = z.union([
  baseInput.extend({
    onExpire: z.strictObject({
      afterMinutes: z
        .number()
        .int()
        .min(5)
        .max(7 * 24 * 60),
      action: z.enum(["stop", "proceed_with_recommended"]),
    }),
  }),
  baseInput,
]);

const deadlineReserveMs = 60_000;
const pollIntervalMs = 1_000;

/** Wake on abort as well as the polling edge; durable state owns the response. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function waitForResponse(
  ctx: Context,
  askId: string,
  until: number,
  invocation: InvocationContext,
) {
  for (;;) {
    const next = await toolCall(
      "ask",
      ctx.transact(
        Effect.gen(function* () {
          const found = yield* ctx.state.asks.get(askId);
          if (invocation.signal.aborted) {
            if (Option.isSome(found)) yield* parkAsk(ctx, found.value);
            return { status: "aborted" as const };
          }
          if (Option.isNone(found)) {
            // A question closed or removed while its call waited is an ordinary
            // end (withdrawn, answered elsewhere, expired); a thrown defect
            // would stop the whole extension for the Session.
            const closed = yield* ctx.state.closed.get(askId);
            if (
              Option.isNone(closed) ||
              closed.value.outcome.status === "cancelled"
            )
              return { status: "withdrawn" as const };
            // A follow-up already carries the answer to the Agent; returning
            // it here too would deliver it twice.
            if (closed.value.delivery.via === "follow_up")
              return { status: "parked" as const, askId };
            // Same bookkeeping as a replayed in-turn answer, so settlement
            // can acknowledge this tool result.
            if (
              closed.value.delivery.via === "in_turn" &&
              closed.value.delivery.status === "pending" &&
              invocation.toolCallId !== undefined
            )
              yield* recordDelivery(ctx, closed.value, invocation.toolCallId);
            return closed.value.outcome;
          }
          const row = found.value;
          if (row.pending !== null) {
            yield* closeAsk(ctx, row, row.pending, null, invocation.toolCallId);
            return row.pending;
          }
          const now = yield* Clock.currentTimeMillis;
          const expired = yield* expireAsk(ctx, row, now);
          if (expired !== undefined) {
            yield* closeAsk(ctx, row, expired, null, invocation.toolCallId);
            return expired;
          }
          const pendingSteer = yield* ctx.hasPendingSteer({
            sessionId: row.sessionId,
            workId: row.workId,
          });
          if (now >= until || pendingSteer) {
            yield* parkAsk(ctx, row);
            return { status: "parked" as const, askId };
          }
          return {
            status: "waiting" as const,
            delay: Math.min(pollIntervalMs, until - now),
          };
        }),
      ),
    );
    if (next.status === "aborted") {
      invocation.signal.throwIfAborted();
      throw new Error("Aborted invocation has no abort reason");
    }
    if (next.status !== "waiting") return next;
    await pause(next.delay, invocation.signal);
  }
}

const toolAnswers = z.record(
  z.string(),
  z.union([
    z.strictObject({ selected: z.array(z.string()), text: z.string() }),
    z.strictObject({ selected: z.array(z.string()) }),
  ]),
);
const ToolResult = z.union([
  z.strictObject({ status: z.literal("withdrawn") }),
  z.strictObject({ status: z.literal("undeliverable"), reason: z.string() }),
  z.strictObject({
    status: z.literal("parked"),
    askId: z.string(),
  }),
  z.strictObject({
    status: z.literal("answered"),
    answers: toolAnswers,
  }),
  z.strictObject({
    status: z.literal("answered"),
    answers: toolAnswers,
    answeredBy: z.strictObject({
      kind: z.literal("parent"),
      agentId: z.string().min(1).max(256),
    }),
  }),
  z.strictObject({ status: z.literal("declined"), note: z.string() }),
  z.strictObject({ status: z.literal("declined") }),
  z.strictObject({ status: z.literal("expired"), action: z.literal("stop") }),
  z.strictObject({
    status: z.literal("expired"),
    action: z.literal("proceed_with_recommended"),
    answers: toolAnswers,
  }),
  z.strictObject({
    status: z.literal("refused"),
    reason: z.enum(["session_limit", "live_limit"]),
    askIds: z.array(z.string()),
  }),
]);

const WithdrawResult = z.union([
  z.strictObject({
    result: z.literal("closed"),
    status: z.enum(ClosedStatus.literals),
  }),
  z.strictObject({ result: z.literal("not_found") }),
]);

function withdraw(ctx: Context, sessionId: string, askId: string) {
  return Effect.gen(function* () {
    const found = yield* ctx.state.asks.get(askId);
    if (Option.isSome(found) && found.value.sessionId === sessionId) {
      const row = found.value;
      if (row.pending !== null)
        return { result: "closed" as const, status: row.pending.status };
      yield* closeAsk(ctx, row, { status: "withdrawn" });
      return { result: "closed" as const, status: "withdrawn" as const };
    }
    const closed = yield* ctx.state.closed.get(askId);
    return Option.isSome(closed) && closed.value.sessionId === sessionId
      ? { result: "closed" as const, status: closed.value.outcome.status }
      : { result: "not_found" as const };
  });
}

function answerNotice(result: HumanResult) {
  if (result.result === "accepted")
    return done({ type: "success", message: "Answer sent." });
  if (result.result === "closed") return closedQuestionNotice(result.status);
  return done({
    type: "info",
    message: "That question is no longer available.",
  });
}

function chooseQuestion(ctx: Context, sessionId: string, askId?: string) {
  return Effect.gen(function* () {
    if (askId !== undefined) return { type: "selected" as const, askId };
    const first = (yield* ctx.state.asks.page({
      index: sessionId,
      limit: ctx.config.maximumOpen,
    })).find((row) => row.pending === null);
    return first === undefined
      ? done({ type: "info", message: "No questions are waiting." })
      : { type: "selected" as const, askId: first.askId };
  });
}

function answerFlow(
  ctx: Context,
  sessionId: string,
  input: Schema.Schema.Type<typeof AnswerFlowInput>,
) {
  return Effect.gen(function* () {
    const selection = yield* chooseQuestion(
      ctx,
      sessionId,
      "askId" in input ? input.askId : undefined,
    );
    if (selection.type !== "selected") return selection;
    const { askId } = selection;
    const open = yield* ctx.state.asks.get(askId);
    const row =
      Option.getOrNull(open) ??
      Option.getOrNull(yield* ctx.state.closed.get(askId));
    if (row?.sessionId !== sessionId)
      return done({
        type: "info",
        message: "That question is no longer available.",
      });
    return yield* answerQuestion(ctx, sessionId, row, input);
  });
}

/** Progress the selected Ask's draft; request replay still belongs to respond. */
function answerQuestion(
  ctx: Context,
  sessionId: string,
  row: AskRow | Schema.Schema.Type<typeof ClosedAsk>,
  input: FlowInput,
) {
  return Effect.gen(function* () {
    const outcome = yield* advanceAnswerFlow(
      {
        askId: row.askId,
        questions: row.questions,
        closed:
          row.status === "settled"
            ? row.outcome.status
            : (row.pending?.status ?? false),
      },
      input,
    );
    if (outcome.type === "step") return outcome.step;
    const result = yield* respondPerson(ctx, sessionId, {
      kind: "answer",
      askId: outcome.askId,
      requestId: outcome.requestId,
      answers: outcome.answers,
    });
    return answerNotice(result);
  });
}

/** The question's content alone: the same words asked by a later turn are one question. */
function contentKey(questions: AskRow["questions"]): string {
  return JSON.stringify(
    questions.map((question) => [
      question.id,
      question.header,
      question.question,
      question.options.map((option) => [option.label, option.description]),
      question.multiple ?? false,
    ]),
  );
}

/** What an ask does when nobody answers: its action and how long it waits. */
function expiryKey(row: AskRow): string {
  return row.expiry === null
    ? "none"
    : JSON.stringify([
        row.expiry.action,
        Math.round((row.expiry.at - row.createdAt) / 60_000),
      ]);
}

function replayQuestion(
  ctx: Context,
  open: readonly AskRow[],
  workId: string,
  digest: string,
  key: string,
  expiry: string,
  toolCallId?: string,
) {
  return Effect.gen(function* () {
    const prior = open.find(
      (row) => row.workId === workId && row.digest === digest,
    );
    if (prior !== undefined) {
      if (prior.status === "parked" && prior.pending !== null) {
        yield* closeAsk(ctx, prior, prior.pending, null, toolCallId);
        return prior.pending;
      }
      return { status: "parked" as const, askId: prior.askId };
    }
    // The same question already open in this Session, asked by an earlier turn,
    // is that question: join it instead of stacking a second card.
    const joined = open.find(
      (row) =>
        row.workId !== workId &&
        row.pending === null &&
        row.waitingOn === undefined &&
        contentKey(row.questions) === key &&
        // A different expiry or action is a different decision: it never joins.
        expiryKey(row) === expiry,
    );
    if (joined !== undefined)
      return { status: "parked" as const, askId: joined.askId };
    const consumed = (yield* ctx.state.closed.page({
      index: digest,
      limit: 1,
    }))[0];
    if (consumed?.replay === "parked")
      return {
        status: "parked" as const,
        askId: consumed.askId,
      };
    if (
      consumed?.outcome.status === "answered" ||
      consumed?.outcome.status === "declined" ||
      consumed?.outcome.status === "expired" ||
      consumed?.outcome.status === "withdrawn" ||
      consumed?.outcome.status === "undeliverable"
    ) {
      if (
        consumed.delivery.via === "in_turn" &&
        consumed.delivery.status === "pending" &&
        toolCallId !== undefined
      )
        yield* recordDelivery(ctx, consumed, toolCallId);
      return consumed.outcome;
    }
    return undefined;
  });
}

function answerCatalog(available: boolean) {
  return catalog([
    {
      id: "answerFlow",
      title: "Answer a question",
      category: "Conversation",
      description: "Answer a waiting question",
      availability: available
        ? { status: "available" }
        : {
            status: "unavailable",
            reason: "There is no waiting question to answer.",
          },
    },
  ]);
}

/** One durable question owner over the ordinary extension doors. */
export function questionExtensionFor(
  routesToSender: boolean,
): RosteredExtensionV0 {
  const extensionConfig = { ...config, routesToSender };
  return defineExtension({
    id: questionContract.id,
    version: "2.0.0",
  })
    .config(extensionConfig)
    .state({ version: 1, migrations: {}, collections })
    .define({
      catalog: answerCatalog(false),
      attention: true,
      timers: true,
      hooks: {
        // Opening the Agent, as reading it does, re-routes what an older
        // build left with a person, once the Agent is bound.
        start: (ctx) =>
          ctx.config.routesToSender
            ? Effect.asVoid(
                Effect.forkScoped(
                  ctx
                    .transact(routeParkedAsksToMaker(ctx))
                    .pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("question.route_to_maker", cause),
                      ),
                    ),
                ),
              )
            : Effect.void,
        onSettled: (ctx, page) =>
          Effect.forEach(
            page,
            (run) =>
              settle(ctx, run).pipe(
                Effect.andThen(withdrawForEndedGoals(ctx, run.sessionId)),
              ),
            { discard: true },
          ),
        onTimer: {
          prepare: (ctx, timer) =>
            Effect.gen(function* () {
              const checked = timer.key.startsWith("check:")
                ? ctx.state.read(({ asks }) => asks.get(timer.key.slice(6)))
                : Option.none<AskRow>();
              const recipient = Option.isSome(checked)
                ? checked.value.waitingOn
                : undefined;
              const status =
                recipient === undefined
                  ? "unknown"
                  : yield* ctx.recipientStatus(recipient);
              return Effect.gen(function* () {
                if (timer.key.startsWith("check:")) {
                  const row = yield* ctx.state.asks.get(timer.key.slice(6));
                  if (
                    Option.isSome(row) &&
                    row.value.waitingOn !== undefined &&
                    row.value.pending === null
                  ) {
                    if (
                      recipient !== undefined &&
                      waitsOn(row.value, recipient.agentId) &&
                      (status === "archived" || status === "absent")
                    )
                      yield* escalateAsk(ctx, row.value, {
                        by: row.value.waitingOn,
                        reason:
                          status === "archived"
                            ? "sender_archived"
                            : "sender_absent",
                      });
                    else
                      yield* ctx.timers.set(
                        checkTimer(row.value.askId),
                        timer.firedAt + ctx.config.senderCheckMs,
                      );
                  }
                  return;
                }
                if (timer.key.startsWith("hold:")) {
                  const hold = yield* ctx.state.holds.get(timer.key.slice(5));
                  if (Option.isNone(hold)) return;
                  const { sessionId, approvalId } = hold.value;
                  yield* ctx.state.holds.remove(hold.value.id);
                  yield* ctx.attention.clear(
                    sessionId,
                    approvalAttentionId(approvalId),
                  );
                  yield* ctx.observe(sessionId);
                  return;
                }
                if (!timer.key.startsWith("ask:")) return;
                const row = yield* ctx.state.asks.get(timer.key.slice(4));
                if (Option.isSome(row))
                  yield* expireAsk(ctx, row.value, timer.firedAt);
              });
            }),
        },
      },
      prompt: (ctx) => [{ name: "question", text: ctx.config.idle }],
      projection: {
        schema: questionContract.projection.schema,
        catalog: (value) => answerCatalog(value.asks.length > 0),
        read: (ctx, sessionId) =>
          Option.some({
            asks: ctx.state.asks
              .peekPage({ index: sessionId, limit: ctx.config.maximumOpen })
              .filter((row) => row.pending === null)
              .map(project),
            closed: Option.match(ctx.state.recent.peek(sessionId), {
              onNone: () => [],
              onSome: (row) => row.outcomes,
            }),
          }),
      },
      commands: {
        specs: questionContract.commands,
        handlers: (ctx) => ({
          answerFlow: ({ sessionId, input }) =>
            answerFlow(ctx, sessionId, input),
          answer: ({ sessionId, input }) =>
            respondPerson(ctx, sessionId, { kind: "answer", ...input }),
          answerAgent: ({ sessionId, input, caller }) =>
            caller === undefined
              ? Effect.fail(
                  new ExtensionCommandError({
                    reason: "rejected",
                    message:
                      "Only an authenticated Agent can answer as an Agent",
                  }),
                )
              : respond(ctx, sessionId, {
                  kind: "agent_answer",
                  ...input,
                  caller,
                }).pipe(
                  Effect.map((result) => ({
                    result,
                    answeredBy: {
                      kind: "agent" as const,
                      agentId: caller.agentId,
                    },
                  })),
                ),
          escalateAgent: {
            prepare: ({ sessionId, input, caller }) =>
              Effect.gen(function* () {
                if (caller === undefined)
                  return yield* Effect.fail(
                    new ExtensionCommandError({
                      reason: "rejected",
                      message:
                        "Only an authenticated Agent can escalate an Ask",
                    }),
                  );
                const found = ctx.state.read(({ asks }) =>
                  asks.get(input.askId),
                );
                let next: AttentionRecipient | null | undefined;
                if (
                  Option.isSome(found) &&
                  found.value.sessionId === sessionId &&
                  found.value.pending === null &&
                  found.value.waitingOn !== undefined &&
                  waitsOn(found.value, caller.agentId)
                ) {
                  // The escalating Session's own parent is the next Agent up.
                  const parent = yield* ctx.recipientParent({
                    agentId: caller.agentId,
                    sessionId: caller.sessionId,
                    name: found.value.waitingOn.name,
                  });
                  if (parent === null) next = null;
                  else {
                    const status = yield* ctx.recipientStatus(parent);
                    next =
                      status === "archived" || status === "absent"
                        ? null
                        : parent;
                  }
                }
                return escalateFromAgent(
                  ctx,
                  sessionId,
                  input.askId,
                  caller,
                  input.note,
                  next,
                );
              }),
          },
          decline: ({ sessionId, input }) =>
            respondPerson(ctx, sessionId, { kind: "decline", ...input }),
          // A Hub-parked approval is a wait on a person like any question: it
          // is Session attention, so a goal cannot complete while it is open.
          holdApproval: ({ sessionId, input, caller }) =>
            Effect.gen(function* () {
              yield* requireHub(caller);
              const clearAt = input.expiresAt + holdExpiryMarginMs;
              yield* ctx.attention.set(sessionId, {
                id: approvalAttentionId(input.approvalId),
                kind: "approval",
                summary: input.summary,
                since: yield* Clock.currentTimeMillis,
                expiresAt: input.expiresAt,
              });
              // However the release is lost, the hold ends with its approval.
              const id = holdId(sessionId, input.approvalId);
              yield* ctx.state.holds.put({
                id,
                sessionId,
                approvalId: input.approvalId,
              });
              yield* ctx.timers.set(holdTimerKey(id), clearAt);
              yield* ctx.observe(sessionId);
              return {};
            }),
          releaseApproval: ({ sessionId, input, caller }) =>
            Effect.gen(function* () {
              yield* requireHub(caller);
              yield* ctx.attention.clear(
                sessionId,
                approvalAttentionId(input.approvalId),
              );
              const id = holdId(sessionId, input.approvalId);
              yield* ctx.state.holds.remove(id);
              yield* ctx.timers.cancel(holdTimerKey(id));
              yield* ctx.observe(sessionId);
              return {};
            }),
          list: ({ sessionId }) =>
            ctx.state.asks
              .page({ index: sessionId, limit: ctx.config.maximumOpen })
              .pipe(
                Effect.flatMap((rows) =>
                  ctx.state.recent.get(sessionId).pipe(
                    Effect.map((recent) => ({
                      asks: rows
                        .filter((row) => row.pending === null)
                        .map(project),
                      closed: Option.isSome(recent)
                        ? recent.value.outcomes
                        : [],
                    })),
                  ),
                ),
              ),
        }),
      },
      tools: (ctx, { sessionId, workId }) => {
        const runAttemptId = nanoid();
        return Mycelium.module({
          id: "botanical.session-question",
          name: "question",
          description: ctx.config.guide,
          operations: {
            withdraw: Mycelium.operation({
              replay: "unsafe",
              description:
                "Withdraw a question that no longer needs a human answer. Repeating withdrawal preserves its closed outcome.",
              input: z.strictObject({ askId: z.string().min(1).max(256) }),
              output: WithdrawResult,
              execute: async ({ askId }) =>
                WithdrawResult.parse(
                  await toolCall(
                    "withdraw",
                    ctx.transact(withdraw(ctx, sessionId, askId)),
                  ),
                ),
            }),
            ask: Mycelium.operation({
              replay: "unsafe",
              description: ctx.config.askDescription,
              input,
              output: ToolResult,
              execute: async (value, invocation) => {
                const created = await toolCall(
                  "ask",
                  ctx.transact({
                    prepare: Effect.gen(function* () {
                      const waitingOn = ctx.config.routesToSender
                        ? yield* ctx.workSender({ sessionId, workId })
                        : null;
                      const senderStatus =
                        waitingOn === null
                          ? "unknown"
                          : yield* ctx.recipientStatus(waitingOn);
                      return Effect.gen(function* () {
                        const questions = yield* Schema.decodeUnknownEffect(
                          Questions,
                        )(value.questions).pipe(
                          Effect.mapError(
                            () =>
                              new ExtensionCommandError({
                                reason: "invalid",
                                message:
                                  "Invalid question identifiers or option labels",
                              }),
                          ),
                        );
                        const digest = questionDigest(
                          sessionId,
                          workId,
                          questions,
                        );
                        const rows = yield* ctx.state.asks.page({
                          index: sessionId,
                          limit: ctx.config.maximumOpen,
                        });
                        const open = yield* Effect.forEach(rows, (row) =>
                          row.workId === workId &&
                          row.status === "live" &&
                          row.runAttemptId !== runAttemptId
                            ? parkAsk(ctx, row)
                            : Effect.succeed(row),
                        );
                        const replay = yield* replayQuestion(
                          ctx,
                          open,
                          workId,
                          digest,
                          contentKey(questions),
                          "onExpire" in value
                            ? JSON.stringify([
                                value.onExpire.action,
                                value.onExpire.afterMinutes,
                              ])
                            : "none",
                          invocation.toolCallId,
                        );
                        if (replay !== undefined) return replay;
                        if (open.length === ctx.config.maximumOpen)
                          return {
                            status: "refused" as const,
                            reason: "session_limit" as const,
                            askIds: open.map((row) => row.askId),
                          };
                        const now = yield* Clock.currentTimeMillis;
                        // The wait ends before the execute deadline and before the
                        // transport's own cut, which runs from the execute's start.
                        const transportEnd =
                          invocation.startedAt === undefined
                            ? Number.POSITIVE_INFINITY
                            : invocation.startedAt +
                              ctx.config.transportBoundMs;
                        const window =
                          invocation.deadlineAt === null
                            ? 0
                            : Math.max(
                                0,
                                Math.min(
                                  ctx.config.liveWindowMs,
                                  invocation.deadlineAt -
                                    now -
                                    deadlineReserveMs,
                                  transportEnd - now,
                                ),
                              );
                        // The Agent that sent this work answers later; a live wait
                        // would stall the turn it may itself be waiting on.
                        const live =
                          value.mode === "wait" &&
                          window > 0 &&
                          waitingOn === null;
                        const existingLive = open.filter(
                          (row) =>
                            row.workId === workId && row.status === "live",
                        );
                        if (live && existingLive.length > 0)
                          return {
                            status: "refused" as const,
                            reason: "live_limit" as const,
                            askIds: existingLive.map((row) => row.askId),
                          };
                        let row: AskRow = {
                          askId: nanoid(),
                          waitingOn: waitingOn ?? undefined,
                          sessionId,
                          workId,
                          digest,
                          questions,
                          status: live ? "live" : "parked",
                          runAttemptId: live ? runAttemptId : null,
                          pending: null,
                          createdAt: now,
                          toolCallId: invocation.toolCallId,
                          expiry:
                            "onExpire" in value
                              ? {
                                  at:
                                    now + value.onExpire.afterMinutes * 60_000,
                                  action: value.onExpire.action,
                                }
                              : null,
                        };
                        if (row.waitingOn !== undefined) {
                          if (
                            senderStatus === "archived" ||
                            senderStatus === "absent"
                          )
                            row = {
                              ...row,
                              waitingOn: undefined,
                              escalated: {
                                by: row.waitingOn,
                                reason:
                                  senderStatus === "archived"
                                    ? "sender_archived"
                                    : "sender_absent",
                              },
                            };
                        }
                        yield* ctx.state.asks.put(row);
                        yield* baselineGoalEnds(ctx, row.sessionId);
                        if (row.expiry !== null)
                          yield* ctx.timers.set(
                            `ask:${row.askId}`,
                            row.expiry.at,
                          );
                        // Silence never escalates; only explicit action or evidence the sender is gone.
                        if (row.waitingOn !== undefined)
                          yield* ctx.timers.set(
                            checkTimer(row.askId),
                            now + ctx.config.senderCheckMs,
                          );
                        yield* ctx.attention.set(sessionId, askAttention(row));
                        yield* ctx.observe(sessionId);
                        return live
                          ? {
                              status: "waiting" as const,
                              askId: row.askId,
                              until: now + window,
                            }
                          : { status: "parked" as const, askId: row.askId };
                      });
                    }),
                  }),
                );
                const result =
                  created.status === "waiting"
                    ? await waitForResponse(
                        ctx,
                        created.askId,
                        created.until,
                        invocation,
                      )
                    : created;
                // Zod owns the JSON output representation, including mutable arrays.
                return ToolResult.parse(result);
              },
            }),
          },
        });
      },
    });
}

/** Hub's shared roster sends every Ask to a person. */
export const questionExtension = questionExtensionFor(false);
/** Local's roster sends an Ask to the Agent that sent the asking work first. */
export const localQuestionExtension = questionExtensionFor(true);
