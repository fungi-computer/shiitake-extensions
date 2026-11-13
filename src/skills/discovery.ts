import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  SkillCatalog,
  SkillDescription,
  SkillDiagnostic,
  SkillOrigin,
} from "./source.js";

/**
 * The rules of skill discovery, shared by every host: what a SKILL.md must
 * say, how a name and a file are checked, which bounds apply and how one
 * found skill is admitted to a catalog. A host brings only its own way of
 * walking and reading folders: Local its disk, Oyster an Agent's Computer.
 */

/** Most skills one catalog admits. */
export const maximumSkillCount = 64;
/** Most bytes the catalog's JSON may take. */
export const maximumCatalogBytes = 16_000;
/** Most bytes one skill file may be. */
export const maximumFileBytes = 128 * 1_024;
/** Most folder entries one discovery or supporting-file walk may visit. */
export const maximumDirectoryEntries = 512;
/** Deepest supporting-file folder nesting. */
export const maximumSupportingDepth = 16;
/** Deepest folder nesting a discovery walk searches. */
export const maximumDiscoveryDepth = 16;
const utf8 = new TextEncoder();

/** A refusal whose message is safe to show; any other failure is described generically. */
export class SkillSourceError extends Error {}

/** Lowercase letters, digits and single hyphens, at most 64 characters. */
export const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const frontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  "disable-model-invocation": z
    .unknown()
    .default(false)
    .transform((value) => value === true),
});

/** A supporting file named relative to its skill folder, never leaving it. */
export const skillFileSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (file) =>
      !file.startsWith("/") &&
      !/^[A-Za-z]:/u.test(file) &&
      !file.includes("\\") &&
      !file.includes("\0") &&
      file
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Skill file must remain a relative path inside its skill directory",
  );

/** A discovery diagnostic; `cause` defaults to the message itself. */
export function skillDiagnostic(
  path: string,
  reason: SkillDiagnostic["reason"],
  message: string,
  cause: unknown = new Error(message),
): SkillDiagnostic {
  return { path, reason, message, cause };
}

/** The message a refusal carries, else the fallback that hides any other cause. */
export function skillExplanation(cause: unknown, fallback: string): string {
  return cause instanceof SkillSourceError ? cause.message : fallback;
}

/** Where a skill's origin is named in a collision message. */
export function describeSkillOrigin(origin: SkillOrigin): string {
  return origin.kind === "extension"
    ? `extension ${origin.extensionId}`
    : origin.kind;
}

/**
 * Split a SKILL.md into its YAML frontmatter and body, or refuse it plainly:
 * no frontmatter, invalid YAML, wrong field types or no description.
 * `directoryName` names the skill when its frontmatter does not.
 */
export function parseSkill(content: string, directoryName: string) {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!match) throw new SkillSourceError("SKILL.md requires YAML frontmatter");
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1] ?? "");
  } catch (cause) {
    throw new SkillSourceError("Skill frontmatter is not valid YAML", {
      cause,
    });
  }
  const result = frontmatterSchema.safeParse(frontmatter);
  if (!result.success)
    throw new SkillSourceError("Skill frontmatter has invalid field types", {
      cause: result.error,
    });
  const metadata = result.data;
  if (metadata.description === undefined || metadata.description.trim() === "")
    throw new SkillSourceError("description is required");
  const name =
    metadata.name === "" ? directoryName : (metadata.name ?? directoryName);
  return {
    metadata: { ...metadata, name, description: metadata.description },
    body: normalized.slice(match[0].length),
  };
}

/** What one discovery pass has admitted so far; hosts hand the same state to each skill. */
export type SkillAdmission = Readonly<{
  skills: SkillDescription[];
  /** Which origin first took each name; the first wins. */
  owners: Map<string, SkillOrigin>;
  diagnostics: SkillDiagnostic[];
}>;

/** A fresh, empty admission state. */
export function newSkillAdmission(
  diagnostics: SkillDiagnostic[] = [],
): SkillAdmission {
  return { skills: [], owners: new Map(), diagnostics };
}

/** The finished catalog of an admission state. */
export function skillCatalogOf(state: SkillAdmission): SkillCatalog {
  return { skills: state.skills, diagnostics: state.diagnostics };
}

/**
 * Admit one parsed skill to the catalog, or say why not: a name that does not
 * match its folder or the naming rule and an overlong description are
 * warnings; a name already taken loses; a skill that disables model
 * invocation is skipped; the catalog's 64-skill and 16 KB bounds hold.
 */
export function admitSkill(
  state: SkillAdmission,
  found: Readonly<{
    metadata: ReturnType<typeof parseSkill>["metadata"];
    /** The folder holding SKILL.md, by name. */
    directoryName: string;
    /** Where SKILL.md is, as discovery reports problems. */
    skillPath: string;
    /** The file the host reads. */
    location: string;
    /** The same file as the model should see it. */
    displayLocation: string;
    origin: SkillOrigin;
  }>,
): void {
  const { metadata, directoryName, skillPath, origin } = found;
  const { diagnostics } = state;
  if (
    !skillNameSchema.safeParse(metadata.name).success ||
    metadata.name !== directoryName
  )
    diagnostics.push(
      skillDiagnostic(
        skillPath,
        "warning",
        "Skill name should match its directory, use lowercase letters, digits and single hyphens, and be at most 64 characters",
      ),
    );
  if (metadata.description.length > 1_024)
    diagnostics.push(
      skillDiagnostic(
        skillPath,
        "warning",
        "Skill description exceeds the recommended 1024 characters",
      ),
    );
  const winner = state.owners.get(metadata.name);
  if (winner !== undefined) {
    diagnostics.push(
      skillDiagnostic(
        skillPath,
        "collision",
        `${describeSkillOrigin(winner)} skill ${metadata.name} wins over ${describeSkillOrigin(origin)}`,
      ),
    );
    return;
  }
  state.owners.set(metadata.name, origin);
  if (metadata["disable-model-invocation"]) {
    diagnostics.push(
      skillDiagnostic(skillPath, "skipped", "Skill disables model invocation"),
    );
    return;
  }
  const skill: SkillDescription = {
    name: metadata.name,
    description: metadata.description,
    location: found.location,
    displayLocation: found.displayLocation,
    origin,
  };
  if (
    state.skills.length >= maximumSkillCount ||
    utf8.encode(JSON.stringify([...state.skills, skill])).byteLength >
      maximumCatalogBytes
  ) {
    diagnostics.push(
      skillDiagnostic(
        skillPath,
        "bound",
        "Skill catalog exceeds its 64-skill or 16 KB bound",
      ),
    );
    return;
  }
  state.skills.push(skill);
}
