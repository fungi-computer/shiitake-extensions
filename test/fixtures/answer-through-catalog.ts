import { catalogCommands, parseCatalog } from "@fungi.computer/whistle/catalog";
import {
  createWhistle,
  type WhistleAnswerValue,
  type WhistleInteraction,
  type WhistlePrompt,
} from "@fungi.computer/whistle";
import { parsePromptAnswer } from "@fungi.computer/whistle/wire";
import { expect } from "vitest";
import type { questionHost } from "./ask.js";

/** Answer the waiting question through the advertised catalog, as a client does. */
export async function answerThroughCatalog(
  fixture: Awaited<ReturnType<typeof questionHost>>,
  scripted: WhistleAnswerValue[],
) {
  const session = fixture.host.session("questions");
  const runtime = createWhistle();
  const snapshot = await session.read();
  for (const [id, slot] of Object.entries(snapshot.extensions)) {
    if (slot.status !== "running" || slot.catalog === undefined) continue;
    runtime.contribute({
      sourceId: id,
      namespace: id,
      commands: catalogCommands(parseCatalog(slot.catalog), (command, args) =>
        session.extension(id).call(command, args),
      ),
    });
  }
  const prompts: WhistlePrompt[] = [];
  const notices: string[] = [];
  const interaction: WhistleInteraction = {
    run: (operation) => operation(),
    signal: new AbortController().signal,
    prompt: (prompt) => {
      prompts.push(prompt);
      const reply = scripted.shift();
      if (reply === undefined) throw new Error("Unexpected question prompt");
      return Promise.resolve(parsePromptAnswer(prompt, reply));
    },
    notify: (notice) => {
      if (notice.type !== "handoff") notices.push(notice.message);
    },
  };
  const outcome = await runtime.execute(
    { namespace: "botanical-session-question", id: "answerFlow" },
    { origin: "menu", interaction },
  );
  expect(outcome).toMatchObject({ status: "handled" });
  return { prompts, notices };
}
