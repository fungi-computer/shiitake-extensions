/** Host-owned discovery metadata; bodies are loaded only through skill.load. */
export type SkillDescription = Readonly<{
  name: string;
  description: string;
  location: string;
}>;

/** Safe discovery explanation, with the original cause kept separately for redacted logs. */
export type SkillDiagnostic = Readonly<{
  path: string;
  reason:
    | "invalid"
    | "collision"
    | "unavailable"
    | "bound"
    | "warning"
    | "skipped"
    | "empty";
  message: string;
  cause: unknown;
}>;

export type SkillCatalog = Readonly<{
  skills: readonly SkillDescription[];
  diagnostics: readonly SkillDiagnostic[];
}>;

/** Read-only host port. The host owns frontmatter, discovery and containment. */
export type SkillSource = Readonly<{
  catalog: (signal: AbortSignal) => Promise<SkillCatalog>;
  read: (
    name: string,
    file: string | undefined,
    signal: AbortSignal,
  ) => Promise<
    Readonly<{
      name: string;
      file: string;
      content: string;
      baseDirectory: string;
      supportingFiles: readonly string[];
    }>
  >;
}>;
