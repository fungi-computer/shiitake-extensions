import { z } from "zod";
import { questionIdPattern, questionLimits } from "./contract.js";

// Mycelium's maintained operation interface uses Zod. The owner additionally
// decodes Questions for shared domain refinements and durable state.
/** The ask tool's own input contract: one strict object, so an unknown key names its path. */
const visible = /\S/u;
export const questionAskInput = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        id: z
          .string()
          .min(1)
          .max(questionLimits.idMax)
          .regex(
            questionIdPattern,
            "Question id must be lowercase letters and digits starting with a letter, words joined by - _ or . (for example setup_interview).",
          )
          .describe(
            `Lowercase letters and digits, starting with a letter, words joined by - _ or . (at most ${String(questionLimits.idMax)}).`,
          ),
        header: z
          .string()
          .min(1)
          .max(
            questionLimits.headerMax,
            `Question header must be at most ${String(questionLimits.headerMax)} characters.`,
          )
          .regex(visible, "Question header must not be blank.")
          .describe(
            `Short label above the question, at most ${String(questionLimits.headerMax)} characters.`,
          ),
        question: z
          .string()
          .min(1)
          .max(questionLimits.questionMax)
          .regex(visible, "Question text must not be blank."),
        options: z
          .array(
            z.strictObject({
              label: z
                .string()
                .min(1)
                .max(questionLimits.labelMax)
                .regex(visible, "Option label must not be blank."),
              description: z
                .string()
                .min(1)
                .max(questionLimits.descriptionMax)
                .regex(visible, "Option description must not be blank."),
            }),
          )
          .min(questionLimits.optionsMin)
          .max(questionLimits.optionsMax)
          .refine(
            (options) =>
              new Set(options.map((option) => option.label)).size ===
              options.length,
            "Option labels must be unique within a question.",
          ),
        multiple: z.boolean().default(false),
      }),
    )
    .min(questionLimits.questionsMin)
    .max(questionLimits.questionsMax)
    .refine(
      (questions) =>
        new Set(questions.map((question) => question.id)).size ===
        questions.length,
      "Question ids must be unique within a call.",
    ),
  mode: z.enum(["wait", "continue"]).default("wait"),
  onExpire: z
    .strictObject({
      afterMinutes: z
        .number()
        .int()
        .min(5)
        .max(7 * 24 * 60),
      action: z.enum(["stop", "proceed_with_recommended"]),
    })
    .optional(),
});
