/** Longest title a modal carries. */
export const titleLimit = 60;

/**
 * A short name for long user text: its first line's first sentence, whitespace collapsed
 * and cut at a word to `limit` characters with an ellipsis.
 */
export function headline(objective: string, limit: number): string {
  const line =
    objective
      .split("\n")
      .map((part) => part.replace(/\s+/gu, " ").trim())
      .find((part) => part !== "") ?? "";
  const sentence = (/^.*?[.!?](?=\s|$)/u.exec(line)?.[0] ?? line).replace(
    /[.!?]+$/u,
    "",
  );
  if (sentence.length <= limit) return sentence;
  const cut = sentence.slice(0, Math.max(0, limit - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
