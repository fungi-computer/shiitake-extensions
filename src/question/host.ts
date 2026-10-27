import { nanoid } from "@fungi.computer/cairn";
import { Mycelium, type InvocationContext } from "@fungi.computer/mycelium";
import {
  defineCollection,
  defineExtension,
  ExtensionCommandError,
  type RosteredExtensionV0,
  type ExtensionContextV0,
  type SettledRunV0,
} from "@fungi.computer/shiitake/extensions";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { z } from "zod";
import Papa from "papaparse";
import { titleLimit } from "../internal/headline.js";
import { ask, catalog, done, freshRequestId } from "../internal/catalog.js";
import {
  questionContract,
  OpenAsk,
  Questions,
  Answers,
  HumanResult,
  type AnswerInput,
  DeclineInput,
  ClosedStatus,
  AnswerFlowInput,
} from "./contract.js";

const config = {
  maximumOpen: 4,
  liveWindowMs: 600_000,
  idle: "Need a person's decision? forage.describe({path:'question'}) first.",
  guide:
    "Question tools: ask, withdraw. Use question.ask for decisions that need a person's answer. Put the recommended option first; do not add Other, since free text is always available. Use credential tools for secrets. While a question is parked, finish independent work and end the turn.",
  askDescription:
    "Ask a person one or more questions and wait for the answer; options follow the question module rules.",
};
const Response = Schema.Union([
  Schema.Struct({ status: Schema.Literal("answered"), answers: Answers }),
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
  result: HumanResult,
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
  return {
    askId: row.askId,
    questions: row.questions,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiry?.at ?? null,
  };
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
      ? `Answer to ask ${row.askId}:\n`
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
      ? { result: "accepted" as const, via: "follow_up" as const }
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
  ({ kind: "answer" } & AnswerInput) | ({ kind: "decline" } & DeclineInput);
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
    input.kind === "answer"
      ? { status: "answered", answers: input.answers }
      : input.note === undefined
        ? { status: "declined" }
        : { status: "declined", note: input.note };
  const payload = JSON.stringify([
    input.kind,
    input.askId,
    input.kind === "answer"
      ? Object.entries(input.answers)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, answer]) => [
            id,
            [...answer.selected].sort(),
            answer.text ?? null,
          ])
      : (input.note ?? null),
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
    const record = (result: HumanResult) =>
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
    if (input.kind === "answer") {
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

/** Drafts travel in catalog arguments; only respond commits an answer. */
type FlowInput = Schema.Schema.Type<typeof AnswerFlowInput>;
type FlowDraft = Pick<
  Extract<FlowInput, { stage: "text" }>,
  "askId" | "requestId" | "index" | "answers"
>;

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
    if (askId === undefined) {
      const rows = (yield* ctx.state.asks.page({
        index: sessionId,
        limit: ctx.config.maximumOpen,
      })).filter((row) => row.pending === null);
      if (rows.length === 0)
        return done({ type: "info", message: "No questions are waiting." });
      if (rows.length > 1)
        return ask(
          {
            type: "choice",
            message: "Which question would you like to answer?",
            options: rows.map((row) => ({
              value: row.askId,
              label: row.questions
                .map((question) => question.header)
                .join(" · "),
            })),
          },
          {},
          "askId",
        );
      const first = rows[0];
      if (first === undefined) throw new Error("Expected the waiting question");
      return { type: "selected" as const, askId: first.askId };
    }
    return { type: "selected" as const, askId };
  });
}

function multipleSelection(
  question: AskRow["questions"][number],
  selection: string,
): Effect.Effect<string[], ExtensionCommandError> {
  const parsed = Papa.parse<string[]>(selection, {
    delimiter: ",",
    skipEmptyLines: true,
  });
  const selected = parsed.data[0] ?? [];
  const offered = new Set(question.options.map((option) => option.label));
  if (
    question.multiple !== true ||
    parsed.errors.length > 0 ||
    parsed.data.length > 1 ||
    new Set(selected).size !== selected.length ||
    selected.some((label) => !offered.has(label))
  )
    return Effect.fail(
      new ExtensionCommandError({
        reason: "invalid",
        message:
          "Enter offered labels once each as a comma list; quote labels containing commas",
      }),
    );
  return Effect.succeed(selected);
}

function singleSelection(
  question: AskRow["questions"][number],
  selection: string,
): Effect.Effect<string[], ExtensionCommandError> {
  if (selection === "free_text") return Effect.succeed([]);
  const option = question.options.find(
    (option) => `option:${option.label}` === selection,
  );
  return option === undefined
    ? Effect.fail(
        new ExtensionCommandError({
          reason: "invalid",
          message: "Choose an offered option or free text",
        }),
      )
    : Effect.succeed([option.label]);
}

/**
 * The Agent's own words are the title only when they fit one; a longer
 * question gets a plain title and sits in the body, whole in the details.
 */
function questionHeading(question: AskRow["questions"][number]) {
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
  nextQuestion: AskRow["questions"][number],
  next: FlowDraft,
) {
  const heading = questionHeading(nextQuestion);
  if (nextQuestion.multiple === true)
    return ask(
      {
        type: "text",
        ...heading,
        summary: `Separate your picks with commas, or leave blank to write your own.${
          nextQuestion.options.some((option) => option.label.includes(","))
            ? " Put quotes around a pick that contains a comma."
            : ""
        }`,
        facts: [
          {
            label: "Options",
            value: nextQuestion.options
              .map((option) => option.label)
              .join(" · "),
          },
        ],
        details: [
          ...("details" in heading ? heading.details : []),
          ...nextQuestion.options.map((option) => ({
            label: option.label.slice(0, 200),
            value: option.description,
          })),
        ].slice(0, 24),
      },
      { stage: "multiple", ...next },
      "selection",
    );
  return ask(
    {
      type: "choice",
      ...heading,
      options: [
        ...nextQuestion.options.map((option) => ({
          value: `option:${option.label}`,
          label: option.label,
          description: option.description,
        })),
        { value: "free_text", label: "Write an answer" },
      ],
    },
    { stage: "selection", ...next },
    "selection",
  );
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
    let answer: AnswerInput["answers"][string] | undefined;
    if (draft.stage === "text")
      answer =
        draft.text.length === 0
          ? { selected: draft.selected }
          : { selected: draft.selected, text: draft.text };
    else if (draft.stage === "selection" || draft.stage === "multiple") {
      const selected = yield* draft.stage === "multiple"
        ? multipleSelection(question, draft.selection)
        : singleSelection(question, draft.selection);
      // A single choice is complete; only multiple selection and free text
      // need an explicit submit.
      if (draft.stage === "multiple" || selected.length === 0)
        return ask(
          {
            type: "text",
            message:
              selected.length === 0
                ? `Your answer for ${question.header}:`
                : `Additional context for ${question.header} (leave blank to skip):`,
          },
          {
            stage: "text",
            askId: row.askId,
            requestId,
            index,
            answers,
            selected,
          },
          "text",
        );
      answer = { selected };
    }
    if (answer !== undefined) {
      answers = { ...answers, [question.id]: answer };
      index += 1;
      if (index === row.questions.length) {
        const result = yield* respond(ctx, sessionId, {
          kind: "answer",
          askId: row.askId,
          requestId,
          answers,
        });
        return answerNotice(result);
      }
    }
    if (row.status === "settled" || row.pending !== null)
      return done({
        type: "info",
        message: "That question is already closed.",
      });
    const next = { askId: row.askId, requestId, index, answers };
    const nextQuestion = row.questions[index];
    if (nextQuestion === undefined)
      throw new Error("Expected the next question");
    return promptQuestion(nextQuestion, next);
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
      projections: {
        slash: { aliases: ["answer"], order: 5 },
        palette: { order: 5 },
        help: { order: 5 },
      },
    },
  ]);
}

/** One durable question owner over the ordinary extension doors. */
export const questionExtension: RosteredExtensionV0 = defineExtension({
  id: questionContract.id,
  version: "1.0.0",
})
  .config(config)
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
        answerFlow: ({ sessionId, input }) => answerFlow(ctx, sessionId, input),
        answer: ({ sessionId, input }) =>
          respond(ctx, sessionId, { kind: "answer", ...input }),
        decline: ({ sessionId, input }) =>
          respond(ctx, sessionId, { kind: "decline", ...input }),
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
                    const digest = questionDigest(sessionId, workId, questions);
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
                    const live = value.mode === "wait" && window > 0;
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
                      yield* ctx.timers.set(`ask:${row.askId}`, row.expiry.at);
                    const attention = {
                      id: row.askId,
                      kind: "question" as const,
                      summary: questions
                        .map((question) => question.header)
                        .join(", "),
                      since: now,
                    };
                    yield* ctx.attention.set(
                      sessionId,
                      row.expiry === null
                        ? attention
                        : { ...attention, expiresAt: row.expiry.at },
                    );
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
