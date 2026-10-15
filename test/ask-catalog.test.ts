import { catalogCommands, parseCatalog } from "@fungi.computer/whistle/catalog";
import {
  createWhistle,
  type WhistlePrompt,
  type WhistleInteraction,
} from "@fungi.computer/whistle";
import { parsePromptAnswer } from "@fungi.computer/whistle/wire";
import { expect, it } from "vitest";
import { questionHost, questions } from "./fixtures/ask.js";

async function answerThroughCatalog(
  fixture: Awaited<ReturnType<typeof questionHost>>,
  scripted: string[],
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
  const command = runtime
    .snapshot()
    .slash.find(({ alias }) => alias === "answer");
  expect(command).toBeDefined();
  if (command === undefined) throw new Error("Missing /answer catalog command");
  const prompts: WhistlePrompt[] = [];
  const notices: string[] = [];
  const interaction: WhistleInteraction = {
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
  expect(
    await runtime.execute(command.commandId, {
      origin: "slash",
      interaction,
    }),
  ).toMatchObject({ status: "handled" });
  return { prompts, notices };
}

it("answers a parked question through the advertised /answer conversation", async () => {
  const fixture = await questionHost();
  const { host, store } = fixture;
  try {
    const session = host.session("questions");
    const answerAvailability = async () => {
      const snapshot = await session.read();
      const slot = snapshot.extensions["botanical-session-question"];
      if (slot?.status !== "running" || slot.catalog === undefined)
        throw new Error("Ask catalog is unavailable");
      return parseCatalog(slot.catalog).commands.find(
        ({ id }) => id === "answerFlow",
      )?.availability;
    };
    expect(await answerAvailability()).toMatchObject({ status: "unavailable" });
    const { askId } = await fixture.park();
    expect(await answerAvailability()).toEqual({ status: "available" });
    const { prompts, notices } = await answerThroughCatalog(fixture, [
      "option:SQLite",
      "Keep the notes local.",
    ]);
    expect(prompts).toMatchObject([
      {
        type: "choice",
        message: "Which store should hold the notes?",
        options: [
          { value: "option:SQLite", label: "SQLite" },
          { value: "option:PostgreSQL", label: "PostgreSQL" },
          { value: "free_text" },
        ],
      },
      { type: "text" },
    ]);
    expect(notices).toEqual(["Answer sent."]);
    const after = await session.read();
    expect(after.attention).toEqual([]);
    expect(await answerAvailability()).toMatchObject({ status: "unavailable" });
    expect(after.pending.prompts).toHaveLength(1);
    expect(after.pending.prompts[0]?.text).toContain("Keep the notes local.");
    expect(
      await session.extension("botanical-session-question").call("answer", {
        askId,
        requestId: "after-flow",
        answers: { storage: { selected: ["PostgreSQL"] } },
      }),
    ).toEqual({ result: "closed", status: "answered" });
  } finally {
    await host.close();
    store.close();
  }
});

it("collects quoted multiple selections and free text across every question", async () => {
  const fixture = await questionHost({
    mode: "continue",
    questions: [
      {
        id: "deliverables",
        header: "Deliverables",
        question: "Which deliverables should ship?",
        multiple: true,
        options: [
          { label: "Docs, examples", description: "Explain usage." },
          { label: "Tests", description: "Verify behavior." },
        ],
      },
      ...questions,
    ],
  });
  try {
    await fixture.park();
    const { prompts, notices } = await answerThroughCatalog(fixture, [
      '"Docs, examples",Tests',
      "Ship together.",
      "free_text",
      "Use a local file for now.",
    ]);
    expect(prompts.map((prompt) => prompt.type)).toEqual([
      "text",
      "text",
      "choice",
      "text",
    ]);
    expect(notices).toEqual(["Answer sent."]);
    const snapshot = await fixture.host.session("questions").read();
    expect(snapshot.attention).toEqual([]);
    expect(snapshot.pending.prompts).toHaveLength(1);
    const text = snapshot.pending.prompts[0]?.text;
    expect(text).toContain("Selected: Docs, examples, Tests");
    expect(text).toContain("Ship together.");
    expect(text).toContain("Use a local file for now.");
  } finally {
    await fixture.host.close();
    fixture.store.close();
  }
});

it.each(["SQLite,SQLite", "Unknown", '"SQLite', "SQLite\nPostgreSQL"])(
  "rejects invalid multi-selection %s without closing the question",
  async (selection) => {
    const fixture = await questionHost({
      mode: "continue",
      questions: questions.map((question) => ({ ...question, multiple: true })),
    });
    try {
      const { askId } = await fixture.park();
      const session = fixture.host.session("questions");
      const answer = session.extension("botanical-session-question");
      const draft = {
        askId,
        requestId: "retry-selection",
        index: 0,
        answers: {},
      };
      await expect(
        answer.call("answerFlow", { stage: "multiple", ...draft, selection }),
      ).rejects.toThrow("comma list");
      expect(
        (await session.read()).extensions["botanical-session-question"],
      ).toMatchObject({ status: "running", value: { asks: [{ askId }] } });
      await answer.call("answerFlow", {
        stage: "multiple",
        ...draft,
        selection: "SQLite",
      });
      await answer.call("answerFlow", {
        stage: "text",
        ...draft,
        selected: ["SQLite"],
        text: "",
      });
      const snapshot = await session.read();
      expect(snapshot.attention).toEqual([]);
      expect(snapshot.pending.prompts).toHaveLength(1);
    } finally {
      await fixture.host.close();
      fixture.store.close();
    }
  },
);
