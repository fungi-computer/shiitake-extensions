import { describe, expect, it } from "vitest";
import {
  admitSkill,
  newSkillAdmission,
  parseSkill,
  skillCatalogOf,
  skillFileSchema,
  skillNameSchema,
  SkillSourceError,
} from "../src/skills/discovery.js";
import {
  botanicalAgentExtensions,
  botanicalExtensionsWithSkillSource,
  botanicalExtensionsWithSkills,
} from "../src/roster.js";
import type { SkillSource } from "../src/skills/source.js";

const origin = { kind: "project" } as const;
const found = (name: string, description = "A skill", directory = name) => ({
  metadata: parseSkill(
    `---\nname: ${name}\ndescription: ${description}\n---\nb`,
    directory,
  ).metadata,
  directoryName: directory,
  skillPath: `/skills/${directory}/SKILL.md`,
  location: `/skills/${directory}/SKILL.md`,
  displayLocation: `skills/${directory}/SKILL.md`,
  origin,
});

describe("the rules every host applies to a SKILL.md", () => {
  it("splits frontmatter from the body and takes the folder's name when none is given", () => {
    const parsed = parseSkill(
      "---\ndescription: Water ferns\n---\nBody\r\nmore\n",
      "watering",
    );
    expect(parsed.metadata.name).toBe("watering");
    expect(parsed.metadata.description).toBe("Water ferns");
    expect(parsed.body).toBe("Body\nmore\n");
  });

  it("refuses a file without frontmatter, with broken YAML, wrong field types or no description", () => {
    for (const [content, message] of [
      ["Just text", "SKILL.md requires YAML frontmatter"],
      ["---\nname: [oops\n---\nb", "Skill frontmatter is not valid YAML"],
      [
        "---\ndescription: 7\n---\nb",
        "Skill frontmatter has invalid field types",
      ],
      ["---\nname: x\n---\nb", "description is required"],
      ["---\ndescription: '  '\n---\nb", "description is required"],
    ] as const)
      expect(() => parseSkill(content, "x")).toThrow(
        new SkillSourceError(message),
      );
  });

  it("checks names and supporting-file paths", () => {
    expect(skillNameSchema.safeParse("water-ferns").success).toBe(true);
    for (const bad of ["Water", "water--ferns", "-water", "", "a".repeat(65)])
      expect(skillNameSchema.safeParse(bad).success).toBe(false);
    expect(skillFileSchema.safeParse("reference/plants.md").success).toBe(true);
    for (const bad of [
      "/etc/passwd",
      "../x",
      "a/../b",
      "a\\b",
      "a//b",
      "C:x",
      "./x",
      "",
    ])
      expect(skillFileSchema.safeParse(bad).success).toBe(false);
  });

  it("admits a skill, warns about a mismatched name, lets the first name win and honours the bounds", () => {
    const state = newSkillAdmission();
    admitSkill(state, found("herdr"));
    admitSkill(state, found("herdr", "A second one"));
    admitSkill(state, found("Odd Name", "Odd", "odd-name"));
    expect(state.skills.map(({ name }) => name)).toEqual(["herdr", "Odd Name"]);
    expect(state.diagnostics.map(({ reason }) => reason)).toEqual([
      "collision",
      "warning",
    ]);
    const full = newSkillAdmission();
    for (let index = 0; index < 66; index += 1)
      admitSkill(full, found(`skill-${String(index)}`));
    expect(skillCatalogOf(full).skills).toHaveLength(64);
    expect(full.diagnostics.at(-1)?.reason).toBe("bound");
  });
});

describe("adding skills to a roster", () => {
  const source: SkillSource = {
    catalog: () => Promise.resolve({ skills: [], diagnostics: [] }),
    read: () => Promise.reject(new Error("unused")),
  };

  it("appends the skills extension and its grant to any roster, keeping the rest", () => {
    const roster = botanicalExtensionsWithSkillSource(
      botanicalAgentExtensions,
      source,
    );
    expect(roster.roster).toHaveLength(
      botanicalAgentExtensions.roster.length + 1,
    );
    expect(roster.grants.map(({ id }) => id)).toContain("botanical-skills");
    expect(roster.roster.slice(0, -1)).toEqual(botanicalAgentExtensions.roster);
  });

  it("keeps Local's sender-routed question extension where Local asks for skills", () => {
    const local = botanicalExtensionsWithSkills(source);
    expect(local.roster.map(({ manifest }) => manifest.id)).toContain(
      "botanical-skills",
    );
  });
});
