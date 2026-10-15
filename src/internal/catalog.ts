import type {
  WhistleCatalogStepV1,
  WhistleCatalogV1,
} from "@fungi.computer/whistle/catalog";
import { WhistleCatalogStepSchema } from "@fungi.computer/whistle/catalog";
import type {
  WhistleJsonObject,
  WhistleNotice,
  WhistlePrompt,
} from "@fungi.computer/whistle";
import { nanoid } from "@fungi.computer/cairn";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  parseExtensionJson,
  type Json,
} from "@fungi.computer/shiitake/extensions";

/**
 * The encoded reply of an extension's human command: one `whistle.catalog/v1`
 * step. Clients parse it again with Whistle's own step parser.
 */
export const CatalogStep = Schema.declare<WhistleCatalogStepV1>(
  (input): input is WhistleCatalogStepV1 =>
    WhistleCatalogStepSchema.safeParse(input).success,
  {
    representation: {
      id: "@fungi.computer/whistle/catalog-step/v1",
      payload: null,
    },
  },
);

/** Finish a human command with one closing notice. */
export function done(notice: WhistleNotice): WhistleCatalogStepV1 {
  return { type: "done", notice };
}

/** Finish without acting on the human's input, so a composer keeps their draft. */
export function declined(notice: WhistleNotice): WhistleCatalogStepV1 {
  return { type: "done", notice, result: { cancelled: true } };
}

/** Ask one question; the answer fills `answer` of the next call's arguments. */
export function ask(
  prompt: WhistlePrompt,
  next: WhistleJsonObject,
  answer: string,
): WhistleCatalogStepV1 {
  return { type: "prompt", prompt, next: { arguments: next, answer } };
}

/** A fresh request id for a flow that starts without one. */
export const freshRequestId = Effect.sync(() => nanoid());

/** Declare an extension's advertised catalog with Whistle's own types. */
export function catalog(commands: WhistleCatalogV1["commands"]): Json {
  return parseExtensionJson(
    JSON.stringify({ protocol: "whistle.catalog/v1", commands }),
  );
}
