import type { ExtensionRosterV0 } from "@fungi.computer/shiitake/extensions";

import { almanacContract } from "./almanac/contract.js";
import { almanacExtension } from "./almanac/host.js";
import { questionContract } from "./question/contract.js";
import { questionExtension } from "./question/host.js";
import { goalContract } from "./goal/contract.js";
import { goalExtension, goalExtensionFor } from "./goal/host.js";
import { loopContract } from "./loop/contract.js";
import { loopExtension } from "./loop/host.js";
import { planContract } from "./plan/contract.js";
import { planExtension } from "./plan/host.js";
import { skillsExtension, skillsGrant } from "./skills/host.js";
import type { SkillSource } from "./skills/source.js";
import {
  subagentsExtension,
  subagentsGrant,
  type SubagentSource,
} from "./subagents/host.js";

/**
 * Botanical's product roster with explicit grants. Hub and Local pass this
 * same value; a stranger host passes its own (or an empty) roster.
 */
export const botanicalAgentExtensions: ExtensionRosterV0 = Object.freeze({
  roster: Object.freeze([
    questionExtension,
    goalExtension,
    loopExtension,
    almanacExtension,
    planExtension,
  ]),
  grants: Object.freeze([
    {
      id: questionContract.id,
      capabilities: [
        "state",
        "settled",
        "send",
        "timers",
        "run_tools",
        "commands",
        "projection",
        "prompt",
        "attention",
      ],
    },
    {
      id: goalContract.id,
      capabilities: [
        "state",
        "settled",
        "send",
        "timers",
        "commands",
        "projection",
        "run_tools",
        "prompt",
        "attention",
      ],
    },
    {
      id: loopContract.id,
      capabilities: [
        "state",
        "settled",
        "send",
        "timers",
        "commands",
        "projection",
        "run_tools",
        "prompt",
      ],
    },
    {
      id: almanacContract.id,
      capabilities: ["state", "send", "timers", "commands"],
    },
    {
      id: planContract.id,
      capabilities: ["state", "run_tools", "projection", "prompt", "commands"],
    },
  ] as const),
});

/** Compose the goal and footer over one source; an absent goal is a wiring error. */
export function botanicalExtensionsWithSubagents(
  base: ExtensionRosterV0,
  source: SubagentSource,
): ExtensionRosterV0 {
  if (
    !base.roster.some((extension) => extension.manifest.id === goalContract.id)
  )
    throw new Error("Cannot attach sub-agents without the goal extension");
  return {
    roster: [
      ...base.roster.map((extension) =>
        extension.manifest.id === goalContract.id
          ? goalExtensionFor(source)
          : extension,
      ),
      subagentsExtension({ source }),
    ],
    grants: [...base.grants, subagentsGrant],
  };
}

/** A host with a SkillSource grants read-only skill discovery for its own runs. */
export function botanicalExtensionsWithSkills(
  source: SkillSource,
): ExtensionRosterV0 {
  return {
    roster: [...botanicalAgentExtensions.roster, skillsExtension({ source })],
    grants: [...botanicalAgentExtensions.grants, skillsGrant],
  };
}
