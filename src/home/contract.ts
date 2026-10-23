import {
  ExtensionId,
  type CommandsV0,
} from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { CatalogStep } from "../internal/catalog.js";

const attachmentId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/** The Agent's recorded choice survives the chosen attachment being detached. */
export const Home = Schema.Struct({
  /** Chosen Computer attachment, or null when no Home is selected. */
  attachmentId: Schema.NullOr(attachmentId),
});
/** Persisted Home selection for one Agent. */
export type Home = Schema.Schema.Type<typeof Home>;

/** Human selection changes Agent state; no model operation exposes this command. */
export const homeContract = {
  /** Stable extension identity. */
  id: ExtensionId.make("botanical-home"),
  /** Human selection and initial seeding operations. */
  commands: {
    /** Open Home controls or select an attachment by name. */
    home: {
      /** Human controls are opened from a Session. */
      scope: "session",
      /** Decode an optional attachment name. */
      input: Schema.Struct({
        /** Attachment name selected by the person. */
        name: Schema.optionalKey(Schema.String),
      }),
      /** Return the server-owned conversation step. */
      output: CatalogStep,
    },
    /** Seed the Agent's initial recorded Home choice. */
    seed: {
      /** Home selection belongs to the Agent. */
      scope: "agent",
      /** Decode the initial selection. */
      input: Home,
      /** Report whether seeding changed the recorded choice. */
      output: Schema.Struct({
        /** Whether the initial choice was seeded. */
        seeded: Schema.Boolean,
      }),
    },
  } satisfies CommandsV0,
  /** Recorded selection visible to clients, or no seeded state. */
  projection: {
    /** Decoder for the optional Home state. */
    schema: Schema.NullOr(Home),
  },
};
