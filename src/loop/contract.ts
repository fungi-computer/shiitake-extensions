import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";

import { CatalogStep } from "../internal/catalog.js";
import { Prompt, SessionId } from "../internal/schedule-fields.js";
import { LoopCron, Loop, LoopListInput } from "./schema.js";
export { Loop, LoopCron } from "./schema.js";

/**
 * Session loop: one repeated prompt per Session, either paced by the model
 * (`schedule_next`) or by a fixed cron cadence. Shared by the server
 * extension and every client; its schemas are the one decoder.
 */

const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
);
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
      input: LoopListInput,
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
    /** Resume an identified Loop; refuse a stale target after replacement. */
    resumeLoop: {
      /** The Agent owns the identified Loop and its Session. */
      scope: "agent",
      /** The listed Session and Loop identities must both still match. */
      input: LoopTarget,
      /** Return the resumed Loop without changing accepted work. */
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
