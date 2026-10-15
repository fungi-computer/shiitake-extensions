import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { fromTypedSandbox } from "@fungi.computer/mycelium/effect";
import type { Context } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import { inspect } from "node:util";
import { parsePromptAnswer } from "@fungi.computer/whistle/wire";
import { catalogCommands, parseCatalog } from "@fungi.computer/whistle/catalog";
import {
  createWhistle,
  type WhistleInteraction,
  type WhistlePrompt,
} from "@fungi.computer/whistle";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { botanicalExtensionsWithSkills } from "../src/roster.js";
import { skillsExtension, skillsGrant } from "../src/skills/host.js";
import type {
  SkillCatalog,
  SkillDiagnostic,
  SkillSource,
} from "../src/skills/source.js";
import { openAgent, sqliteOwner } from "./fixtures/host.js";

function sourceFor(catalog: SkillCatalog) {
  const reads: { name: string; file: string | undefined }[] = [];
  const source: SkillSource = {
    catalog: () => Promise.resolve(catalog),
    read: (name, file) => {
      reads.push({ name, file });
      return Promise.resolve({
        name,
        file: file ?? "SKILL.md",
        content:
          file === undefined ? "herdr instructions" : "supporting content",
        baseDirectory: "/home/fixture/.agents/skills/herdr",
        supportingFiles: file === undefined ? ["reference.md"] : [],
      });
    },
  };
  return { source, reads };
}

async function exercise(
  source: SkillSource,
  capabilities: typeof skillsGrant.capabilities,
  useTool = true,
  logger?: Logger.Logger<unknown, unknown>,
) {
  const store = sqliteOwner();
  const faux = fauxModel([]);
  const requests: Context[] = [];
  const discovery: unknown[] = [];
  const results: unknown[] = [];
  faux.setResponses(
    useTool
      ? [
          fauxAssistantMessage(
            fauxToolCall("execute", {
              code: 'return await skill.load({name:"herdr"});',
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Loaded"),
        ]
      : [fauxAssistantMessage("Done")],
  );
  const host = await openAgent(
    store.owner,
    {
      roster: [skillsExtension({ source })],
      grants: [{ id: skillsGrant.id, capabilities }],
    },
    {
      model: {
        acquire: () =>
          Effect.succeed({
            model: faux.model,
            stream: (model, context, options) => {
              requests.push(structuredClone(context));
              return faux.stream(model, context, options);
            },
            release: Effect.void,
          }),
      },
      tools: {
        modules: [],
        sources: [],
        sandbox: fromTypedSandbox({
          execute: async ({ bindings }) => {
            const search = bindings.forage?.search;
            if (!search) throw new Error("Missing forage search");
            discovery.push(await search({ query: "skill" }));
            discovery.push(await search({ query: "herdr" }));
            const load = bindings.skill?.load;
            if (!load) {
              results.push({ unavailable: true });
              return { unavailable: true };
            }
            const body = await load({ name: "herdr" });
            const reference = await load({
              name: "herdr",
              file: "reference.md",
            });
            results.push(body, reference);
            return body;
          },
        }),
      },
    },
    logger,
  );
  try {
    await Effect.runPromise(
      host.agent.session("skills").command({
        type: "prompt",
        delivery: "followUp",
        requestId: "load",
        text: "Do you have a herdr skill?",
      }),
    );
    await host.drain();
    return { requests, discovery, results };
  } finally {
    await host.close();
    store.close();
  }
}

function prompts(requests: Context[]) {
  return requests.flatMap((request) =>
    request.messages
      .filter((message) => message.role === "system")
      .map((message) => z.string().parse(message.content)),
  );
}

describe("skills extension", () => {
  it("lists escaped metadata and exposes skill.load through forage, with bodies only in tool output", async () => {
    const { source, reads } = sourceFor({
      skills: [
        {
          name: "herdr",
          description: "Coordinate <agents> & teams",
          location: "/home/fixture/.agents/skills/herdr/SKILL.md",
        },
      ],
      diagnostics: [],
    });
    const result = await exercise(source, skillsGrant.capabilities);
    expect(prompts(result.requests)).toHaveLength(2);
    for (const prompt of prompts(result.requests)) {
      expect(prompt).toContain("[extension:botanical-skills.skills]");
      expect(prompt).toContain("<name>herdr</name>");
      expect(prompt).toContain("Coordinate &lt;agents&gt; &amp; teams");
      expect(prompt).toContain("no forage lookup is needed");
      expect(prompt).toContain("omit file to read its SKILL.md body");
      expect(prompt).not.toContain("herdr instructions");
    }
    for (const search of result.discovery) {
      const parsed = z
        .object({ results: z.array(z.object({ path: z.string() })) })
        .parse(search);
      expect(parsed.results.map((entry) => entry.path)).toContain("skill.load");
      expect(parsed.results.map((entry) => entry.path)).not.toContain(
        "skills.read",
      );
    }
    expect(result.results).toEqual([
      {
        name: "herdr",
        file: "SKILL.md",
        content: "herdr instructions",
        baseDirectory: "/home/fixture/.agents/skills/herdr",
        supportingFiles: ["reference.md"],
      },
      {
        name: "herdr",
        file: "reference.md",
        content: "supporting content",
        baseDirectory: "/home/fixture/.agents/skills/herdr",
        supportingFiles: [],
      },
    ]);
    expect(reads).toEqual([
      { name: "herdr", file: undefined },
      { name: "herdr", file: "reference.md" },
    ]);
    expect(JSON.stringify(result.requests[1]?.messages)).toContain(
      "herdr instructions",
    );
  });

  it("says explicitly when no skills are installed", async () => {
    const { source } = sourceFor({ skills: [], diagnostics: [] });
    const result = await exercise(source, skillsGrant.capabilities, false);
    expect(prompts(result.requests)[0]).toContain(
      "No skills are installed; add them under .fungi/skills or ~/.agents/skills.",
    );
  });

  it("distinguishes empty roots from rejected skills and reports the reason in the skills section", async () => {
    const scenarios: readonly [SkillDiagnostic["reason"], string, string][] = [
      ["empty", "Skill root is empty", "Skill root is empty"],
      ["invalid", "description is required", "No usable skills were found"],
    ];
    for (const [reason, message, expected] of scenarios) {
      const { source } = sourceFor({
        skills: [],
        diagnostics: [
          { path: "/skills", reason, message, cause: new Error(message) },
        ],
      });
      const result = await exercise(source, skillsGrant.capabilities, false);
      const prompt = prompts(result.requests)[0];
      expect(prompt).toContain(expected);
      expect(prompt).toContain(message);
      expect(prompt).toContain("/skills");
    }
  });

  it("respects independent prompt and run_tools grants", async () => {
    const { source, reads } = sourceFor({
      skills: [
        {
          name: "herdr",
          description: "Coordinate teams",
          location: "/skills/herdr/SKILL.md",
        },
      ],
      diagnostics: [],
    });
    const withoutPrompt = await exercise(source, ["run_tools"]);
    expect(prompts(withoutPrompt.requests).join(" ")).not.toContain(
      "available_skills",
    );
    expect(reads).toHaveLength(2);
    const withoutTools = await exercise(source, ["prompt"]);
    expect(prompts(withoutTools.requests)[0]).toContain("available_skills");
    expect(withoutTools.results).toEqual([{ unavailable: true }]);
    expect(reads).toHaveLength(2);
    expect([...skillsExtension({ source }).manifest.requests].sort()).toEqual([
      "commands",
      "prompt",
      "run_tools",
      "send",
    ]);
    expect(botanicalExtensionsWithSkills(source).grants.at(-1)).toEqual(
      skillsGrant,
    );
  });

  it("keeps every skill visible within core prompt bounds, marking shortened descriptions", async () => {
    const skills = Array.from({ length: 14 }, (_, n) => ({
      name: `skill-${String(n)}`,
      description: "&".repeat(1_024),
      location: `/skills/skill-${String(n)}/SKILL.md`,
    }));
    const { source } = sourceFor({ skills, diagnostics: [] });
    const result = await exercise(source, skillsGrant.capabilities, false);
    const prompt = prompts(result.requests)[0] ?? "";
    for (const skill of skills)
      expect(prompt).toContain(`<name>${skill.name}</name>`);
    expect(prompt).toContain("&amp;".repeat(512));
    expect(prompt).toContain("[extension:botanical-skills.skills-2]");
  });

  it("admits a run with the full skills grant when the skill-name index exceeds tool metadata bounds", async () => {
    const skills = Array.from({ length: 20 }, (_, n) => ({
      name: `skill-${String(n).padStart(2, "0")}-${"a".repeat(55)}`,
      description: "A project skill",
      location: `/skills/${String(n)}/SKILL.md`,
    }));
    const { source } = sourceFor({ skills, diagnostics: [] });
    const result = await exercise(source, skillsGrant.capabilities, false);
    expect(result.requests).toHaveLength(1);
    const prompt = prompts(result.requests).join("\n");
    for (const skill of skills)
      expect(prompt).toContain(`<name>${skill.name}</name>`);
  });

  it("reports per-skill diagnostics with the redacted original cause", async () => {
    const failure = new Error("private-skill-marker", {
      cause: new Error("private-nested-marker"),
    });
    const { source } = sourceFor({
      skills: [],
      diagnostics: [
        {
          path: "/skills/bad/SKILL.md",
          reason: "invalid",
          message: "Invalid skill metadata",
          cause: failure,
        },
      ],
    });
    const messages: unknown[] = [];
    const logger = Logger.make<unknown, undefined>(({ message }) => {
      const parts: readonly unknown[] = Array.isArray(message)
        ? message
        : [message];
      messages.push(...parts);
    });
    await exercise(source, ["prompt"], false, logger);
    const retained = messages.filter(Redacted.isRedacted).map(Redacted.value);
    expect(retained).toContain(failure);
    expect(inspect(messages, { depth: null })).not.toContain(
      "private-skill-marker",
    );
  });

  it("advertises /skills, which lists each discovered skill under its folder and shows the chosen file", async () => {
    const { source } = sourceFor({
      skills: [
        {
          name: "botanical-retention",
          description: "Retain Botanical code",
          location: "/work/.agents/skills/botanical-retention/SKILL.md",
        },
        {
          name: "herdr",
          description: "Coordinate teams",
          location: "/home/fixture/.agents/skills/herdr/SKILL.md",
        },
      ],
      diagnostics: [
        {
          path: "/home/fixture/.agents/skills/dup/SKILL.md",
          reason: "collision",
          message: "Earlier skill with this name wins",
          cause: undefined,
        },
        {
          path: "/home/fixture/.fungi/skills",
          reason: "empty",
          message: "Skill root is empty",
          cause: undefined,
        },
      ],
    });
    const store = sqliteOwner();
    const host = await openAgent(
      store.owner,
      botanicalExtensionsWithSkills(source),
    );
    try {
      const session = host.session("garden");
      const runtime = createWhistle();
      for (const [slotId, slot] of Object.entries(
        (await session.read()).extensions,
      )) {
        if (slot.status !== "running" || slot.catalog === undefined) continue;
        runtime.contribute({
          sourceId: slotId,
          namespace: slotId,
          commands: catalogCommands(
            parseCatalog(slot.catalog),
            (command, args) => session.extension(slotId).call(command, args),
          ),
        });
      }
      expect(
        runtime.snapshot().slash.find((row) => row.alias === "skills")
          ?.commandId,
      ).toBe("botanical-skills:skills");
      const asked: WhistlePrompt[] = [];
      const notices: string[] = [];
      const interaction: WhistleInteraction = {
        signal: new AbortController().signal,
        prompt: (prompt) => {
          asked.push(prompt);
          return Promise.resolve(parsePromptAnswer(prompt, "herdr"));
        },
        notify: (notice) => {
          notices.push(notice.type === "handoff" ? notice.url : notice.message);
        },
      };
      await expect(
        runtime.execute("botanical-skills:skills", {
          origin: "slash",
          interaction,
        }),
      ).resolves.toMatchObject({ status: "handled" });
      expect(asked).toEqual([
        {
          type: "choice",
          message:
            "2 skills discovered\nNot loaded:\ncollision: Earlier skill with this name wins (/home/fixture/.agents/skills/dup/SKILL.md)",
          options: [
            {
              value: "botanical-retention",
              label: "botanical-retention",
              description: "/work/.agents/skills/botanical-retention/SKILL.md",
            },
            {
              value: "herdr",
              label: "herdr",
              description: "/home/fixture/.agents/skills/herdr/SKILL.md",
            },
          ],
        },
      ]);
      expect(notices).toEqual([
        "herdr\nCoordinate teams\n/home/fixture/.agents/skills/herdr/SKILL.md",
      ]);
      runtime.close();
    } finally {
      await host.close();
      store.close();
    }
  });
});
