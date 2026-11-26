import { z } from "zod";

// Mycelium's maintained operation interface uses Zod. The owner additionally
// decodes Questions for shared domain refinements and durable state.
const visible = /\S/u;
const baseInput = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        id: z
          .string()
          .min(1)
          .max(32)
          .regex(
            /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u,
            "Question id must be lowercase letters and digits starting with a letter, words joined by - _ or . (for example setup_interview).",
          )
          .describe(
            "Lowercase letters and digits, starting with a letter, words joined by - _ or . (at most 32).",
          ),
        header: z
          .string()
          .min(1)
          .max(12, "Question header must be at most 12 characters.")
          .regex(visible, "Question header must not be blank.")
          .describe("Short label above the question, at most 12 characters."),
        question: z
          .string()
          .min(1)
          .max(1_000)
          .regex(visible, "Question text must not be blank."),
        options: z
          .array(
            z.strictObject({
              label: z
                .string()
                .min(1)
                .max(60)
                .regex(visible, "Option label must not be blank."),
              description: z
                .string()
                .min(1)
                .max(300)
                .regex(visible, "Option description must not be blank."),
            }),
          )
          .min(2)
          .max(4)
          .refine(
            (options) =>
              new Set(options.map((option) => option.label)).size ===
              options.length,
            "Option labels must be unique within a question.",
          ),
        multiple: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(4)
    .refine(
      (questions) =>
        new Set(questions.map((question) => question.id)).size ===
        questions.length,
      "Question ids must be unique within a call.",
    ),
  mode: z.enum(["wait", "continue"]).default("wait"),
});
/** The ask tool's own input contract: strict objects, the id rule, the limits. */
export const questionAskInput = z.union([
  baseInput.extend({
    onExpire: z.strictObject({
      afterMinutes: z
        .number()
        .int()
        .min(5)
        .max(7 * 24 * 60),
      action: z.enum(["stop", "proceed_with_recommended"]),
    }),
  }),
  baseInput,
]);
