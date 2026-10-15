import { fauxModel } from "@fungi.computer/mule/testing";
import * as Schema from "effect/Schema";
import { sqliteRowSchema } from "@fungi.computer/shiitake";
import { DatabaseSync } from "node:sqlite";

import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type {
  AgentExtensionControls,
  RuntimePendingWork,
  SqliteCursor,
  SqliteOwner,
  SqliteValue,
} from "@fungi.computer/shiitake";
import {
  make,
  type ShiitakeEffectAgent,
  type ShiitakeEffectOptions,
} from "@fungi.computer/shiitake/effect";
import type {
  ExtensionRosterV0,
  Json,
} from "@fungi.computer/shiitake/extensions";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";

const decodeSqliteRow = Schema.decodeUnknownSync(sqliteRowSchema);

type NativeValue = null | number | bigint | string | Uint8Array;

function nativeInput(value: SqliteValue): null | number | string | Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function ownerValue(value: NativeValue): SqliteValue {
  if (value === null) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value).slice().buffer;
  if (Object.prototype.toString.call(value) === "[object String]")
    return String(value);
  return Number(value);
}

/** A real node:sqlite database behind Shiitake's owner shape. */
export function sqliteOwner(path = ":memory:") {
  const database = new DatabaseSync(path);
  const owner: SqliteOwner = {
    sql: {
      exec: (statement: string, ...bindings: SqliteValue[]): SqliteCursor => {
        const prepared = database.prepare(statement);
        const values = bindings.map(nativeInput);
        const rows = /^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(statement)
          ? prepared
              .all(...values)
              .map((row) =>
                Object.fromEntries(
                  Object.entries(row).map(([key, value]) => [
                    key,
                    ownerValue(value),
                  ]),
                ),
              )
          : (prepared.run(...values), []);
        return {
          toArray: () => rows.map((row) => decodeSqliteRow(row)),
          one: () => {
            const row = rows[0];
            if (row === undefined) throw new Error("Expected one SQLite row");
            return decodeSqliteRow(row);
          },
        };
      },
    },
    transactionSync: <A>(body: () => A): A => {
      database.exec("BEGIN");
      try {
        const result = body();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    owner,
    /** Copy committed storage to model process loss without running finalizers. */
    copyTo: (path: string) => {
      database.prepare("VACUUM INTO ?").run(path);
    },
    close: () => {
      database.close();
    },
  };
}

/** Run one Effect, rejecting with its typed failure (as Shiitake's facade does). */
export function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);
    return Promise.reject(
      error instanceof Error ? error : new Error("Effect failed"),
    );
  });
}

/** Open real Shiitake core with a manual runtime host and a replying model. */
export async function openAgent(
  owner: SqliteOwner,
  extensions: ExtensionRosterV0,
  overrides: Partial<Pick<ShiitakeEffectOptions, "model" | "tools">> = {},
  logger?: Logger.Logger<unknown, unknown>,
) {
  const execute = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    Effect.runPromise(
      logger === undefined
        ? effect
        : effect.pipe(Effect.provide(Logger.layer([logger]))),
    );
  let bound:
    | Readonly<{
        reconcile: Effect.Effect<void, Error>;
        pendingWork: Effect.Effect<RuntimePendingWork, Error>;
      }>
    | undefined;
  const runtime: ShiitakeEffectOptions["runtime"] = {
    bind: (input) =>
      Effect.sync(() => {
        bound = input;
        return {
          commit: (mutation) => mutation,
          requestWake: Effect.void,
          close: Effect.void,
        };
      }),
  };
  const agent: ShiitakeEffectAgent = await execute(
    make({
      store: owner,
      runtime,
      extensions,
      instructions: {
        load: () => Effect.succeed({ revision: "test-v1", text: "Reply." }),
      },
      model: {
        acquire: () =>
          Effect.sync(() => {
            const faux = fauxModel([]);
            faux.setResponses([fauxAssistantMessage("done")]);
            return {
              model: faux.model,
              stream: faux.stream,
              release: Effect.void,
            };
          }),
      },
      ...overrides,
    }),
  );
  const host = () => {
    if (bound === undefined) throw new Error("Runtime is not bound");
    return bound;
  };
  const pendingWork = () => execute(host().pendingWork);
  const reconcile = () => execute(host().reconcile);
  return {
    agent,
    pendingWork,
    reconcile,
    /** Reconcile until nothing is pending, bounded. */
    drain: async () => {
      for (let pass = 0; pass < 500; pass += 1) {
        if (!(await pendingWork()).pending) return;
        await reconcile();
      }
      throw new Error("Runtime did not drain");
    },
    /** The Promise-shaped extension controls client bindings take. */
    extensions: {
      list: () => run(agent.extensions.list),
      resume: (id) => run(agent.extensions.resume(id)),
      call: (id, command, input) =>
        run(agent.extensions.call(id, command, input)),
    } satisfies AgentExtensionControls,
    /** A Promise-shaped Session address for client bindings. */
    session: (sessionId: string) => ({
      extension: (id: string) => ({
        call: (command: string, input: Json) =>
          run(agent.session(sessionId).extension(id).call(command, input)),
      }),
      read: () => run(agent.session(sessionId).read()),
    }),
    close: () => execute(agent.close),
  };
}

/** Grant each roster member exactly what it requests. */
export function grantAll(
  roster: ExtensionRosterV0["roster"],
): ExtensionRosterV0 {
  return {
    roster,
    grants: roster.map(({ manifest }) => ({
      id: manifest.id,
      capabilities: manifest.requests,
    })),
  };
}
