# Shiitake product extensions

`@fungi.computer/shiitake-extensions` supplies Fungi's questions, goals, loops,
plans, Almanac schedules, skills and Home. Hub and Local choose the shared
roster and explicitly grant its capabilities. Shiitake core supplies the generic
extension API.

## Set up

This is a package for host and client maintainers. Use its exported subpaths
from the configured workspace, not an invented npm install. From the repository
root:

```sh
pnpm turbo:run run build --filter=@fungi.computer/shiitake-extensions
```

A host passes `botanicalAgentExtensions` as its Shiitake `extensions` option. It
still supplies the SQLite owner, runtime wake, model and instruction sources and
any tools sandbox. The roster does not supply provider credentials or resource
permissions.

A Local host uses `botanicalExtensionsWithSkills(source)` instead. The read-only
`SkillSource` owns discovery and file access. `skillsExtension({source})` uses
the `prompt`, `run_tools` and `commands` grants: metadata enters the prompt,
while `skill.load({name, file?})` returns the body or a supporting file through
the existing `execute` tool. It is a forage operation, not a top-level tool. The
human `/skills` command lists each discovered skill beside its `SKILL.md` path,
plus the reasons other entries were not loaded; choosing one shows its
description. Commands run inside a synchronous core transaction, so `/skills`
reads the latest discovery, taken at activation and before each model request.
Empty catalogs say that no skills are installed; invalid entries report a
redacted cause. Tool discovery summaries stay within Forage's metadata bounds
and mark shortened listings; the prompt still lists every admitted skill. The
Hub uses the shared roster without Skills and adds its own scoped Home
extension.

## Quick start: read the committed goal

Illustrative: this helper receives an already open Agent with the product roster
and reads the goal slot for one Session. A fresh Session has no goal value. The
helper requests neither model work nor a goal mutation.

```ts
import {
  bindSessionExtension,
  type ShiitakeAgent,
} from "@fungi.computer/shiitake/client";
import { goalContract } from "@fungi.computer/shiitake-extensions/goal";
import { botanicalAgentExtensions } from "@fungi.computer/shiitake-extensions/roster";

export const extensions = botanicalAgentExtensions;

export async function readGoal(agent: ShiitakeAgent) {
  const session = agent.session("example-session");
  const goal = bindSessionExtension(session, goalContract);
  return goal.view(await session.read());
}
```

The bound view distinguishes `unavailable`, `stopped` with a reason, and
`running` with a value or `null`. Existing [goal tests](test/goal.test.ts) bind
that same contract, read observed state, issue commands and close the owner. The
helper borrows the Agent. Its owner closes it when the host's lifetime ends.

## Core concepts

| Extension | Ownership and behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask       | Up to four open decisions per Session. The model asks or withdraws; humans answer or decline. A live waiter receives the answer, while a parked question resumes through one follow-up.                                                                                                                                                                                                                                                                                                                                          |
| Goal      | One live or paused objective per Session. The model creates, reads and completes it through `goal.*` tools, from any later turn of its Session; humans set, pause, resume or clear it. Esc, failed work, a block or three tool-less continuations pause it; a tool-less goal turn while a sub-agent command is live waits instead. Closing the app pauses it only if work stops without resuming; background work and runtime-auto-resumed turns keep it live. An achieved or cleared goal becomes one chat line in its history. |
| Loop      | One repeated prompt per Session. It runs on a fixed cron cadence or lets its own active run request the next occurrence. Commands start, pause, resume and stop it.                                                                                                                                                                                                                                                                                                                                                              |
| Plan      | One checklist per Session. `plan.update_plan` replaces it whole, with at most one step in progress and at most 50 steps; `steps: []` clears it. The human clears it with `/plan clear` or the footer row's Clear plan action, through the same owner. `/plan` opens the full checklist in the footer; updates keep only the current step and progress visible, and a finished or cleared plan leaves the footer while its history stays in state.                                                                                |
| Almanac   | Agent-scope one-shot or recurring schedules. Each schedule targets a Session and tracks admission, retry and its next due time.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Skills    | Host-supplied, read-only skill discovery. Metadata enters the prompt; `skill.load` reads a skill body or supporting file; `/skills` lists them.                                                                                                                                                                                                                                                                                                                                                                                  |
| Home      | Agent-scope choice of an attached Computer. Each run captures its scoped file tools and current attachment choice.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Subagents | A read-only footer view: one row per Agent this Session sent work to or created, with its live status (working, waiting on you, idle, failed, unavailable). A row opens that Agent's conversation, and `/agents` collapses the rows to one summary row and expands them again. It owns no relationship and no durable state.                                                                                                                                                                                                     |

An active Goal is quiet system context on every run. Continuation instructions
apply only to runs admitted by Goal with its continuation correlation; human
messages receive the Goal context without that directive. Both sections are
bounded by UTF-8 bytes. Goal turns stay out of the transcript; the footer shows
only a live goal ("Pursuing goal since 14:02") or a paused one ("Goal paused
(/goal resume)"), and each finished goal adds one chat line after its last work.
Other extensions keep their own display policy.

Known limitation: Session forks copy transcript entries without their original
command-admission rows. Inherited Goal turns therefore lose the extension-origin
metadata used for compact notes and appear as ordinary message bubbles.

Goal pause stops continuation, not already accepted work. Model-requested
completion or blocking is provisional until successful settlement; a blocked
goal pauses and resumes like any paused goal. Each run's goal tools are fenced
by the goal revision that run saw, so a later follow-up command (for example a
parent's message to a sub-agent) can complete, block, clear or resume a goal
that paused on its own; a goal a person paused or stopped accepts only
completion from the model, and only a person clears a live goal. When a
tool-less goal turn ends while a recorded sub-agent command is live, the goal
raises `goal-waiting` attention and rechecks on a timer instead of counting a
stall; it continues once the child settles or replies. Only a live or paused
goal asks before a replacement, which uses the observed revision to avoid
replacing a newer goal; the replaced goal is recorded as cleared. When a runtime
restart (a Hub deploy or eviction, a Local service restart) interrupts a goal
turn, the turn resumes and the goal stays live. A live goal pauses when any turn
of its Session fails, cannot resume or is stopped by a person (Esc), including
the person's own messages ("The last turn failed"). A missing extension origin
does not establish a human sender; mail and host admissions can also lack one.

Goal's shared wire and durable row use `pauseCause: { kind, detail }` while
paused and `null` while active. The closed kinds are `person`, `blocked`,
`stalled`, `cancelled`, `failed`, and `no-terminal`; display detail is nullable
text, never a discriminator. Only blocked/stalled goals emit `goal-blocked` or
`goal-stalled` attention, kept out of the main inbox with `inbox: false`.
Questions and these two Goal kinds ask for a person in Herdr activity;
person-paused, cancelled and failed goals do not. State version 6 discards
disposable preview Goal rows from versions 4 and 5 rather than reading the
superseded representation.

Loop tools are offered in every run. `loop.get`, `loop.start` and `loop.stop`
work from any run of the Session, and the model may start a loop itself.
`loop.schedule_next` is accepted only in the active self-paced loop's own run;
omitting it ends that loop. A fixed cadence uses the core timer and expires
seven days after it starts. Almanac retries a failed admission per schedule, so
one refused occurrence does not become another schedule's failure. Use the
recorded error and the owner's resume command when recovering.

The human `/goal`, `/loop` and `/plan` flows are advertised as
`whistle.catalog/v1` catalogs. A compatible client renders the same server-owned
interactions. A human command catalog, a per-run tool module and model tool
discovery are separate contracts. Inspect the host's exposed tool catalog before
relying on a model-facing operation.

## State and lifetime

### Question

`question.ask` creates one to four decision questions. Its namespace is
`question`, and its extension identity is `botanical-session-question`. Inspect
`forage.describe({path: "question.ask"}).inputSchema` for the validated bounds,
including the 12-character question header. A waiting call receives the human's
answer in-turn; `mode: "continue"` parks it and returns its `askId`. The live
wait leaves sixty seconds of the actual execute deadline and is capped at ten
minutes. Pending steering also parks the question so Mule can deliver the steer.
Each Session holds at most four open Asks, with one live Ask per run.

Bind `questionContract` from `/question` with `bindSessionExtension` to read its
decoded projection and call `list`, `answer` or `decline`. Human responses
include an `askId` and a stable `requestId`. Reuse that request identity after
an uncertain response: an exact retry returns its original receipt, while a
changed payload conflicts. Answer every question with offered labels or nonempty
free text. The model has no answer operation.

The `/answer` catalog conversation selects a waiting Ask and collects an answer
for each question. Multiple selections use comma-separated labels; quote a label
that contains a comma. Every choice also permits free text.

Optional `onExpire` specifies `afterMinutes` (5 through 10,080) and an action:
`stop` explicitly tells the model not to proceed; `proceed_with_recommended`
selects the first option of each question. A parked answer or expiry admits one
self-contained follow-up. The Ask owner clears attention when it closes, and the
live waiter and durable timer share the same expiry transition. Restart recovery
reconciles committed answers before allowing another delivery. An in-turn answer
retains its delivery receipt until Mule saves a successful tool outcome. If a
crash loses that outcome and no re-ask receives it, settlement sends the answer
once as a follow-up. A cancelled run suppresses that redelivery.

Client cards, goal/loop attention policy and external notifications are separate
contributions; the Ask owner alone does not provide those surfaces.

### Owner transactions

Collections are namespaced to the extension. Schema, version, migrations and
configuration contribute to its revision. Settled hooks, timer hooks and command
handlers commit through core transactions. They must finish synchronously and
must not perform external I/O.

Extensions send prompts through the accepted-command door and wake through core
timers. An accepted prompt is queued work, not a finished model reply. Core owns
replay cursors and publication after commit. A stopped extension exposes its
reason; the host can resume it without inventing a separate background loop.

## API reference and examples

This package documents contracts beside source and has no generated API command.
[package.json](package.json) owns these exported subpaths:

| Entry                                          | Source                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/goal`, `/goal/host`                          | [Goal contract](src/goal/contract.ts) and [definition](src/goal/host.ts).                                 |
| `/loop`, `/loop/host`                          | [Loop contract](src/loop/contract.ts) and [definition](src/loop/host.ts).                                 |
| `/almanac`, `/almanac/host`                    | [Schedule contract](src/almanac/contract.ts) and [definition](src/almanac/host.ts).                       |
| `/home`, `/home/host`                          | [Home contract](src/home/contract.ts) and [definition](src/home/host.ts).                                 |
| `/question`, `/question/host`                  | [Question contract](src/question/contract.ts) and [definition](src/question/host.ts).                     |
| `/plan`, `/plan/host`                          | [Plan contract](src/plan/contract.ts) and [definition](src/plan/host.ts).                                 |
| `/skills`, `/skills/source`                    | [Skills definition](src/skills/host.ts) and [host-owned source](src/skills/source.ts).                    |
| `/subagents`, `/subagents/host`                | [Subagents contract](src/subagents/contract.ts) and [definition](src/subagents/host.ts).                  |
| `/subagents/client`                            | [Subagents client entry](src/subagents/client.ts).                                                        |
| `/goal/client`, `/loop/client`, `/plan/client` | Client entries for [Goal](src/goal/client.ts), [Loop](src/loop/client.ts) and [Plan](src/plan/client.ts). |
| `/roster`                                      | [Product roster and grants](src/roster.ts).                                                               |

[Loop tests](test/loop.test.ts) exercise scheduling and mid-run pause.
[Almanac tests](test/almanac.test.ts) exercise admission and retry.
[Catalog tests](test/catalog.test.ts) check the human interaction contracts.
These fixtures use the actual extension definitions on Shiitake with fake
models.

## Home

The host creates `homeExtension({ computers })`, where `computers.read()`
synchronously returns the current attachments as `{ name, attachmentId, port }`.
Each `port` is already scoped to that attachment by the host. Home never creates
credentials or bypasses the host gate. Add the returned extension and its
exported `homeGrant` (`state`, `files`, `prompt`, `projection`, `commands`).
Home is composed by the host, not included in `botanicalAgentExtensions`. The
Hub and demo add it with their own Computer ports and grants.

Home records one Agent-scope attachment choice. With no recorded choice, a run
adopts a sole attachment once. Zero or multiple attachments require a person to
choose `/home <name>`. Removing the chosen attachment keeps the choice and
offers no direct file tools until a person chooses again. Reordering attachments
never changes Home. The Session command changes Agent state, so other Sessions
see that choice on their next run.

Each run captures its table, Home and prompt once. The tools are Knapsack's
branded `read`, `list`, `glob`, and `grep`, with `apply_patch` only when Home's
port has a native patch engine. Bare paths and `computer://home/` use Home;
`computer://<name>/` uses another captured attachment. Patches always use Home's
native engine and path jail. Returned file identity stays owned by the scoped
port. There is no Home model tool and no shared Files module.

The Agent-scope `seed` command is an unadvertised host migration operation. It
records an old attachment id only when no choice exists, including when that
attachment is detached; subsequent seed calls cannot overwrite a human choice.
Hosts keep the control door human/operator-authorized.
[Home tests](test/home.test.ts) exercise selection, capture, detachment, routing
and gating on real Shiitake.

## Limits and errors

A roster entry is not an external-resource grant. The host still admits each
operation and owns its current Team, Computer and credential policy. A command
conflict requires a fresh observation; retry an uncertain request with the same
identity. A view with no goal is not evidence that a previous goal completed.
Closing a client view does not pause the goal, stop a loop or cancel a schedule.

## Contribute and license

Add regressions beside the owning extension or catalog. From the root:

```sh
pnpm --dir packages/shiitake-extensions run test
pnpm --dir packages/shiitake-extensions run typecheck
```

MIT. See [LICENSE](LICENSE).

## TypeScript consumer dependencies

Install `@modelcontextprotocol/sdk@1.25.2` alongside this package when compiling
its complete public declarations. The shared provider SDK imports those types
through an optional peer; the packed consumer supplies it explicitly. This does
not require a provider account or make a provider call.

## Subagents

The host creates `subagentsExtension({ source })` and adds `subagentsGrant`
(`projection` and `commands`: the human `/agents` command only collapses or
expands the footer rows, per Session and in memory).
`source.read(sessionId, limit)` returns the Agents that Session sent work to or
created, newest first, with a count of the rest; `source.open` is the host's
existing Agent access. Each child's status is its owner's own Session state:
`running` is working, any open attention (a question or a tool approval) is
waiting on you, `done` is idle and `errored` is failed. A child whose state
cannot be read is unavailable, never idle.

Rows refresh when a watcher reads the parent Session and they are at least a
second old. While a row is working or waiting, they poll every five seconds
until nobody has read the parent for thirty seconds. Like Home, the extension is
composed by the host, not included in `botanicalAgentExtensions`.

## Packed consumer readiness

Run `pnpm run build`, `pnpm run pack` and `pnpm run stranger` in this package.
The maintained stranger proof installs only package tarballs into a fresh npm
consumer, checks the exact shipped files, runs the public runtime fixture and
compiles every JavaScript entrypoint with strict NodeNext and no library-check
skip. This qualification does not publish npm releases or push a repository
split.

See [LICENSE](LICENSE) for the license and the package manifest for its public
repository destination.

## Conversation Agent composition

`@fungi.computer/shiitake-extensions/roster/conversation-agents` supplies the
shared Local, Hub and Oyster conversation-Agent composition. The host supplies
its authorized Agent directory and SQLite owner; the roster records accepted
creates and sends for a read-only footer without granting relationships or
authority. Storage is prepared lazily. The host remains responsible for creation
admission, Agent access and resource lifetime.
