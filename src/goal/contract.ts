import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";

import { CatalogStep } from "../internal/catalog.js";

/**
 * Session goal: one durable objective per Session that Shiitake keeps
 * working toward until the model reports it achieved or a person clears it.
 * Only a live or paused goal is current; a finished goal is history. Shared
 * by the server extension and every client; its schemas are the one decoder.
 */

/** A goal objective: stored exactly as sent, never blank. */
export const Objective = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_000)),
  Schema.check(Schema.isPattern(/\S/u, { message: "Goal objective is blank" })),
);
/** Nonblank explanation recorded when a goal is achieved. */
export const GoalReason = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(1_000)),
  Schema.check(Schema.isPattern(/\S/u)),
);
const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

const EpochMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Why work paused, independent of the words shown to a person. */
export const GoalPauseCause = Schema.Struct({
  /** Typed origin of the pause. */
  kind: Schema.Literals([
    "person",
    "delegator",
    "blocked",
    "stalled",
    "cancelled",
    "failed",
    "no-terminal",
  ]),
  /** Additional explanation, or null when no detail was supplied. */
  detail: Schema.NullOr(Schema.String),
});
/** Typed pause cause and optional explanation. */
export type GoalPauseCause = Schema.Schema.Type<typeof GoalPauseCause>;

/** The current goal every client sees; provisional terminals stay private. */
export const Goal = Schema.Struct({
  /** Owner-issued revision that guards an explicit replacement. */
  revision: Schema.String,
  /** Objective being pursued by this Session. */
  objective: Objective,
  /** Live, or paused until a person resumes it (a blocked goal is paused). */
  state: Schema.Literals(["active", "paused"]),
  /** When this goal was set, in epoch milliseconds. */
  startedAt: EpochMillis,
  /** A typed cause while paused; null while active. */
  pauseCause: Schema.NullOr(GoalPauseCause),
});
/** The current goal every client sees. */
export type Goal = Schema.Schema.Type<typeof Goal>;

/** One finished goal: history only, never current. */
export const EndedGoal = Schema.Struct({
  /** Per-Session order of endings, starting at 1. */
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Objective that finished or was cleared. */
  objective: Objective,
  /** Whether the model achieved the goal or it was cleared. */
  outcome: Schema.Literals(["achieved", "cleared"]),
  /**
   * The model's evidence for an achieved goal, or its explanation for
   * clearing its own paused goal, or the delegator's clear reason;
   * null when a person cleared it.
   */
  reason: Schema.NullOr(GoalReason),
  /**
   * Authenticated delegating Agent id, absent for person/model endings.
   * This ending is Session-scoped; its immutable first-delegator record
   * retains the exact authorized Session, rather than duplicating that pair.
   */
  clearedBy: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  ),
  /** Completion time in epoch milliseconds. */
  endedAt: EpochMillis,
  /** Committed Session position when this goal ended; zero before any entry. */
  afterSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
/** One finished goal. */
export type EndedGoal = Schema.Schema.Type<typeof EndedGoal>;

/** How many finished goals a Session keeps for its chat lines. */
export const endedGoalLimit = 16;

/**
 * Arguments of the human `/goal` command. A bare call opens the controls; each
 * reply is a catalog step, so the conversation stays on the server.
 */
export const GoalCommandInput = Schema.Union([
  Schema.Struct({
    /** Select the explicit goal-setting action. */
    action: Schema.Literal("set"),
    /** New objective supplied by the person. */
    objective: Objective,
    /** Idempotency key for setting this objective. */
    requestId: RequestId,
    /** The revision the human confirmed replacing, when they confirmed one. */
    expectedRevision: Schema.optional(Schema.NullOr(Schema.String)),
    /** The human's answer to "replace the current goal?". */
    confirmed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    /** Select an existing-goal control. */
    action: Schema.Literals([
      "pause",
      "resume",
      "replace",
      "clear",
      "clear-ask",
    ]),
    /** The human's answer to "clear this goal?"; absent for a typed clear. */
    confirmed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({}),
]);

/** Goal's contract: Session-scope human controls and one projection slot. */
export const GoalProjection = Schema.Struct({
  /** The live or paused goal, or null when none is current. */
  goal: Schema.NullOr(Goal),
  /** The newest finished goals, oldest first. */
  ended: Schema.Array(EndedGoal).check(Schema.isMaxLength(endedGoalLimit)),
  /** Finished goals older than `ended` that this Session no longer keeps. */
  omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Session-owned goal controls and their visible projection. */
export const goalContract = {
  /** Stable extension identity. */
  id: ExtensionId.make("botanical-session-goal"),
  /** Goal commands admitted by the Session owner. */
  commands: {
    /** Exact first delegator's controls; never an ordinary person command. */
    controlAgent: {
      /** The child's Session owns this goal. */
      scope: "session",
      /** Requested control; caller identity comes only from the host. */
      input: Schema.Struct({
        /** Pause, resume this delegator's own pause, or clear the goal. */
        action: Schema.Literals(["pause", "resume", "clear"]),
        /** Explanation retained with the control change. */
        reason: GoalReason,
      }),
      /** Applied control or an explicit refusal without mutation. */
      output: Schema.Union([
        Schema.Struct({
          /** The exact delegator paused this goal. */
          result: Schema.Literal("paused"),
          /** Current paused goal and its controller attribution. */
          goal: Goal,
        }),
        Schema.Struct({
          /** This delegator resumed its own pause. */
          result: Schema.Literal("resumed"),
          /** Current active goal. */
          goal: Goal,
        }),
        Schema.Struct({
          /** The exact delegator cleared the goal. */
          result: Schema.Literal("cleared"),
        }),
        Schema.Struct({
          /** No live goal exists to control. */
          result: Schema.Literal("no_goal"),
        }),
        Schema.Struct({
          /** No goal state changed. */
          result: Schema.Literal("refused"),
          /** Caller lacks exact authority, or does not own this pause. */
          reason: Schema.Literals(["not_delegator", "not_paused_by_delegator"]),
        }),
      ]),
    },
    /** Open or answer the human goal controls. */
    goal: {
      /** The Session owns this goal. */
      scope: "session",
      /** Decode the control action. */
      input: GoalCommandInput,
      /** Return the server-owned conversation step. */
      output: CatalogStep,
    },
    /** Pause work on the current goal. */
    pause: {
      /** The Session owns this goal. */
      scope: "session",
      /** No additional arguments are required. */
      input: Schema.Struct({}),
      /** Return the paused goal. */
      output: Goal,
    },
    /** Resume work on a paused goal. */
    resume: {
      /** The Session owns this goal. */
      scope: "session",
      /** No additional arguments are required. */
      input: Schema.Struct({}),
      /** Return the active goal. */
      output: Goal,
    },
    /** Clear the current objective. */
    clear: {
      /** The Session owns this goal. */
      scope: "session",
      /** No additional arguments are required. */
      input: Schema.Struct({}),
      /** A successful clear has no result fields. */
      output: Schema.Struct({}),
    },
    /** Set an objective against the revision the person saw. */
    set: {
      /** The Session owns this goal. */
      scope: "session",
      /** Decode the new objective and replacement fence. */
      input: Schema.Struct({
        /** New objective to pursue. */
        objective: Objective,
        /** The revision the user saw, or null when they saw no goal. */
        expectedRevision: Schema.NullOr(Schema.String),
        /** Idempotency key for this setting command. */
        requestId: RequestId,
        /**
         * Work already admitted in this Session that carries the objective,
         * such as a delegated send. The goal adopts it instead of admitting
         * the objective again; its settlement starts the goal turns.
         */
        adoptCommandId: Schema.optionalKey(RequestId),
      }),
      /** Return the goal and its admission receipt. */
      output: Schema.Struct({
        /** Newly current goal. */
        goal: Goal,
        /** Receipt for the accepted setting command. */
        accepted: Schema.Struct({
          /** Successful admission discriminator. */
          status: Schema.Literal("accepted"),
          /** Identity of the admitted command. */
          commandId: Schema.String,
        }),
      }),
    },
  },
  /** Current and ended goals visible to clients. */
  projection: {
    /** Decoder for the goal projection. */
    schema: GoalProjection,
  },
} as const;
