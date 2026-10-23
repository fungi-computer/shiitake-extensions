import { Knapsack, type FilesPort } from "@fungi.computer/knapsack";
import {
  defineCollection,
  defineExtension,
  ExtensionCommandError,
  type ExtensionGrantV0,
  type RosteredExtensionV0,
  type RunIdentityV0,
} from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ask, catalog, done } from "../internal/catalog.js";
import { Home, homeContract } from "./contract.js";
import { homeFilesRouting } from "./routing.js";

/** Already-scoped authority supplied by the host, never constructed by Home. */
export type HomeComputer = Readonly<{
  /** Attachment name offered to the person choosing Home. */
  name: string;
  /** Stable identity stored by the Home selection. */
  attachmentId: string;
  /** Already-scoped Files authority captured for this attachment. */
  port: FilesPort;
}>;

/** Hosts admit Home explicitly; no other extension receives the Files slot. */
export const homeGrant: ExtensionGrantV0 = {
  id: homeContract.id,
  capabilities: ["state", "files", "prompt", "projection", "commands"],
};

const config = {
  promptLimit: 4_000,
  guide:
    "Home supplies read, list, glob and grep over your default Computer. Bare paths and computer://home/ use Home; computer://<name>/ uses that captured attachment. apply_patch, when offered, also works on Home. Only a person changes Home with /home <name>; ask them when no Home is available.",
};
const collections = {
  choice: defineCollection(Home, { key: () => "default" }),
};

/** Agent-scope choice with per-run tools and prompt over one captured table. */
export function homeExtension(options: {
  computers: {
    read: (context: Readonly<{ sessionId: string }>) => readonly HomeComputer[];
  };
}): RosteredExtensionV0 {
  // Core retains one RunIdentity for Files and every prompt request. Weak keys
  // release the captured prose with the run, including failure and cancellation.
  const prompts = new WeakMap<RunIdentityV0, string>();
  return defineExtension({ id: homeContract.id, version: "1.0.0" })
    .config(config)
    .state({ version: 1, migrations: {}, collections })
    .define({
      catalog: catalog([
        {
          id: "home",
          title: "Home Computer",
          category: "Settings",
          description: "Choose the default Computer",
          projections: {
            help: { order: 5 },
            palette: { order: 5 },
            slash: {
              aliases: ["home"],
              order: 5,
              arguments: {
                hint: "<name>",
                text: { field: "name", arguments: {} },
              },
            },
          },
        },
      ]),
      projection: {
        schema: Schema.NullOr(Home),
        read: (ctx) =>
          Option.some(Option.getOrNull(ctx.state.choice.peek("default"))),
      },
      files: (ctx, run) => {
        const computers = [...options.computers.read(run)];
        const choice = ctx.state.update((state) => {
          const recorded = Option.getOrNull(state.choice.get("default"));
          if (recorded !== null) return recorded;
          const sole = computers.length === 1 ? computers[0] : undefined;
          if (sole === undefined) return null;
          const adopted = { attachmentId: sole.attachmentId };
          state.choice.put(adopted);
          return adopted;
        });
        const selected = computers.find(
          (computer) => computer.attachmentId === choice?.attachmentId,
        );
        const status =
          selected !== undefined
            ? `Home: ${selected.name}.`
            : choice?.attachmentId == null
              ? "No Home selected. Ask a person to choose /home <name>."
              : "Home's default Computer is detached. Ask a person to choose /home <name>; there is no fallback.";
        const mounts = computers
          .map((computer) => `computer://${encodeURIComponent(computer.name)}/`)
          .join(", ");
        const prompt = `${ctx.config.guide}\n${status}\nCaptured mounts: ${mounts || "none"}.`;
        prompts.set(run, prompt.slice(0, ctx.config.promptLimit));
        if (selected === undefined) return null;
        return Knapsack.files({
          port: homeFilesRouting(
            new Map(computers.map(({ name, port }) => [name, port])),
            selected.port,
          ),
        }).tools;
      },
      prompt: (_ctx, run) => [
        {
          name: "home",
          text:
            prompts.get(run) ??
            "Home file tools were not captured. Ask the person to check Home's Files grant.",
        },
      ],
      commands: {
        specs: homeContract.commands,
        handlers: (ctx) => ({
          home: ({ input, sessionId }) =>
            Effect.gen(function* () {
              const computers = options.computers.read({ sessionId });
              if (input.name === undefined) {
                if (computers.length === 0)
                  return done({
                    type: "info",
                    message:
                      "No Computers attached. Attach one before choosing Home.",
                  });
                return ask(
                  {
                    type: "choice",
                    message: "Choose this Agent's Home Computer",
                    options: computers.map(({ name }) => ({
                      value: name,
                      label: name,
                    })),
                  },
                  {},
                  "name",
                );
              }
              const selected = computers.find(
                ({ name }) => name === input.name,
              );
              if (selected === undefined)
                return yield* Effect.fail(
                  new ExtensionCommandError({
                    reason: "invalid",
                    message: `Computer is not attached: ${input.name}`,
                  }),
                );
              yield* ctx.state.choice.put({
                attachmentId: selected.attachmentId,
              });
              yield* ctx.observe(sessionId);
              return done({
                type: "success",
                message: `Home: ${selected.name}`,
              });
            }),
          seed: ({ input }) =>
            Effect.gen(function* () {
              if (Option.isSome(yield* ctx.state.choice.get("default")))
                return { seeded: false };
              yield* ctx.state.choice.put(input);
              return { seeded: true };
            }),
        }),
      },
    });
}
