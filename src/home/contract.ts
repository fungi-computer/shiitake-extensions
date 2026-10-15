import {
  ExtensionId,
  type CommandsV0,
} from "@fungi.computer/shiitake/extensions";
import * as Schema from "effect/Schema";
import { CatalogStep } from "../internal/catalog.js";

const attachmentId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/** The Agent's recorded choice survives the chosen attachment being detached. */
export const Home = Schema.Struct({
  attachmentId: Schema.NullOr(attachmentId),
});
export type Home = Schema.Schema.Type<typeof Home>;

/** Human selection changes Agent state; no model operation exposes this command. */
export const homeContract = {
  id: ExtensionId.make("botanical-home"),
  commands: {
    home: {
      scope: "session",
      input: Schema.Struct({ name: Schema.optionalKey(Schema.String) }),
      output: CatalogStep,
    },
    seed: {
      scope: "agent",
      input: Home,
      output: Schema.Struct({ seeded: Schema.Boolean }),
    },
  } satisfies CommandsV0,
  projection: { schema: Schema.NullOr(Home) },
};
