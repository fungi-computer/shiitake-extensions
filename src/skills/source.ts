/** Where a skill folder came from: the work itself, the person, or an installed extension. */
export type SkillOrigin =
  | Readonly<{
      /** Project-local or personal skill discovery root. */
      kind: "project" | "personal";
    }>
  | Readonly<{
      /** Skill supplied by an installed extension. */
      kind: "extension";
      /** Identity of the extension supplying the skill. */
      extensionId: string;
    }>;

/** Host-owned discovery metadata; bodies are loaded only through skill.load. */
export type SkillDescription = Readonly<{
  /** Name used to load this skill. */
  name: string;
  /** Discovery summary shown before loading the body. */
  description: string;
  /** Absolute file the host reads; the human's /skills view shows it. */
  location: string;
  /** Discovery root or installed extension supplying the skill. */
  origin: SkillOrigin;
  /**
   * The same file as the model should see it: relative to the invocation root,
   * `~/…` under home, otherwise absolute. Display only; loading keys on name.
   */
  displayLocation: string;
}>;

/** Safe discovery explanation, with the original cause kept separately for redacted logs. */
export type SkillDiagnostic = Readonly<{
  /** Discovery location associated with this diagnostic. */
  path: string;
  /** Typed discovery outcome. */
  reason:
    | "invalid"
    | "collision"
    | "unavailable"
    | "bound"
    | "warning"
    | "skipped"
    | "empty";
  /** Safe explanation suitable for discovery output. */
  message: string;
  /** Original cause reserved for the host's redacted logs. */
  cause: unknown;
}>;

/** Discovered skill descriptions and diagnostics from the same scan. */
export type SkillCatalog = Readonly<{
  /** Loadable skills admitted by discovery. */
  skills: readonly SkillDescription[];
  /** Discovery problems and informational outcomes. */
  diagnostics: readonly SkillDiagnostic[];
}>;

/** Read-only host port. The host owns frontmatter, discovery and containment. */
export type SkillSource = Readonly<{
  /** Discover available skills without loading their bodies. */
  catalog: (signal: AbortSignal) => Promise<SkillCatalog>;
  /** Load the selected skill body or one contained supporting file. */
  read: (
    name: string,
    file: string | undefined,
    signal: AbortSignal,
  ) => Promise<
    Readonly<{
      /** Name of the loaded skill. */
      name: string;
      /** Selected file within the skill. */
      file: string;
      /** UTF-8 body of the selected file. */
      content: string;
      /** Host-resolved directory containing the skill. */
      baseDirectory: string;
      /** Supporting files available to subsequent contained reads. */
      supportingFiles: readonly string[];
    }>
  >;
}>;
