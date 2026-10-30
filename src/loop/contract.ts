import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";

import { CatalogStep } from "../internal/catalog.js";

/**
 * Session loop: one repeated prompt per Session, either paced by the model
 * (`schedule_next`) or by a fixed cron cadence. Shared by the server
 * extension and every client; its schemas are the one decoder.
 */

const Prompt = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256 * 1024)),
);
const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
);
const SessionId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
/** A named cron cadence evaluated in one IANA time zone. */
export const LoopCron = Schema.Struct({
  /** Cron expression for the fixed cadence. */
  expression: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(256)),
  ),
  /** IANA time zone in which the expression is evaluated. */
  timeZone: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(128)),
  ),
});

/** One Session's loop as every client sees it. */
export const Loop = Schema.Struct({
  /** Identity of the loop whose occurrences are being tracked. */
  loopId: Schema.String,
  /** Whether a person or the model started this loop. */
  origin: Schema.Literals(["human", "model"]),
  /** Configured expiry timestamp, or null when absent. */
  expiresAt: Schema.NullOr(Schema.Int),
  /** Original instruction repeated for every occurrence. */
  prompt: Prompt,
  /** Whether the model or a fixed cron cadence schedules occurrences. */
  mode: Schema.Literals(["self_paced", "fixed_interval"]),
  /** Cadence of a fixed-interval loop; null when the model paces it. */
  cron: Schema.NullOr(LoopCron),
  /** Current loop lifecycle state. */
  state: Schema.Literals([
    "active",
    "paused",
    "finished",
    "failed",
    "cancelled",
  ]),
  /** Latest accepted command associated with this loop. */
  commandId: Schema.String,
  /** The model's stated reason for the next self-paced occurrence. */
  reason: Schema.NullOr(Schema.String),
  /** When the next occurrence is due, if one is scheduled. */
  nextDueAt: Schema.NullOr(Schema.Int),
  /** Visible explanation when loop work failed. */
  lastError: Schema.NullOr(Schema.String),
  /** Consecutive failed work outcomes; successful work resets this to zero. */
  consecutiveFailures: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
/** One Session's loop. */
export type Loop = Schema.Schema.Type<typeof Loop>;

const StartResult = Schema.Struct({
  /** Newly started loop. */
  loop: Loop,
  /** Admission receipt for the start command. */
  accepted: Schema.Struct({
    /** Successful admission discriminator. */
    status: Schema.Literal("accepted"),
    /** Identity of the accepted start command. */
    commandId: Schema.String,
  }),
});

/**
 * Arguments of the human `/loop` command. `start` carries the typed text:
 * `<prompt>` paces itself, `<N>m <prompt>` or `<N>h <prompt>` runs on an
 * interval. A bare call opens the controls.
 */
export const LoopCommandInput = Schema.Union([
  Schema.Struct({
    /** Select the loop-starting control. */
    action: Schema.Literal("start"),
    /** Human prompt text, optionally prefixed with an interval. */
    text: Prompt,
    /** Idempotency key for this start command. */
    requestId: RequestId,
  }),
  Schema.Struct({
    /** Select an existing-loop control or open new-loop entry. */
    action: Schema.Literals([
      "status",
      "pause",
      "resume",
      "stop",
      "stop-ask",
      "new",
    ]),
    /** The human's answer to "stop this loop?"; absent for a typed stop. */
    confirmed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({}),
]);

/** Loop's contract: Session-scope controls and one projection slot. */
export const LoopProjection = Schema.Struct({
  /** Loop currently visible to Session clients. */
  loop: Loop,
});

const LoopTarget = Schema.Struct({
  /** Session containing the identified Loop. */
  sessionId: SessionId,
  /** Exact Loop identity, not whichever Loop later replaces it. */
  loopId: Loop.fields.loopId,
});

/** Session-owned current-Loop controls and Agent-scoped identified-Loop controls. */
export const loopContract = {
  /** Stable extension identity. */
  id: ExtensionId.make("botanical-session-loop"),
  /** Loop operations admitted by their Agent or Session owner. */
  commands: {
    /** Read an Agent's bounded Loop page, including each destination Session. */
    list: {
      /** The Agent owns the collection of its Sessions' Loops. */
      scope: "agent",
      /** Page strictly after a Session identity, in identity order. */
      input: Schema.Struct({
        /** Exclusive Session cursor. */
        after: Schema.optionalKey(SessionId),
        /** Maximum number of Loop rows to read. */
        limit: Schema.optionalKey(
          Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
          ),
        ),
      }),
      /** Public Loop values with Session targets, never private scheduling state. */
      output: Schema.Array(
        Schema.Struct({
          ...Loop.fields,
          /** Session that owns this identified Loop. */
          sessionId: SessionId,
        }),
      ).pipe(Schema.check(Schema.isMaxLength(64))),
    },
    /** Pause an identified Loop; refuse a stale target after replacement. */
    pauseLoop: {
      /** The Agent owns the identified Loop and its Session. */
      scope: "agent",
      /** The listed Session and Loop identities must both still match. */
      input: LoopTarget,
      /** Return the paused Loop without cancelling accepted work. */
      output: Loop,
    },
    /** Cancel an identified Loop's future occurrences, retaining accepted work. */
    stopLoop: {
      /** The Agent owns the identified Loop and its Session. */
      scope: "agent",
      /** The listed Session and Loop identities must both still match. */
      input: LoopTarget,
      /** Return the cancelled Loop; its Session and history remain. */
      output: Loop,
    },
    /** Open or answer the human loop controls. */
    loop: {
      /** The Session owns this loop. */
      scope: "session",
      /** Decode the selected human action. */
      input: LoopCommandInput,
      /** Return the server-owned conversation step. */
      output: CatalogStep,
    },
    /** Start a loop whose next occurrence is chosen by the model. */
    startSelfPaced: {
      /** The Session owns this loop. */
      scope: "session",
      /** Decode the repeated prompt and command identity. */
      input: Schema.Struct({
        /** Instruction repeated on every occurrence. */
        prompt: Prompt,
        /** Idempotency key for the start command. */
        requestId: RequestId,
      }),
      /** Return the loop and admission receipt. */
      output: StartResult,
    },
    /** Start a loop with a fixed cron cadence. */
    startFixedInterval: {
      /** The Session owns this loop. */
      scope: "session",
      /** Decode the prompt, cadence and command identity. */
      input: Schema.Struct({
        /** Instruction repeated on every occurrence. */
        prompt: Prompt,
        /** Idempotency key for the start command. */
        requestId: RequestId,
        ...LoopCron.fields,
      }),
      /** Return the loop and admission receipt. */
      output: StartResult,
    },
    /** Suspend the current loop. */
    pause: {
      /** The Session owns this loop. */
      scope: "session",
      /** No additional arguments are required. */
      input: Schema.Struct({}),
      /** Return the paused loop. */
      output: Loop,
    },
    /** Resume the current paused loop. */
    resume: {
      /** The Session owns this loop. */
      scope: "session",
      /** No additional arguments are required. */
      input: Schema.Struct({}),
      /** Return the resumed loop. */
      output: Loop,
    },
    /** Stop future occurrences of the current loop. */
    stop: {
      /** The Session owns this loop. */
      scope: "session",
      /** No additional arguments are required. */
      input: Schema.Struct({}),
      /** Return the stopped loop. */
      output: Loop,
    },
  },
  /** Current loop visible to Session clients. */
  projection: {
    /** Decoder for projected loop state. */
    schema: LoopProjection,
  },
} as const;
