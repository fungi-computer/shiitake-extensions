import { parsePromptAnswer } from "@fungi.computer/whistle/wire";
import { catalogCommands, parseCatalog } from "@fungi.computer/whistle/catalog";
import {
  createWhistle,
  type WhistleInteraction,
  type WhistlePrompt,
} from "@fungi.computer/whistle";
import { expect, it } from "vitest";

import loopClient from "../src/loop/client.js";
import { botanicalAgentExtensions } from "../src/roster.js";
import { openAgent, sqliteOwner } from "./fixtures/host.js";

/** A client that knows no extension: it reads each slot's advertised catalog. */
async function openAdvertisedClient() {
  const store = sqliteOwner();
  const host = await openAgent(store.owner, botanicalAgentExtensions);
  const session = host.session("garden");
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
  return {
    runtime,
    session,
    dispose: async () => {
      await host.close();
      store.close();
    },
  };
}

function answering(answers: (string | boolean)[]) {
  const asked: WhistlePrompt[] = [];
  const notices: string[] = [];
  const interaction: WhistleInteraction = {
    run: (operation) => operation(),
    signal: new AbortController().signal,
    prompt: (prompt) => {
      asked.push(prompt);
      const answer = answers.shift();
      if (answer === undefined)
        throw new Error("Missing scripted prompt answer");
      return Promise.resolve(parsePromptAnswer(prompt, answer));
    },
    notify: (notice) => {
      notices.push(notice.type === "handoff" ? notice.url : notice.message);
    },
  };
  return { interaction, asked, notices };
}

it("advertises /goal and /loop from the backend, with their argument grammar", async () => {
  const client = await openAdvertisedClient();
  try {
    const slash = client.runtime.snapshot().slash;
    expect(slash.map((row) => [row.alias, row.commandId])).toEqual([
      ["goal", "botanical-session-goal:goal"],
      ["loop", "botanical-session-loop:loop"],
      ["plan", "botanical-session-plan:plan"],
    ]);
    expect(slash.find((row) => row.alias === "goal")?.arguments?.hint).toBe(
      "<objective>",
    );
    expect(
      slash
        .find((row) => row.alias === "loop")
        ?.arguments?.words?.map(({ word }) => word),
    ).toEqual(["status", "pause", "resume", "stop"]);
  } finally {
    await client.dispose();
  }
});

it("runs the /goal conversation on the server: ask, set, confirm a replacement", async () => {
  const client = await openAdvertisedClient();
  try {
    const first = answering(["Ship the fern"]);
    await expect(
      client.runtime.execute(
        { namespace: "botanical-session-goal", id: "goal" },
        {
          origin: "slash",
          interaction: first.interaction,
        },
      ),
    ).resolves.toMatchObject({ status: "handled" });
    expect(first.asked[0]).toMatchObject({ type: "text" });
    expect(first.notices).toEqual([]);

    const declined = answering([false]);
    await client.runtime.execute(
      { namespace: "botanical-session-goal", id: "goal" },
      {
        origin: "slash",
        arguments: { action: "set", objective: "Plant moss", requestId: "r2" },
        interaction: declined.interaction,
      },
    );
    expect(declined.asked[0]).toMatchObject({
      type: "confirmation",
      confirmLabel: "Replace and start",
    });
    expect(declined.notices).toEqual(["Kept the current goal."]);

    const replaced = answering([true]);
    await client.runtime.execute(
      { namespace: "botanical-session-goal", id: "goal" },
      {
        origin: "slash",
        arguments: { action: "set", objective: "Plant moss", requestId: "r3" },
        interaction: replaced.interaction,
      },
    );
    expect(replaced.notices).toEqual([]);

    const controls = answering(["pause"]);
    await client.runtime.execute(
      { namespace: "botanical-session-goal", id: "goal" },
      {
        origin: "slash",
        interaction: controls.interaction,
      },
    );
    expect(controls.asked[0]).toMatchObject({
      type: "choice",
      message: "Working on: Plant moss",
      options: [
        { value: "pause", label: "Pause goal" },
        { value: "replace", label: "Replace goal…" },
        { value: "clear-ask", label: "Clear goal…", destructive: true },
      ],
    });
    expect(controls.notices).toEqual([]);
  } finally {
    await client.dispose();
  }
});

it("starts and controls /loop through typed text and words", async () => {
  const client = await openAdvertisedClient();
  try {
    const invalid = await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "slash",
        arguments: { action: "start", text: "90m check", requestId: "l0" },
        interaction: answering([]).interaction,
      },
    );
    expect(invalid).toMatchObject({ status: "failed" });

    const started = answering([]);
    await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "slash",
        arguments: { action: "start", text: "5m check CI", requestId: "l1" },
        interaction: started.interaction,
      },
    );
    expect(started.notices).toEqual(["Loop active (fixed interval): check CI"]);
    const paused = answering([]);
    await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "slash",
        arguments: { action: "pause" },
        interaction: paused.interaction,
      },
    );
    expect(paused.notices).toEqual(["Loop paused (fixed interval): check CI"]);
    await expect(
      client.runtime.execute(
        { namespace: "botanical-session-loop", id: "loop" },
        {
          origin: "agent",
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "interaction_required" },
    });
  } finally {
    await client.dispose();
  }
});

it("the footer's stop loop asks first, and Keep leaves the loop running", async () => {
  const client = await openAdvertisedClient();
  try {
    await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "slash",
        arguments: { action: "start", text: "5m check CI", requestId: "f1" },
        interaction: answering([]).interaction,
      },
    );
    // The very action the loop's client advertises as its footer stop.
    const slot = (await client.session.read()).extensions[
      "botanical-session-loop"
    ];
    if (slot?.status !== "running" || loopClient.contribute === undefined)
      throw new Error("The loop slot is not running");
    const advertised = loopClient.contribute(slot).waiting?.cancel;
    if (advertised === undefined)
      throw new Error("A scheduled loop advertises no footer stop");
    expect(advertised.label).toBe("stop loop");

    const kept = answering([false]);
    await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "menu",
        arguments: advertised.input,
        interaction: kept.interaction,
      },
    );
    expect(kept.asked).toMatchObject([
      {
        type: "confirmation",
        message: "Stop this loop?",
        cancelLabel: "Keep loop",
        confirmLabel: "Stop loop",
        destructive: true,
      },
    ]);
    expect(kept.notices).toEqual(["Kept the loop."]);
    const status = answering([]);
    await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "slash",
        arguments: { action: "status" },
        interaction: status.interaction,
      },
    );
    expect(status.notices[0]).toMatch(/^Loop active/u);
  } finally {
    await client.dispose();
  }
});

it("/loop stops only after a safe-first confirmation", async () => {
  const client = await openAdvertisedClient();
  try {
    const prompt = `Check CI and fix what broke. ${"Then wait and look again. ".repeat(6)}`;
    await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "slash",
        arguments: { action: "start", text: prompt, requestId: "s1" },
        interaction: answering([]).interaction,
      },
    );

    // The menu's Stop only asks; the loop keeps running until the answer is yes.
    const kept = answering(["stop-ask", false]);
    await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "slash",
        interaction: kept.interaction,
      },
    );
    expect(kept.asked[0]).toMatchObject({
      type: "choice",
      message: "Loop running: Check CI and fix what broke",
      summary: "The Agent decides when to run it again.",
      options: [
        { value: "pause", label: "Pause loop" },
        { value: "stop-ask", label: "Stop loop…", destructive: true },
      ],
    });
    expect(kept.asked[1]).toMatchObject({
      type: "confirmation",
      message: "Stop this loop?",
      cancelLabel: "Keep loop",
      confirmLabel: "Stop loop",
      destructive: true,
    });
    expect(kept.notices).toEqual(["Kept the loop."]);

    const stopped = answering(["stop-ask", true]);
    await client.runtime.execute(
      { namespace: "botanical-session-loop", id: "loop" },
      {
        origin: "slash",
        interaction: stopped.interaction,
      },
    );
    expect(stopped.notices).toHaveLength(1);
    expect(stopped.notices[0]).toMatch(/^Loop cancelled/u);
  } finally {
    await client.dispose();
  }
});
