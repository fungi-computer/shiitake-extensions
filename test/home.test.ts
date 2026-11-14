import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import type { FilesPort } from "@fungi.computer/knapsack";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { homeContract } from "../src/home/contract.js";
import {
  homeExtension,
  homeGrant,
  type HomeComputer,
} from "../src/home/host.js";
import { homeFilesRouting } from "../src/home/routing.js";
import { openAgent, sqliteOwner } from "./fixtures/host.js";

const instructionPath = (path: string) =>
  path === "AGENTS.md" || path === "SYSTEM.md";

/** A Files host's absent path, as the local and Computer hosts report it. */
function absentPath(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

function computer(
  name: string,
  calls: string[],
  patch = false,
  files: Readonly<Record<string, string>> = {},
): HomeComputer {
  function paths(
    operation: "list" | "glob",
    path: string,
  ): ReturnType<FilesPort["list"]> {
    calls.push(`${name}:${operation}:${path}`);
    return Promise.resolve({
      path,
      results: [{ path: `${path}/x y`, type: "file" }],
      truncated: null,
    });
  }
  const port: FilesPort = {
    read: (input) => {
      if (instructionPath(input.path)) {
        const content = files[input.path];
        if (content === undefined)
          return Promise.reject(absentPath(input.path));
        return Promise.resolve({
          path: input.path,
          content,
          offset: 0,
          nextOffset: null,
          truncated: false,
          file: { computerId: `cmp_${name}`, path: `/${input.path}` },
        });
      }
      calls.push(`${name}:read:${input.path}`);
      return Promise.resolve({
        path: input.path,
        content: name,
        offset: 0,
        nextOffset: null,
        truncated: false,
        file: {
          computerId: `cmp_${name}`,
          path: input.path.startsWith("/") ? input.path : `/${input.path}`,
        },
      });
    },
    list: ({ path }) => paths("list", path),
    glob: ({ path }) => paths("glob", path),
    grep: ({ path }) => {
      calls.push(`${name}:grep:${path}`);
      return Promise.resolve({
        path,
        results: [{ path: `${path}/x y`, line: 1, text: name }],
        truncated: null,
      });
    },
    replace: ({ path }) => {
      calls.push(`${name}:replace:${path}`);
      return Promise.resolve({ path, bytes: 1 });
    },
  };
  const patchPort: FilesPort = {
    ...port,
    patch({ patch: text }) {
      expect(this).toBe(patchPort);
      calls.push(`${name}:patch:${text}`);
      return Promise.resolve({
        status: "completed",
        exitCode: 0,
        stdout: "patched",
        stderr: "",
        truncated: false,
      });
    },
  };
  return { name, attachmentId: `att_${name}`, port: patch ? patchPort : port };
}

async function fixture(initial: readonly HomeComputer[], allowed = true) {
  const store = sqliteOwner();
  const faux = fauxModel([]);
  let computers = initial;
  let captures = 0;
  let sequence = 0;
  const prompts: string[] = [];
  const tools: string[][] = [];
  const descriptions: string[] = [];
  const member = homeExtension({
    computers: {
      read: () => {
        captures += 1;
        return computers;
      },
    },
  });
  const host = await openAgent(
    store.owner,
    { roster: [member], grants: [homeGrant] },
    {
      model: {
        acquire: () =>
          Effect.succeed({
            retryable: () => false,
            model: faux.model,
            stream: (model, context, options) => {
              const system = context.messages[0];
              if (system?.role !== "system")
                throw new Error("Missing system prompt");
              prompts.push(getSystemMessageText(system));
              tools.push(system.toolsAdded?.map(({ name }) => name) ?? []);
              descriptions.push(
                ...(system.toolsAdded ?? []).map(
                  ({ description }) => description,
                ),
              );
              return faux.stream(model, context, options);
            },
            release: Effect.void,
          }),
      },
      tools: {
        sources: [],
        modules: [],
        sandbox: fromTypedSandbox({ execute: () => Promise.resolve(null) }),
        access: { grants: { files: allowed ? "write" : "none" } },
      },
    },
  );
  return {
    host,
    store,
    faux,
    prompts,
    tools,
    descriptions,
    captures: () => captures,
    attach: (next: readonly HomeComputer[]) => {
      computers = next;
    },
    run: async (responses = [fauxAssistantMessage("done")]) => {
      faux.setResponses(responses);
      await Effect.runPromise(
        host.agent.session("garden").send("Use Home", {
          requestId: `home-${String(++sequence)}`,
          delivery: "followUp",
        }),
      );
      await host.drain();
      expect(
        (await host.session("garden").read()).terminals.at(-1)?.outcome,
      ).toBe("completed");
    },
    choose: (name: string) =>
      host.session("garden").extension(homeContract.id).call("home", { name }),
    view: async () =>
      bindSessionExtension(host.session("garden"), homeContract).view(
        await host.session("garden").read(),
      ),
    close: async () => {
      await host.close();
      store.close();
    },
  };
}

const read = (path: string) =>
  fauxAssistantMessage(fauxToolCall("read", { path }), {
    stopReason: "toolUse",
  });

it.each([0, 2])(
  "offers no implicit default with %s attachments",
  async (count) => {
    const calls: string[] = [];
    const test = await fixture(
      [computer("a", calls), computer("b", calls)].slice(0, count),
    );
    try {
      await test.run();
      expect(test.tools).toEqual([["execute"]]);
      expect(test.prompts[0]).toContain("No Home selected");
      expect(await test.view()).toMatchObject({
        status: "running",
        value: null,
      });
      expect(calls).toEqual([]);
    } finally {
      await test.close();
    }
  },
);

it("offers a person only the current attachments when choosing Home", async () => {
  const calls: string[] = [];
  const test = await fixture([]);
  try {
    await expect(
      test.host.session("garden").extension(homeContract.id).call("home", {}),
    ).resolves.toMatchObject({
      type: "done",
      notice: {
        type: "info",
        message: "No Computers attached. Attach one before choosing Home.",
      },
    });
    test.attach([computer("a", calls), computer("b", calls)]);
    await expect(
      test.host.session("garden").extension(homeContract.id).call("home", {}),
    ).resolves.toEqual({
      type: "prompt",
      prompt: {
        type: "choice",
        message: "Choose a Home Computer",
        summary: "The Agent reads and edits files here by default.",
        options: [
          { value: "a", label: "a" },
          { value: "b", label: "b" },
        ],
      },
      next: { arguments: {}, answer: "name" },
    });
    await expect(test.choose("b")).resolves.toMatchObject({
      type: "done",
      notice: { type: "success", message: "Home: b" },
    });
    expect(await test.view()).toMatchObject({
      value: { attachmentId: "att_b" },
    });
    await expect(
      test.host.session("garden").extension(homeContract.id).call("home", {}),
    ).resolves.toMatchObject({
      type: "prompt",
      prompt: { current: "b" },
    });
    expect(calls).toEqual([]);
  } finally {
    await test.close();
  }
});

it("adopts a sole attachment once and never repicks a detached Home", async () => {
  const calls: string[] = [];
  const a = computer("a", calls);
  const b = computer("b", calls);
  const test = await fixture([a]);
  try {
    await test.run([read("/x"), fauxAssistantMessage("done")]);
    expect(calls).toEqual(["a:read:/x"]);
    expect(await test.view()).toMatchObject({
      value: { attachmentId: "att_a" },
    });
    test.attach([b]);
    await test.run();
    expect(test.tools.at(-1)).toEqual(["execute"]);
    expect(test.prompts.at(-1)).toContain("default Computer is detached");
    expect(await test.view()).toMatchObject({
      value: { attachmentId: "att_a" },
    });
    await test.choose("b");
    await test.run([read("computer://home/x"), fauxAssistantMessage("done")]);
    expect(calls).toEqual(["a:read:/x", "b:read:x"]);
    expect(await test.view()).toMatchObject({
      value: { attachmentId: "att_b" },
    });
    await expect(test.choose("foreign")).rejects.toMatchObject({
      boundary: "contract",
      cause: "invalid",
    });
    expect(await test.view()).toMatchObject({
      value: { attachmentId: "att_b" },
    });
  } finally {
    await test.close();
  }
});

it("captures ports and prompt once despite a human changing Home during a run", async () => {
  const calls: string[] = [];
  const a = computer("a", calls);
  const b = computer("b", calls);
  const test = await fixture([a, b]);
  try {
    await test.choose("a");
    const before = test.captures();
    let changed = false;
    const readA = a.port.read;
    const capturedA: HomeComputer = {
      ...a,
      port: {
        ...a.port,
        read: async (input, context) => {
          const result = await readA(input, context);
          if (!changed) {
            changed = true;
            await test.choose("b");
            test.attach([b, a]);
          }
          return result;
        },
      },
    };
    test.attach([capturedA, b]);
    await test.run([read("/one"), read("/two"), fauxAssistantMessage("done")]);
    expect(test.captures() - before).toBe(2); // one run capture and the human command
    expect(calls).toEqual(["a:read:/one", "a:read:/two"]);
    expect(test.prompts.every((prompt) => prompt.includes("Home: a."))).toBe(
      true,
    );
    expect(test.tools.every((names) => !names.includes("home"))).toBe(true);
    await test.run([read("/three"), fauxAssistantMessage("done")]);
    expect(calls.at(-1)).toBe("b:read:/three");
    expect(test.prompts.at(-1)).toContain("Home: b.");
  } finally {
    await test.close();
  }
});

it("does not repeat the Home path sentence in each Files tool description", async () => {
  const test = await fixture([computer("a", [], true)]);
  try {
    await test.run();
    expect(test.prompts.at(-1)).toContain("Bare paths and computer://home/");
    expect(test.descriptions.length).toBeGreaterThan(0);
    for (const description of test.descriptions) {
      expect(description).not.toContain("computer://");
    }
  } finally {
    await test.close();
  }
});

it("gates every direct call before touching its selected port", async () => {
  const calls: string[] = [];
  const test = await fixture([computer("a", calls, true)], false);
  try {
    await test.run([
      read("/x"),
      fauxAssistantMessage(
        fauxToolCall("apply_patch", {
          patch: "*** Begin Patch\n*** End Patch",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    expect(test.tools[0]).toHaveLength(6);
    expect(test.tools[0]).toEqual(
      expect.arrayContaining([
        "execute",
        "read",
        "list",
        "glob",
        "grep",
        "apply_patch",
      ]),
    );
    expect(calls).toEqual([]);
  } finally {
    await test.close();
  }
});

it("routes explicit Computer URIs only through the captured named port", async () => {
  const calls: string[] = [];
  const test = await fixture([
    computer("a", calls, true),
    computer("b", calls),
  ]);
  try {
    await test.choose("a");
    await test.run([
      read("computer://b/x%20y"),
      read("computer://foreign/x"),
      read("https://b/x"),
      read("computer://user@b/x"),
      fauxAssistantMessage(
        fauxToolCall("apply_patch", {
          patch: "*** Begin Patch\n*** End Patch",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    expect(calls).toEqual([
      "b:read:x y",
      "a:patch:*** Begin Patch\n*** End Patch",
    ]);
    expect(test.captures()).toBe(2); // human selection plus one run capture
    expect(test.prompts.every((prompt) => prompt.includes("Home: a."))).toBe(
      true,
    );
  } finally {
    await test.close();
  }
});

it("keeps the chosen attachment in Agent state across a runtime reopen", async () => {
  const test = await fixture([computer("a", []), computer("b", [])]);
  let reopened: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await test.choose("b");
    await test.host.close();
    reopened = await openAgent(test.store.owner, {
      roster: [
        homeExtension({
          computers: { read: () => [computer("a", [])] },
        }),
      ],
      grants: [homeGrant],
    });
    expect(
      bindSessionExtension(reopened.session("other"), homeContract).view(
        await reopened.session("other").read(),
      ),
    ).toMatchObject({
      value: { attachmentId: "att_b" },
    });
  } finally {
    await reopened?.close();
    await test.close();
  }
});

it("seeds migration state once without making a detached default implicit", async () => {
  const test = await fixture([]);
  try {
    await expect(
      test.host.extensions.call(homeContract.id, "seed", {
        attachmentId: "old",
      }),
    ).resolves.toEqual({ seeded: true });
    await expect(
      test.host.extensions.call(homeContract.id, "seed", {
        attachmentId: "other",
      }),
    ).resolves.toEqual({ seeded: false });
    test.attach([computer("new", [])]);
    await test.run();
    expect(test.tools.at(-1)).toEqual(["execute"]);
    expect(test.prompts.at(-1)).toContain("detached");
    expect(await test.view()).toMatchObject({ value: { attachmentId: "old" } });
  } finally {
    await test.close();
  }
});

it("keeps named locators and the scoped port's file identity across every Files operation", async () => {
  const calls: string[] = [];
  const a = computer("a", calls);
  const b = computer("b", calls);
  const context = {
    executionId: "home-routing",
    deadlineAt: Date.now() + 10_000,
    signal: new AbortController().signal,
  };
  const files = homeFilesRouting(
    new Map([
      ["a", a.port],
      [
        "b",
        {
          ...b.port,
          read: (input, invocation) => {
            expect(invocation).toBe(context);
            return b.port.read(input, invocation);
          },
        },
      ],
    ]),
    a.port,
  );
  await expect(
    files.read({ path: "computer://b/x%20y", offset: 0, limit: 20 }, context),
  ).resolves.toMatchObject({
    path: "computer://b/x%20y",
    content: "b",
    file: { computerId: "cmp_b", path: "/x y" },
  });
  await expect(
    files.list(
      {
        path: "computer://b/folder",
        limit: 20,
      },
      context,
    ),
  ).resolves.toMatchObject({
    path: "computer://b/folder",
    results: [{ path: "computer://b/folder/x%20y" }],
  });
  await expect(
    files.glob(
      {
        path: "computer://b/folder",
        pattern: "*",
        limit: 20,
      },
      context,
    ),
  ).resolves.toMatchObject({
    path: "computer://b/folder",
    results: [{ path: "computer://b/folder/x%20y" }],
  });
  await expect(
    files.grep(
      {
        path: "computer://b/folder",
        pattern: "b",
        regex: false,
        ignoreCase: false,
        limit: 20,
      },
      context,
    ),
  ).resolves.toMatchObject({
    path: "computer://b/folder",
    results: [{ path: "computer://b/folder/x%20y", line: 1, text: "b" }],
  });
  await expect(
    files.replace(
      { path: "computer://b/x%20y", expectedContent: "b", content: "changed" },
      context,
    ),
  ).resolves.toEqual({ path: "computer://b/x%20y", bytes: 1 });
  expect(calls).toEqual([
    "b:read:x y",
    "b:list:folder",
    "b:glob:folder",
    "b:grep:folder",
    "b:replace:x y",
  ]);
});

it("preserves an explicitly empty migrated choice instead of adopting a later sole attachment", async () => {
  const test = await fixture([]);
  try {
    await expect(
      test.host.extensions.call(homeContract.id, "seed", {
        attachmentId: null,
      }),
    ).resolves.toEqual({ seeded: true });
    test.attach([computer("new", [])]);
    await test.run();
    expect(test.tools.at(-1)).toEqual(["execute"]);
    expect(test.prompts.at(-1)).toContain("No Home selected");
    expect(await test.view()).toMatchObject({ value: { attachmentId: null } });
    await expect(
      test.host.extensions.call(homeContract.id, "seed", {
        attachmentId: "att_new",
      }),
    ).resolves.toEqual({ seeded: false });
  } finally {
    await test.close();
  }
});

it("round-trips root-relative URI results through the same port", async () => {
  const calls: string[] = [];
  const local = computer("local", calls);
  const files = homeFilesRouting(new Map([["local", local.port]]), local.port);
  const context = {
    executionId: "round-trip",
    deadlineAt: null,
    signal: new AbortController().signal,
  };
  for (const path of [
    "src/x y",
    "computer://home/src/x%20y",
    "computer://local/src/x%20y",
  ]) {
    await files.read({ path, offset: 0, limit: 20 }, context);
  }
  expect(calls).toEqual(Array(3).fill("local:read:src/x y"));
  const found = await files.list(
    {
      path: "computer://home/src",
      limit: 20,
    },
    context,
  );
  for (const path of found.results.map((result) => result.path)) {
    await files.read({ path, offset: 0, limit: 20 }, context);
    expect(calls.at(-1)).toBe("local:read:src/x y");
  }
});

const marker = "[extension:botanical-home.instructions]";

it("puts Home's AGENTS.md and SYSTEM.md after the host text in their own section", async () => {
  const test = await fixture([
    computer("a", [], false, {
      "AGENTS.md": "\uFEFFAlways answer in haiku.\n",
      "SYSTEM.md": "You are Mossy.",
    }),
  ]);
  try {
    await test.run();
    const prompt = test.prompts[0] ?? "";
    const home = prompt.indexOf("[extension:botanical-home.home]");
    expect(home).toBeGreaterThan(0);
    expect(prompt.indexOf(marker)).toBeGreaterThan(home);
    const section = prompt.slice(prompt.indexOf(marker));
    expect(section).toContain("They never grant tools, approvals or access.");
    expect(section).toContain("## AGENTS.md\nAlways answer in haiku.");
    expect(section).toContain("## SYSTEM.md\nYou are Mossy.");
    expect(prompt.slice(0, home)).not.toContain("haiku");
  } finally {
    await test.close();
  }
});

it("adds no section when Home has no instruction files", async () => {
  const test = await fixture([computer("a", [])]);
  try {
    await test.run();
    expect(test.prompts[0]).not.toContain(marker);
  } finally {
    await test.close();
  }
});

it("names an over-limit file instead of truncating it, and the run continues", async () => {
  const test = await fixture([
    computer("a", [], false, {
      "AGENTS.md": "x".repeat(32_001),
      "SYSTEM.md": "short voice",
    }),
  ]);
  try {
    await test.run();
    const section = (test.prompts[0] ?? "").slice(
      (test.prompts[0] ?? "").indexOf(marker),
    );
    expect(section).toContain(
      "AGENTS.md is 32001 bytes; the limit is 32000 for Home's instruction files; ask your owner to shorten it",
    );
    expect(section).toContain("## SYSTEM.md\nshort voice");
    expect(section).not.toContain("xxxxxxxx");
  } finally {
    await test.close();
  }
});

it("adds no section when no Computer is captured for the session", async () => {
  const test = await fixture([]);
  try {
    await test.run();
    expect(test.prompts[0]).toContain("No Home selected");
    expect(test.prompts[0]).not.toContain(marker);
  } finally {
    await test.close();
  }
});

it("keeps Home's instruction section inside the extension prompt headroom", async () => {
  const test = await fixture([
    computer("a", [], false, {
      "AGENTS.md": "a".repeat(20_000),
      "SYSTEM.md": "s".repeat(11_000),
    }),
  ]);
  try {
    await test.run();
    const prompt = test.prompts[0] ?? "";
    const extensions = prompt.slice(prompt.indexOf("[extension:"));
    // Shiitake fails a run whose extension sections exceed 65,536 bytes.
    expect(new TextEncoder().encode(extensions).byteLength).toBeLessThan(
      65_536,
    );
    expect(extensions).toContain("[extension:botanical-home.instructions-2]");
  } finally {
    await test.close();
  }
});

it("names an unreadable file in the section and still runs the Agent", async () => {
  const unreadable = computer("a", []);
  const test = await fixture([
    {
      ...unreadable,
      port: {
        ...unreadable.port,
        read: (input, context) =>
          instructionPath(input.path)
            ? Promise.reject(new Error("Computer is suspended"))
            : unreadable.port.read(input, context),
      },
    },
  ]);
  try {
    await test.run();
    const prompt = test.prompts[0] ?? "";
    expect(prompt).toContain("AGENTS.md could not be read from Home");
    // The cause is not copied into the prompt.
    expect(prompt).not.toContain("suspended");
  } finally {
    await test.close();
  }
});
