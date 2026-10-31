import * as Schema from "effect/Schema";

/** Native Session address shared by Almanac and Loop inputs and rows. */
export const SessionId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

/** Human prompt grammar; the admission door re-checks the exact byte bound. */
export const Prompt = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256 * 1024)),
);
