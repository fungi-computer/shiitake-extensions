import type { ExtensionRosterV0 } from "@fungi.computer/shiitake/extensions";

import { almanacContract } from "./almanac/contract.js";
import { almanacExtension } from "./almanac/host.js";
import { questionContract } from "./question/contract.js";
import { localQuestionExtension, questionExtension } from "./question/host.js";
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
 * Botanical's shared roster with explicit grants. Local composes its
 * sender-routing question extension through `botanicalExtensionsWithSkills`;
 * hosts without that Local capability send every Ask to a person.
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
  const local = botanicalExtensionsWithSenderRouting();
  return {
    roster: [...local.roster, skillsExtension({ source })],
    grants: [...local.grants, skillsGrant],
  };
}

/** Route Asks to the Agent that sent the work, only in a host that owns the Local answer door. */
export function botanicalExtensionsWithSenderRouting(): ExtensionRosterV0 {
  return {
    ...botanicalAgentExtensions,
    roster: botanicalAgentExtensions.roster.map((extension) =>
      extension.manifest.id === questionContract.id
        ? localQuestionExtension
        : extension,
    ),
  };
}
