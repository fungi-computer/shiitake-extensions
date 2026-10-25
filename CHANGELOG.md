# @fungi.computer/shiitake-extensions

## 0.1.1

### Patch Changes

- Changes since 0.1.0:

  - fix(loop): default missing failure count on decode
  - fix(loop): preserve pause across failed ticks
  - fix(loop): keep retry diagnostics local
  - fix(loop): retry failed ticks with backoff
  - fix(shiitake-extensions): preserve tool capability errors

- Updated dependencies
- Updated dependencies
  - @fungi.computer/knapsack@0.2.1
  - @fungi.computer/shiitake@0.3.1
  - @fungi.computer/mycelium@0.2.1

## 0.1.0

### Minor Changes

- Changes since 0.0.2:

  - feat(stranger): typecheck each public entry in its own environment
  - fix(stranger): align the Oyster closure inventories and local dependencies
  - fix: cover Computer and Oyster packed dependency closures
  - fix(parakeet): retire unanswered advertised prompts with their intents
  - docs(packages): ship API pages and describe Workflow wire exports
  - docs(packages): generate catalog, Sigil and extension APIs
  - docs(packages): wire shared public API documentation gates
  - fix(core): clarify injected skill call shape
  - perf(core): compact shipped prompts and file tool schemas
  - feat(agents): scope send and recall to caller requests
  - fix(extensions): isolate required state resets from session runs
  - fix(goal): pin cleared events to committed session positions
  - fix(whistle): retry the failed interaction operation
  - refactor(files): split search tools and align hosted ignore visibility
  - refactor(mule): require typed retry contracts across model owners
  - test(extensions): use explicit Promise roster fixtures
  - refactor(extensions): own conversation Agent roster outside Oyster
  - fix(goal): type pause causes and restrict human attention
  - fix(subagents): start the conversation footer collapsed
  - feat(goal): expose paused attention without promoting the inbox
  - fix(goal): use neutral failure reasons and clarify app closure
  - fix(shiitake-extensions): delete agents toggle echoes at source
  - fix(spore): commit single choices without a second confirmation
  - chore(oyster): wip extraction pending host adapter corrections
  - fix(goal): any failed turn of a live goal pauses it
  - test(goal): a turn resumed after a restart may still complete the goal
  - fix(goal): a restart resumes the goal; a stopped turn always pauses it
  - fix(goal): say why a goal paused on its one footer line
  - fix(goal): only a live or paused goal is current
  - fix(subagents): footer and drawer rows no longer say who made the Agent
  - fix(subagents): token-shaped keys log as *; test a collapsed footer with a
    waiting child
  - feat(subagents): /agents collapses and expands the footer rows; failure log
    names its cause
  - feat(shiitake): run on pi-ai 1.3.0
  - feat(files): one find tool replaces list, glob and grep
  - feat(local): an Agent creating an Agent cannot give it more than it holds
  - feat(extensions): installed extensions can bring skills
  - fix(files): search real repos past .git and gitignored trees
  - feat(extensions): one-line idle prompts that point at forage.describe for
    the full rules
  - fix(skills): trim the model's skills prompt
  - fix(session): hide goal and loop prompts, summarize in footer, drop unused
    history
  - feat(session): show goal and loop automation in the footer, not the timeline
  - feat(oyster): public release 0.2.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/almanac@0.2.0
  - @fungi.computer/cairn@0.1.0
  - @fungi.computer/gills@0.2.0
  - @fungi.computer/knapsack@0.2.0
  - @fungi.computer/mycelium@0.2.0
  - @fungi.computer/shiitake@0.3.0
  - @fungi.computer/watchdog@0.1.0
  - @fungi.computer/whistle@0.1.0

## 0.0.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/almanac@0.1.0
  - @fungi.computer/gills@0.1.0
  - @fungi.computer/knapsack@0.1.0
  - @fungi.computer/mycelium@0.1.0
  - @fungi.computer/shiitake@0.2.0
  - @fungi.computer/whistle@0.0.2

## 0.0.1

### Patch Changes

- Initial public release of @fungi.computer/shiitake-extensions.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/almanac@0.0.1
  - @fungi.computer/knapsack@0.0.2
  - @fungi.computer/shiitake@0.1.0
  - @fungi.computer/mycelium@0.0.2
