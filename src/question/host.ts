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
  type SettledRunV0,
} from "@fungi.computer/shiitake/extensions";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { z } from "zod";
import { catalog, done } from "../internal/catalog.js";
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
  AnswerFlowInput,
} from "./contract.js";
import { advanceAnswerFlow, type FlowInput } from "./answer-flow.js";

const config = {
  maximumOpen: 4,
  liveWindowMs: 600_000,
  // No Agent holds a routed ask forever: past this a person decides.
  routedEscalationMs: 900_000,
  routesToSender: false,
  idle: "Need a person's decision? forage.describe({path:'question'}) first.",
  guide:
    "Question tools: ask, withdraw. Use question.ask for decisions that need a person's answer. Put the recommended option first; do not add Other, since free text is always available. Use credential tools for secrets. While a question is parked, finish independent work and end the turn.",
  askDescription:
    "Ask a person one or more questions and wait for the answer; options follow the question module rules. When another Agent sent you this work, your question goes to that Agent first and always parks: end your turn, and its answer arrives as a follow-up.",
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
  closed: defineCollection(ClosedAsk, {
    key: (row) => row.askId,
    index: (row) => (row.replay === "none" ? null : row.digest),
  }),
  receipts: defineCollection(Receipt, {
    key: (row) => row.id,
    index: (row) => row.digest,
  }),
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
    yield* ctx.state.asks.remove(row.askId);
    if (row.expiry !== null) yield* ctx.timers.cancel(`ask:${row.askId}`);
    if (row.waitingOn !== undefined)
      yield* ctx.timers.cancel(routeTimer(row.askId));
    yield* ctx.attention.clear(row.sessionId, row.askId);
    yield* ctx.observe(row.sessionId);
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

function project(row: AskRow): OpenAsk {
  const open: OpenAsk = {
    askId: row.askId,
    questions: row.questions,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiry?.at ?? null,
  };
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
    if (row.waitingOn !== undefined) {
      // Nobody answered in time. A person decides next; the default never
      // stands in for a decision no person has seen.
      yield* ctx.timers.cancel(`ask:${row.askId}`);
      yield* escalateAsk(ctx, { ...row, expiry: null });
      return undefined;
    }
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
    if (
      input.kind === "agent_answer" &&
      !waitsOn(row, input.caller.agentId, input.caller.sessionId)
    )
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

/** Whether this ask waits on exactly this Agent Session. */
function waitsOn(row: AskRow, agentId: string, sessionId: string): boolean {
  return (
    row.waitingOn?.agentId === agentId && row.waitingOn.sessionId === sessionId
  );
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

/** The attention item for one open ask, waiting on an Agent or a person. */
function askAttention(row: AskRow) {
  const item = {
    id: row.askId,
    kind: "question" as const,
    summary: row.questions.map((question) => question.header).join(", "),
    since: row.createdAt,
  };
  const timed =
    row.expiry === null ? item : { ...item, expiresAt: row.expiry.at };
  return row.waitingOn === undefined
    ? timed
    : { ...timed, waitingOn: row.waitingOn };
}

/**
 * The durable backstop of an ask that waits on an Agent. It is separate from
 * the asker's own expiry, so it always hands the ask to a person and never
 * applies a default answer.
 */
function routeTimer(askId: string): string {
  return `route:${askId}`;
}

/** Hand an ask to a person: it stops waiting on any Agent and needs them. */
function escalateAsk(ctx: Context, row: AskRow) {
  return Effect.gen(function* () {
    const moved: AskRow = { ...row, waitingOn: undefined };
    yield* ctx.timers.cancel(routeTimer(row.askId));
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
    if (!waitsOn(row, caller.agentId, caller.sessionId)) {
      const refused: EscalateResult = {
        result: "refused",
        reason: "not_sender",
      };
      return refused;
    }
    yield* escalateAsk(ctx, row);
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
        header: z.string().min(1).max(12),
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
    const next = await Effect.runPromise(
      ctx.transact(
        Effect.gen(function* () {
          const found = yield* ctx.state.asks.get(askId);
          if (invocation.signal.aborted) {
            if (Option.isSome(found)) yield* parkAsk(ctx, found.value);
            return { status: "aborted" as const };
          }
          if (Option.isNone(found)) {
            const closed = yield* ctx.state.closed.get(askId);
            if (
              Option.isSome(closed) &&
              closed.value.outcome.status === "withdrawn"
            )
              return closed.value.outcome;
            throw new Error("Waiting question disappeared");
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
  return done({
    type: "info",
    message:
      result.result === "closed"
        ? `Question closed: ${result.status}.`
        : "That question is no longer available.",
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
        closed: row.status === "settled" || row.pending !== null,
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

function replayQuestion(
  ctx: Context,
  open: readonly AskRow[],
  workId: string,
  digest: string,
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
        onSettled: (ctx, page) =>
          Effect.forEach(page, (run) => settle(ctx, run), { discard: true }),
        onTimer: (ctx, timer) =>
          Effect.gen(function* () {
            if (timer.key.startsWith("route:")) {
              const row = yield* ctx.state.asks.get(timer.key.slice(6));
              if (
                Option.isSome(row) &&
                row.value.waitingOn !== undefined &&
                row.value.pending === null
              )
                yield* escalateAsk(ctx, row.value);
              return;
            }
            if (!timer.key.startsWith("ask:")) return;
            const row = yield* ctx.state.asks.get(timer.key.slice(4));
            if (Option.isSome(row))
              yield* expireAsk(ctx, row.value, timer.firedAt);
          }),
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
          escalateAgent: ({ sessionId, input, caller }) =>
            Effect.gen(function* () {
              if (caller === undefined)
                return yield* Effect.fail(
                  new ExtensionCommandError({
                    reason: "rejected",
                    message: "Only an authenticated Agent can escalate an Ask",
                  }),
                );
              return yield* escalateFromAgent(
                ctx,
                sessionId,
                input.askId,
                caller,
              );
            }),
          decline: ({ sessionId, input }) =>
            respondPerson(ctx, sessionId, { kind: "decline", ...input }),
          list: ({ sessionId }) =>
            ctx.state.asks
              .page({ index: sessionId, limit: ctx.config.maximumOpen })
              .pipe(
                Effect.map((rows) => ({
                  asks: rows.filter((row) => row.pending === null).map(project),
                })),
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
                  await Effect.runPromise(
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
                const created = await Effect.runPromise(
                  ctx.transact(
                    Effect.gen(function* () {
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
                      const window =
                        invocation.deadlineAt === null
                          ? 0
                          : Math.max(
                              0,
                              Math.min(
                                ctx.config.liveWindowMs,
                                invocation.deadlineAt - now - deadlineReserveMs,
                              ),
                            );
                      // The Agent that sent this work answers later; a live wait
                      // would stall the turn it may itself be waiting on.
                      const waitingOn = ctx.config.routesToSender
                        ? yield* ctx.workSender({ sessionId, workId })
                        : null;
                      const live =
                        value.mode === "wait" &&
                        window > 0 &&
                        waitingOn === null;
                      const existingLive = open.filter(
                        (row) => row.workId === workId && row.status === "live",
                      );
                      if (live && existingLive.length > 0)
                        return {
                          status: "refused" as const,
                          reason: "live_limit" as const,
                          askIds: existingLive.map((row) => row.askId),
                        };
                      const row: AskRow = {
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
                        expiry:
                          "onExpire" in value
                            ? {
                                at: now + value.onExpire.afterMinutes * 60_000,
                                action: value.onExpire.action,
                              }
                            : null,
                      };
                      yield* ctx.state.asks.put(row);
                      if (row.expiry !== null)
                        yield* ctx.timers.set(
                          `ask:${row.askId}`,
                          row.expiry.at,
                        );
                      // Whatever the asker chose, an ask nobody takes up reaches a person.
                      if (row.waitingOn !== undefined)
                        yield* ctx.timers.set(
                          routeTimer(row.askId),
                          now + ctx.config.routedEscalationMs,
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
                    }),
                  ),
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
