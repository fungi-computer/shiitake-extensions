import { parseCatalog } from "@fungi.computer/whistle/catalog";
import { expect, it } from "vitest";
import { questionHost, questions } from "./fixtures/ask.js";
import { answerThroughCatalog } from "./fixtures/answer-through-catalog.js";

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
      { selected: ["SQLite"] },
    ]);
    expect(prompts).toMatchObject([
      {
        type: "decision",
        message: "Which store should hold the notes?",
        options: [
          { value: "SQLite", label: "SQLite" },
          { value: "PostgreSQL", label: "PostgreSQL" },
        ],
        other: { label: "Other…" },
      },
    ]);
    expect(notices).toEqual(["Answer sent."]);
    const after = await session.read();
    expect(after.attention).toEqual([]);
    expect(await answerAvailability()).toMatchObject({ status: "unavailable" });
    expect(after.pending.prompts).toHaveLength(1);
    expect(after.pending.prompts[0]?.text).toContain("Selected: SQLite");
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

it("collects a multiple pick and a written answer across every question", async () => {
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
      { selected: ["Docs, examples", "Tests"], text: "Ship together." },
      { selected: [], text: "Use a local file for now." },
    ]);
    expect(prompts.map((prompt) => prompt.type)).toEqual([
      "decision",
      "decision",
    ]);
    // The options are rows with their own descriptions, never pasted into the title.
    expect(prompts[0]).toEqual({
      type: "decision",
      message: "Which deliverables should ship?",
      summary: "Question 1 of 2",
      options: [
        {
          value: "Docs, examples",
          label: "Docs, examples",
          description: "Explain usage.",
        },
        { value: "Tests", label: "Tests", description: "Verify behavior." },
      ],
      multiple: true,
      other: {
        label: "Other…",
        placeholder: "Write your own answer",
        maxLength: 4_000,
      },
    });
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

it("advances earlier single choices and submits the last question immediately", async () => {
  const fixture = await questionHost({
    mode: "continue",
    questions: [
      ...questions,
      {
        id: "scope",
        header: "Scope",
        question: "Which scope?",
        options: [
          { label: "Local", description: "This computer." },
          { label: "Team", description: "Everyone." },
        ],
      },
    ],
  });
  try {
    await fixture.park();
    const { prompts, notices } = await answerThroughCatalog(fixture, [
      { selected: ["SQLite"] },
      { selected: ["Local"] },
    ]);
    expect(prompts.map((prompt) => prompt.message)).toEqual([
      "Which store should hold the notes?",
      "Which scope?",
    ]);
    expect(prompts.map((prompt) => prompt.type)).toEqual([
      "decision",
      "decision",
    ]);
    expect(notices).toEqual(["Answer sent."]);
    const snapshot = await fixture.host.session("questions").read();
    expect(snapshot.attention).toEqual([]);
    expect(snapshot.pending.prompts).toHaveLength(1);
    expect(snapshot.pending.prompts[0]?.text).toContain("Selected: SQLite");
    expect(snapshot.pending.prompts[0]?.text).toContain("Selected: Local");
  } finally {
    await fixture.host.close();
    fixture.store.close();
  }
});

it.each([
  { multiple: true, answer: { selected: ["SQLite", "SQLite"] } },
  { multiple: true, answer: { selected: ["Unknown"] } },
  { multiple: true, answer: { selected: [] } },
  { multiple: false, answer: { selected: ["SQLite", "PostgreSQL"] } },
])(
  "rejects the invalid decision answer $answer without closing the question",
  async ({ multiple, answer: invalid }) => {
    const fixture = await questionHost({
      mode: "continue",
      questions: questions.map((question) => ({ ...question, multiple })),
    });
    try {
      const { askId } = await fixture.park();
      const session = fixture.host.session("questions");
      const answer = session.extension("botanical-session-question");
      const draft = {
        stage: "decision" as const,
        askId,
        requestId: "retry-selection",
        index: 0,
        answers: {},
      };
      await expect(
        answer.call("answerFlow", { ...draft, answer: invalid }),
      ).rejects.toThrow("Choose offered options");
      expect(
        (await session.read()).extensions["botanical-session-question"],
      ).toMatchObject({ status: "running", value: { asks: [{ askId }] } });
      await answer.call("answerFlow", {
        ...draft,
        answer: { selected: ["SQLite"] },
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

it("a long Agent question gets a plain title and sits in the body", async () => {
  const long = `Which of these storage engines should hold the notes, given that they must survive a restart and be searchable? ${"Think about it. ".repeat(20)}`;
  const fixture = await questionHost({
    mode: "continue",
    questions: [
      {
        id: "storage",
        header: "Storage",
        question: long,
        options: [
          { label: "SQLite", description: "One file." },
          { label: "PostgreSQL", description: "A server." },
        ],
      },
    ],
  });
  try {
    await fixture.park();
    const { prompts } = await answerThroughCatalog(fixture, [
      { selected: ["SQLite"] },
    ]);
    expect(prompts[0]).toMatchObject({
      type: "decision",
      message: "The Agent has a question",
      bodyLabel: "Question",
      body: long,
      details: [{ label: "Question", value: long }],
    });
  } finally {
    await fixture.host.close();
    fixture.store.close();
  }
});
