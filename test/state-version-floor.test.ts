import { expect, it } from "vitest";
import { homeExtension, homeGrant } from "../src/home/host.js";
import { botanicalExtensionsWithSkills } from "../src/roster.js";
import installedVersions from "./fixtures/installed-state-versions.json" with { type: "json" };
import { openAgent, sqliteOwner } from "./fixtures/host.js";

// Deliberate identity retirement, not a version reset. The 2026-10-12
// Question rename leaves old Ask v1 rows orphaned. Packaged resume against the
// actual installed-store copy passed; old closed/receipt rows remain stored,
// while no old open asks or timers needed reactivation. See persisted-state.test.ts.
// Every retired identity must have a declared replacement with its inherited floor.
const retiredStateIds = [
  {
    id: "botanical-session-ask",
    replacement: "botanical-session-question",
    installedVersion: 1,
  },
];

it("never declares an extension state version below the last installed release", async () => {
  const base = botanicalExtensionsWithSkills({
    catalog: () => Promise.resolve({ skills: [], diagnostics: [] }),
    read: () => Promise.reject(new Error("No fixture skills")),
  });
  const store = sqliteOwner();
  const host = await openAgent(store.owner, {
    roster: [...base.roster, homeExtension({ computers: { read: () => [] } })],
    grants: [...base.grants, homeGrant],
  });
  try {
    const declared = new Map(
      store.owner.sql
        .exec(
          "SELECT extension_id, state_version FROM shiitake_extension_state",
        )
        .toArray()
        .map((row) => [row.extension_id, row.state_version]),
    );
    // Floors come from the installed store; Question inherits retired Ask v1.
    // Advance it when releasing higher versions; never reset it for cleanup.
    for (const [id, version] of Object.entries(installedVersions))
      expect(
        declared.get(id),
        `${id} must remain at least v${String(version)}`,
      ).toBeGreaterThanOrEqual(version);
    for (const retired of retiredStateIds) {
      expect(
        declared.has(retired.id),
        `${retired.id} is deliberately retired`,
      ).toBe(false);
      expect(
        declared.get(retired.replacement),
        `${retired.replacement} must inherit ${retired.id} v${String(retired.installedVersion)}`,
      ).toBeGreaterThanOrEqual(retired.installedVersion);
    }
  } finally {
    await host.close();
    store.close();
  }
});
