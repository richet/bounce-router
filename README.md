# bounce-router

[![npm version](https://img.shields.io/npm/v/bouncerouter?logo=npm&color=cb3837)](https://www.npmjs.com/package/bouncerouter)
[![npm downloads](https://img.shields.io/npm/dm/bouncerouter?logo=npm)](https://www.npmjs.com/package/bouncerouter)
[![Node.js 22+](https://img.shields.io/node/v/bouncerouter?logo=node.js&color=339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/github/license/richet/bounce-router?color=blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/richet/bounce-router?style=flat&logo=github)](https://github.com/richet/bounce-router/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/richet/bounce-router?logo=github)](https://github.com/richet/bounce-router/commits/main)

bounce-router is one TUI for your installed Claude Code, Codex, and Muse coding agents, run with the `bounce` command. Uses native CLI login and headless processes; bounce owns the conversation and carries context between providers. When one provider's subscription usage is exhausted, it automatically fails over to the next signed-in provider.

Since 0.2, bounce also has an **orchestrator** operation mode: the main agent coordinates and delegates implementation to worker profiles — Claude, Codex, Muse, or local LM Studio models running inside Docker containers — over a per-session bus, with an AGENTS pane, a task board, reviews and budgets. Sessions have names, can run detached in the background, and can be reattached from any terminal. See [Orchestrator mode](#orchestrator-mode), [Local workers](#local-workers) and [Sessions](#sessions).

### Auto usage fail over while maintaining context
<img width="256" height="404" alt="bounce-usage-1" src="https://github.com/user-attachments/assets/c9dbf7bb-e6f3-4e1a-b6c5-abd18bb473a5" />

### Model selection across all providers
<img width="910" height="426" alt="bounce-model-selection" src="https://github.com/user-attachments/assets/8749e47d-89b3-4bb4-834f-a972eff8923a" />


## Install

Requires Node.js 22+.

```sh
npm install -g bouncerouter
bounce
```

Then inside bounce, connect your agents:

### Provider sign-in

```
/login claude
/login codex
/login muse
```

If Claude, Codex, or Muse are already signed in on this machine, there is
nothing to do — bounce reuses those logins and you can skip `/login`.

If a provider CLI is missing, `/login` (or `bounce login`) shows a browser link
to its installation instructions. Install it, then retry the login command.

### Model selection

Switch models on your signed-in agents with `/model`.

### Skills

Bring an agent's existing skills into bounce with `/skills import` (tick the
ones you want). Bounce keeps imported skills in sync across all providers,
so a skill works whichever agent answers the turn.

## Run

Requires Node.js 22+ and at least one provider CLI on PATH. Run `npm install` in this project before the first launch.

```sh
node src/cli.js --cwd /path/to/your/repo
```

Run that from this project's directory, or use `npm start`. Optional: `npm link` exposes `bounce` on PATH, so `bounce` works from anywhere.

```sh
bounce login claude
bounce login codex
bounce login muse
bounce doctor
bounce models
bounce quota
bounce skills
bounce --cwd /path/to/repo
bounce run "Implement the feature and run relevant tests" --cwd /path/to/repo
bounce run "Refactor the parser" --detach   # keep working in the background
bounce sessions                              # ● marks a live session
bounce attach SESSION                        # reopen its view; --json streams the journal
bounce stop SESSION                          # cancel its task tree and end its daemon
bounce rename SESSION NAME
bounce --resume SESSION                      # a name, an id, or a unique id prefix
bounce local models                          # what LM Studio has loaded
bounce local setup                           # guided local worker configuration
bounce task compare SESSION A B              # tokens, wall time and rounds of two tasks
```

Login temporarily hands the terminal to the vendor. Finish its browser/device login, then return to the TUI. Existing CLI logins work without logging in again. bounce never reads or exchanges credentials. Native CLI environment variables and settings still apply; if you have vendor API keys set, the vendor may prefer them over subscription login.

## Updates

Global npm installations check for a newer stable release in the background on
interactive startup. Successful checks are cached for 24 hours; network failures
are silent. Set `BOUNCE_NO_UPDATE_CHECK=1` to disable startup checks.

```sh
bounce update --check
bounce update
```

Inside bounce, use `/update check` to check now, or `/update` to install. Updates
are explicit: bounce never automatically installs a release. `/update` exits the
idle UI before installing, then starts a fresh process with the same session,
provider and settings. Installation errors are reported on resume; if npm leaves
an incomplete installation, repair it with `npm install -g bouncerouter@latest`
and resume with `bounce --resume SESSION_ID`.

Self-update requires a global npm installation matching the npm on PATH and uses
that npm's global prefix. Linked development checkouts and local installations
are skipped. No elevated permissions are requested. `/restart` remains the
separate development validation/reload command.

## Display

Assistant responses render Markdown headings, emphasis, lists, quotes, links, tables, and syntax-highlighted fenced code blocks. Unlabelled code blocks and literal tool output use automatic language detection. While a turn is pending, a spinner and elapsed seconds remain visible, including during silent provider work; F2 pauses animation for copying. Event labels, status, and command selection use distinct colors. Layout wraps by terminal cell width and preserves ANSI styles. Set `NO_COLOR=1` to disable colors; `TERM=dumb` also disables styling. Journals and headless `run`/`--json` output retain their original format.

The transcript is laid out the way Claude Code lays out its own: your prompt as a `>` line, each answer as a `●` block whose text hangs two columns in, each tool call as `● Name(what it was for)` followed by a `⎿` block showing the first three lines of its output — inner indentation intact, long lines clipped — and `… +N lines` for the rest, with a blank row between blocks. Lists use `-` and `1.` markers and a wrapped item continues under its own text rather than snapping back to the margin; fenced code is indented and highlighted with no header. Claude's final result, which repeats the last answer, and Codex's bare `Turn completed` are not shown twice.

Live progress — Claude's thinking-token counters, tool heartbeats and the start and end of each foreground Bash call, Codex's command starts — is never written to the journal, and a run of readings for the same thing (`Thinking · ~50 tokens`, `~150`, `~265`…) is one transcript line showing the latest, so a long turn no longer buries the conversation in repeated `thinking_tokens` rows. Short bookkeeping events (agent selected, activity, cooldown, agent finished, turn finished) render as a single line. `/details` shows everything: every tool call field by field with real newlines rather than as escaped JSON, full tool output, and worker dispatch (`/details on|off` sets it explicitly); the journal keeps the original text for handoffs.

The header labels the selected model and updates when the provider reports its model. If neither a model override nor runtime metadata is available, it shows `Default (not reported)`; use `/model ID` to select one explicitly. Bounce activity labels describe local progress. Restart validation shows concise success messages and retains diagnostic output on failure.

## Image attachments

Drop image files into the terminal input, add your question, and press Enter. Quoted paths, shell-escaped spaces, and local `file://` URLs are supported. PNG, JPEG, GIF and WebP are accepted (up to 10 files, 5 MiB each). Paths stay visible and editable until submission. Clipboard bitmap paste is not implemented; save the screenshot as a file and drag it in.

Claude receives base64 image blocks through stream-JSON input; Codex and Muse receive repeated `--image` flags. A vision-capable provider model is required. Images are copied into the private session directory before sending, so fallback uses the same bytes even if the original is moved. Journals store attachment metadata and saved paths, not base64. Later turns include those saved paths in history; images are automatically attached only to their original turn and its fallback attempts.

Headless usage: `bounce run "Explain this screenshot" --image "/path/Screen shot.png"` (repeat `--image` for more files). Standalone local image paths in prompt text are also detected as attachments. Missing explicit image paths or invalid files stop submission with an error.

## Controls

- Type `/` to open the command picker; type a prefix to filter. Up/down selects and Tab completes. Enter completes a half-typed command and runs one you typed out in full, so `/skills` lists your skills on the first press. Esc dismisses the picker.
- Tab switches agent when the picker is closed.
- Enter sends; Shift+Enter inserts a newline. A terminal sends a bare `\r` for Shift+Enter — indistinguishable from Enter — until an application asks it not to, so bounce turns on the kitty keyboard protocol and xterm's modifyOtherKeys while the TUI is up, and turns them off again whenever it hands the terminal back. That covers iTerm2 3.5+, Ghostty, kitty, WezTerm and xterm with no configuration. In a terminal that supports neither (Apple Terminal, older iTerm2), map the key yourself — in iTerm2, Settings → Profiles → Keys → Key Mappings → `+`, press ⇧↩, choose *Send Escape Sequence* and enter `[13;2u` — or use Alt+Enter or Ctrl+J, which insert a newline everywhere with no configuration. Ctrl+Enter and Cmd+Enter work too. Modified Enter is accepted in every encoding terminals use for it: CSI u (`\x1b[13;2u` is Shift+Enter), xterm's modifyOtherKeys (`\x1b[27;2;13~`), and Alt's ESC prefix. Requesting those reports also re-encodes other modified keys — Ctrl+C arrives as `\x1b[99;5u` — so the same decoder turns each one back into the key event the prompt expects.
- F2 freezes display updates for selecting/copying text while an agent runs; F2 resumes. Events continue to be saved while paused, and keys other than Ctrl+C are ignored until you resume.
- Ctrl+O toggles between the classic and orchestrator operation modes; `/operation` opens the same choice as a menu. See [Orchestrator mode](#orchestrator-mode).
- `/provider claude` selects and saves the default.
- `/model` lists every model each signed-in agent reports and lets you pick one: up/down or 1-9 to choose, Enter to use it, Esc to cancel. A pick saves the model and makes that agent the default. `/model refresh` re-asks the agents; catalogs are cached for five minutes.
- `/model MODEL_ID` saves the selected provider's model without opening the picker; `/model default` uses its native default.
- Catalogs come from each CLI's own protocol (Claude stream-JSON `initialize`, Codex app-server `model/list`, Muse MSP `model/list`), so no model list is hard-coded. `bounce models [--json]` prints the same catalogs headlessly. An agent that is not installed or not signed in is listed as a note under the picker instead of hiding the others.
- `/order claude,codex,muse` saves routing order. Omit a provider to disable it. Bare `/order` prints the order in effect with each provider's model.
- `/mode yolo` (default) bypasses native approvals and sandboxing.
- `/mode plan` requests Claude plan mode, Codex read-only sandbox, or Muse disabled write/shell. It is not an interactive approval bridge, and provider-native tools/configuration determine exact restrictions.
- `/quota` refreshes and prints the usage each agent reports. On terminals at least 100 columns wide, a right sidebar topped by the BOUNCE wordmark shows the provider, mode, model, operation mode and state, queued prompts, workspace, session id, each agent's short quota reading, and an AGENTS list of the main agent and every worker with its state. It is on by default; `/sidebar` toggles it (`/sidebar on|off` sets it) and the choice is saved in `config.json` as `sidebar`. Narrower terminals keep the header. Use `/review` to print the full text of every completed turn's result in chronological order.
- `/skills` lists bounce's skills and where each agent has them; `/skills sync`, `/skills new NAME`, `/skills add PATH`, `/skills remove NAME`, `/skills import [provider]`, `/skills clear`, `/skills reset` and `/skills seed --force` manage them. See [Skills](#skills).
- `/btw TEXT` steers the focused agent while it works — the message is delivered into the running turn (or to the selected worker when the AGENTS pane is open). When nothing is running it is saved as an aside for the next turn.
- `/sessions`, `/rename NAME`, `/resume [SESSION]` and `/detach` manage sessions; see [Sessions](#sessions). `/agents`, `/tasks`, `/stop` and `/msg` are orchestrator commands; see [Orchestrator mode](#orchestrator-mode).
- `/login [provider]`, `/new`, `/note TEXT`, `/retry`, `/help`, `/quit`.
- Any other `/NAME` is looked up among the commands your agents keep — a repository's `.claude/commands/NAME.md`, Codex prompts, skills — and sent as the turn. See [Your agents' commands](#your-agents-commands).
- Escape or Ctrl+C cancels the running process group; Ctrl+C while idle exits.
- Mouse capture is on by default so the wheel/trackpad scrolls the transcript (three lines per tick). A terminal reports either the whole mouse or none of it, so while capture is on, hold Option (Shift in most terminals other than iTerm2) to drag-select or click links; F3 turns capture off to restore plain drag-select and link clicks, and F2 pauses updates and releases capture for copying. A plain click while capture is on prints a one-line reminder of these options. Use your terminal’s copy shortcut (usually Cmd+C or Ctrl+Shift+C); Ctrl+C cancels a turn or exits bounce. PgUp/PgDn scroll the transcript. Up/down recalls prompts; Ctrl+U clears input.
- The prompt shows a blinking block cursor and grows as text wraps, up to one third of the terminal height. Longer drafts keep their last lines visible; pasted newlines are preserved. F2 hides the cursor while copying, and exit restores the terminal's default cursor style.

YOLO intentionally lets agents run commands and change files with your user permissions. Launch in the workspace you intend to let the agents modify.

## Sessions

Every launch is a session under `~/.bounce/sessions/<uuid>/`. A session's name is its first prompt until you rename it (`/rename NAME` or `bounce rename SESSION NAME`). Wherever a command takes a SESSION, a name, a full id or a unique id prefix works; an ambiguous name is refused with the matching ids. `bounce sessions` lists every session — name, age, operation mode, id and workspace, with ● beside a live one — and `/sessions` lists the current workspace's. `/resume SESSION` switches this view to another session in the same workspace; with no argument it opens a picker. `/new` starts a fresh one.

Sessions run in a daemon that outlives the view:

- `bounce run "prompt" --detach` starts the session in the background and prints its id; without `--detach`, `run` streams events and exits when the turn ends (`--json` for machine-readable rows).
- `/detach` closes the interactive view while the orchestrator and its workers keep running.
- `bounce attach SESSION` reopens the view on a live session from any terminal; `--json` streams its journal instead. While an attached turn is still active, new prompts are held — use `/btw` to steer it.
- `bounce stop SESSION` cancels the running task tree and ends the daemon; `/quit` does the same from inside.

A session's `daemon.json` records the live daemon and is removed on a clean exit; `bounce sessions` checks that its PID is still alive before marking a session ●. The daemon escalates from SIGTERM to SIGKILL on teardown, so a vendor CLI that ignores SIGTERM cannot keep a stopped session alive.

## Orchestrator mode

`/operation orchestrator` (or Ctrl+O) switches a session from *classic* — one agent answers each turn, with fallback — to *orchestrator*: the main agent coordinates and never edits the repository itself. It reads a standing brief bounce writes at `sessions/<id>/orchestrator/ORDERS.md`, submits tasks to worker profiles over the session bus, and reports outcomes to you. Claude's own Agent/Task tools are switched off for it, and ORDERS.md forbids the other vendors' subagent features, so all delegation is visible in bounce. Switching back is `/operation classic`; the choice is saved in `config.json` and shown in the sidebar and `bounce sessions`.

Enabling it with no profile table installs a starter one: `main` on your first provider, `build` on Codex with a Claude fallback. Edit `config.json` to shape your own:

```json
{
  "operation": "orchestrator",
  "orchestrator": "main",
  "strategy": "default",
  "profiles": {
    "main":   {"adapter": "claude"},
    "build":  {"adapter": "codex", "model": "gpt-5", "fallback": ["build_claude"]},
    "build_claude": {"adapter": "claude", "model": "sonnet"},
    "critic": {"adapter": "muse", "role": "critic"}
  }
}
```

- `adapter` is `claude`, `codex`, `muse` or `local`; `model` is passed through to that CLI. `orchestrator` names the profile that coordinates; its role is derived, never declared.
- `role` is a free label (default `builder`) the orchestrator sees beside each profile. `critic`, `verifier` and `analyst` default to `policy: read-only`; any other role defaults to `write`. A read-only profile is never escalated: a task that needs writes is refused rather than downgraded.
- `mode` (`yolo` or `plan`) defaults to the session mode and may not exceed it. Execution policy only ratchets down across dispatch, fallback and review.
- `fallback` lists profiles to try, in order, when the first one's provider is exhausted or missing. Role and policy are preserved across a fallback.
- `strategy` is `default` (a single reviewer decides), `no-review` (configured reviews are ignored, tasks dispatch and complete directly) or `quorum:N` (N reviewers must accept). `"strict": true` refuses any task submitted without both a prelaunch and a completion review.

Each task carries its orders, an optional deadline, `depends_on` (held until those tasks are accepted), and optional `review` stages: a *prelaunch* review can reject the plan before a worker starts; a *completion* review can accept it or send it back for a bounded number of rework rounds through the worker's native session. Budgets are reserved per task and released on completion; a watchdog times out a task past its deadline. Every state change is a journal row (`task.submitted`, `task.milestone`, `task.blocked`, `task.completed`, `task.failed`, `task.cancelled`, `task.deadline`, `task.rejected`, `task.accepted`), so `bounce attach --json` and `bounce task compare SESSION A B` work from the log alone. Workers publish milestones with a phase, text, what happens next and evidence; a refusal is a `task.failed` row with its reason, never a silent stop.

In the TUI:

- `/agents [TASK]` opens split panes for the orchestrator and every worker; Tab and Shift+Tab cycle the focused pane, or name a task to focus it. With a worker focused, Enter and `/btw` deliver to that worker. `/agents` again, or Esc on an empty prompt, returns to the transcript. `/zoom` and `/attach` are aliases.
- `/tasks` prints every task's state and retained outcome.
- `/stop [TASK]` cancels one task, or every running task with no argument. Cancellation is verified: a worker that ignores SIGTERM is killed.
- `/msg TASK TEXT` sends a message to a running worker.
- The transcript folds worker dispatch into a line per task; `/details` expands it.

Workers and the orchestrator talk to the daemon through a token-scoped Unix socket (`bus.sock`) whose credentials are handed to each process as `BOUNCE_BUS`/`BOUNCE_BUS_TOKEN_FILE`. A vendor CLI spawned for a worker never inherits those variables. The same bridge is available from the shell for scripts and for the orchestrator itself:

```sh
bounce publish --event '{"kind":"task.submitted","parent":null,"profile":"build","orders":"…","deadline":3600000}'
bounce wait --match '{"kind":"task.completed","task":"TASK_ID"}' --timeout 3600
bounce report --report '{"op":"milestone","phase":"test","text":"…","next":"…"}'
```

A grant can publish only what its role allows: the orchestrator submits tasks and messages, a worker reports on its own task, and `control.*` rows belong to the user peer alone.

## Local workers

A profile with `"adapter": "local"` runs a model served by [LM Studio](https://lmstudio.ai) on this machine as a worker. Local workers need orchestrator mode; a local orchestrator is not supported. The model runs a bounded tool loop — read files under `readPaths` (default: the whole workspace), and only with `"policy": "write"` write under `writePaths` and run the exact `commands` you list. Commands run inside a Docker container (`node:22-alpine` by default, set `container.image`) with no host shell fallback; a builder's changes are published into the workspace only after the container has terminated and its tests were observed. `.git`, `.env*`, vendor config directories and similar are never readable or writable.

```sh
bounce local models              # what each endpoint has loaded, without loading anything
bounce local setup               # recommend a model and write a worker profile
bounce local profile NAME JSON   # preview a profile; --save writes it
bounce local check [IMAGE]       # diagnose Docker, the image and the project, without building
bounce local prepare [IMAGE]     # cache Linux npm dependencies for the container (--allow-network)
```

In the TUI, `/local setup` runs the same wizard without interrupting running agents (`/local setup loaded` limits it to already-loaded models; `/local cancel` abandons it), `/local activate [NAME]` brings saved local workers into the current session without a restart, and `/model worker PROFILE [auto|endpoint/model|refresh]` picks the model a worker uses — `prefer`/`exclude REF,REF` edit its preferences, `--save` persists any of these.

Endpoints live under `local.endpoints` in `config.json`; the default is `lmstudio` at `http://127.0.0.1:1234`, `loadPolicy: loaded-only` (a downloaded model that is not loaded is not eligible) and `maxConcurrent: 3`. Eligibility is checked at dispatch, so the orchestrator is told when no model is available rather than handed a cloud worker instead. `localOptions` bounds each run: `maxSteps` (32), `maxOutputTokens` (2048), `timeoutMs` (120000) and `maxContextBytes` (200000).

## Skills

Skills are a vendor feature: each CLI scans its own directory and none of them knows about bounce. A routed turn can land on any agent, so a skill installed for one of them silently disappears on fallback. bounce therefore keeps one copy of each skill under `~/.bounce/skills/<name>/SKILL.md` and installs it into all three agents' skill directories.

```sh
bounce skills                       # what bounce manages, and which agents have it
bounce skills new deploy-web        # scaffold a SKILL.md, then edit it
bounce skills add ./path/to/skill   # adopt a skill folder, or a single SKILL.md
bounce skills import --list         # what an agent has that bounce could adopt
bounce skills import codex          # adopt all of it (the TUI asks which instead)
bounce skills sync                  # install into every agent
bounce skills remove deploy-web     # delete from bounce and from every agent
bounce skills clear                 # withdraw every copy bounce installed
bounce skills reset --force         # also empty bounce's own store
bounce skills seed --force          # put the skills bounce ships back, deleted or not
```

`import` surveys everything an agent reads — its home area (`~/.claude/skills`, `$CODEX_HOME/skills`, `~/.agents/skills`) and the current workspace's own `.claude/skills`, `.codex/skills` and `.agents/skills` — whichever scope bounce is set to install into; a workspace find is listed as `(claude · project)`. Where the same skill sits in both, the workspace copy is offered, since that is the one the vendor lets shadow the other.

The same words work as `/skills …` in the TUI, with one difference: `/skills import` opens a checklist rather than adopting everything, because an agent's whole skill set is rarely what you meant to take. ↑/↓ moves, Space ticks one, `a` ticks all, `n` clears, Enter imports the ticks and Esc changes nothing. `/skills import --all` skips the checklist. Every write happens through the same sync, so `add`, `remove` and `import` leave the agents up to date without a separate step.

`clear` withdraws the copies bounce installed but keeps its store; `reset` empties the store as well, so an import you did not want can be undone in one step. Because deleting the store cannot be undone, `reset` first lists what would go and only acts on `--force`. Neither touches a skill the agent shipped or you installed natively.

A skill is a directory whose `SKILL.md` opens with `name` and `description` frontmatter; the directory name must match `name`. Everything else in the directory — references, scripts, assets — is copied along with it, and the rest of the frontmatter is passed through untouched for the vendor to interpret. Symbolic links are not copied, so an installed skill cannot reach outside itself.

Skill directories, verified 2026-09-08:

| Agent | User scope | Project scope |
| --- | --- | --- |
| Claude | `~/.claude/skills` (`CLAUDE_CONFIG_DIR`) | `<workspace>/.claude/skills` |
| Codex | `~/.codex/skills` (`CODEX_HOME`) | `<workspace>/.codex/skills` |
| Muse | `~/.agents/skills` | `<workspace>/.agents/skills` |

Each installed copy carries a `.bounce-skill.json` marker naming the skill and hashing its contents. Sync updates or removes exactly the directories carrying that marker, so a skill the agent shipped or you installed natively is never overwritten or deleted: a name collision is reported as a conflict and left alone. A collision whose contents are byte-identical is not a conflict — that is the skill bounce adopted from that very agent, and there is nothing to write. It is reported as `identical` and deliberately left unmarked, so removing it from bounce later never deletes the agent's own copy. An unchanged skill is not rewritten, so the sync that runs at every launch touches nothing when everything is current. Set `skills.autoSync` to `false` in `config.json` to only sync on request.

`skills.scope` (or `--scope` for one command) chooses between the agents' home directories and the workspace. Project scope writes into the repository you are working in — commit or ignore those directories deliberately. In a workspace Muse also reads `.claude/skills` and `.codex/skills`, so it sees the same skill three times and keeps the highest-priority copy with a note; nothing fails. `bounce skills clear --scope project` withdraws them again.

Skills are the only capability bounce carries across providers. Instructions in the handoff packet — the transcript and `/note` — reach every agent as text; `CLAUDE.md`, `AGENTS.md` and each vendor's own configuration remain that vendor's business.

bounce ships its own `agent-orchestrator` skill and seeds it into the store the first time an orchestrator session starts, so the brief resolves even on a machine that has never run `bounce skills import`. If you already have a skill named `agent-orchestrator`, or you edit the seeded copy, seeding never overwrites it. Seeding is first-run only: remove it, or reset the store, and it stays gone — `bounce skills seed --force` puts it back. The store entry is named `agent-orchestrator` rather than `orchestrator` so it cannot collide with a skill of that name you already keep for your own agents; the two are separate copies from then on, and yours is the one bounce leaves alone. The skill carries the five Claude Code role files it delegates to, in `agents/` beside its `SKILL.md`. Claude Code reads agent files only from `~/.claude/agents`, so nothing installs them for you: the skill offers the one-line copy before its first delegation, and runs the roles degraded — as instructions rather than enforced tool sets — until you say yes.

## Your agents' commands

A repository often carries slash commands of its own — `.claude/commands/triage.md` gives Claude Code a `/triage`. Typed into bounce, such a line would normally go nowhere: bounce wraps every request in a handoff packet, so the vendor never sees a bare `/triage` at the start of its input, and only bounce's own commands are on the `/` menu. So bounce expands them itself. A `/NAME` that is not one of bounce's commands is looked up, in this order, in the workspace's `.claude/commands`, then `~/.claude/commands` (`CLAUDE_CONFIG_DIR`), then Codex prompts (`$CODEX_HOME/prompts`), then skills — bounce's own store first, then each agent's workspace and home skill directories — and the first match becomes the turn. The same lookup works headless: `bounce run "/triage REC-1234"`.

```sh
/triage REC-1234          # .claude/commands/triage.md with $ARGUMENTS filled in
/seed-account Acme Jane   # $1, $2 … take the words; $ARGUMENTS the whole tail
/deploy                   # a skill by name, with a pointer to its files
```

Expansion follows Claude Code's rules: the frontmatter is dropped (`allowed-tools`, `model` and the like are vendor configuration, not instructions), `$ARGUMENTS` is the whole argument tail and `$1`…`$9` its words, and arguments a template never mentions are appended so nothing is lost. Inline `!\`command\`` is left as written for the agent to run rather than executed by bounce, and `@file` mentions pass through. Because the expansion happens in bounce, the command works whichever agent answers the turn — a Claude command runs on Codex after fallback — but anything inside it that names a Claude-only feature (a subagent from `.claude/agents`, a nested `/command`) still only means something to Claude.

The transcript shows the line you typed with a note of how much it expanded to; `/details` unfolds the full text. The journal keeps the expansion, so a fallback agent and later turns read the instructions rather than a slash line they cannot resolve. These commands join the `/` picker after bounce's own, `/help` lists the ones this workspace offers, and a name that clashes with a bounce command (`/review`, `/skills`) is bounce's. Nothing is copied or synced: a repository's commands stay that repository's, which is also the answer when a skill should exist in one repo only — keep it in that repo's `.claude/skills` rather than in bounce's store, and it is still reachable as `/NAME` there.

## Routing and context

Default order: Claude → Codex → Muse. Successful fallback becomes sticky for the session. Provider exhaustion detected in structured errors, or stderr on failed execution, moves to the next provider. A missing executable also falls through. Authentication, permission, network, model, and other failures stop the turn rather than replaying side effects on another provider. Every provider is attempted at most once per turn. Escape never causes fallback.

A provider hitting limits is skipped for a configurable local delay (30 minutes by default). This is **not** a subscription reset estimate. `/retry` clears the local delay. Usage events are recorded when supplied by the CLI; no account percentages or costs are invented.

Every turn starts a fresh native CLI process with a handoff. The handoff includes the original request, a bounded recent journal suffix, current request, and Git HEAD/status/diff-stat. It asks the next agent to inspect partially completed work. Full raw provider events and normalized conversation/tool events remain in the journal. Git observation does not commit, stash, reset, or roll back files. Switching is not transactional: an exhausted agent may already have performed side effects.

## Quota

`/quota` in the TUI, or `bounce quota [--json]`, reports the subscription usage each agent states about itself. Nothing is estimated: a window appears only because a CLI reported that percentage.

- **Codex** answers between turns over its app-server (`account/rateLimits/read`): the 5-hour and weekly windows, their reset times, and the plan. bounce asks at startup, after every turn, and on `/quota`.
- **Claude** reports its 5-hour and weekly windows only while a turn runs, in the `rate_limit_event` records of its stream. The last reading is kept, so it stays visible between turns and across restarts.
- **Muse** reports no quota in its protocol, and says so instead of showing a number.

The fallback order in the header carries each agent's short reading, e.g. `claude (5h 42% · 7d 7%) → codex (5h 100% · 7d 16%) → muse`. Readings are stored in `~/.bounce/quota.json`; repeated identical readings do not rewrite the file or redraw the screen. `bounce doctor` prints the same reading beside each CLI version. A reading is a vendor's own percentage at the moment it was reported, and reset times are what the vendor stated, not a prediction of when work will succeed again.

## Local storage

`~/.bounce` (override with `BOUNCE_HOME`). A `~/.localrouter` directory left by the previous name is moved to `~/.bounce` on first launch, keeping existing config, sessions and quota readings:

- `config.json`: order, mode, per-provider models, cooldownMinutes, contextChars, executable overrides, skill scope and auto-sync; in orchestrator mode also `operation`, `orchestrator`, `profiles`, `strategy`, `strict` and `local`.
- `skills/<name>/SKILL.md`: the skills bounce manages and installs into every agent.
- `quota.json`: the latest usage reading each agent reported, kept across restarts.
- `sessions/<uuid>/journal.jsonl`: append-only normalized and raw events.
- `sessions/<uuid>/handoff.txt`: latest cross-provider prompt.
- `sessions/<uuid>/lock`: prevents concurrent session writers; stale PID locks are recovered.
- `sessions/<uuid>/daemon.json` and `bus.sock`: the live daemon and its session bus, while one is running (the socket falls back to `/tmp/bounce-<uid>/` when the path is too long for a Unix socket; orphans are reaped on the next daemon start).
- `sessions/<uuid>/orchestrator/ORDERS.md`: the orchestrator's standing brief, rewritten at each daemon start.
- `sessions/<uuid>/tasks/<task>/`: each worker's orders, pending deliveries and checkpoints.

Directories/files are created with owner-only permissions. Journals contain prompts and tool output, which can include sensitive project content. On handoff this context is sent through the next configured provider. To remove bounce history, remove the relevant session directory while it is not running. Provider-native histories remain under each vendor's control.

Example config:

```json
{
  "order": ["claude", "codex", "muse"],
  "mode": "yolo",
  "models": {},
  "executables": {},
  "cooldownMinutes": 30,
  "contextChars": 48000,
  "skills": {"scope": "user", "autoSync": true}
}
```

Executable discovery checks PATH, common local install directories, and the macOS Codex/ChatGPT app bundles. `doctor` shows the resolved path. An explicit `executables.codex` override takes precedence if needed. Configuration is global to bounce; sessions remember their workspace. `--provider`, `--model`, and `--mode` override a launch; slash commands persist settings.

## Development and verification

```sh
npm test
npm run check
```

Tests use fixture processes and temporary directories, without subscription calls. The Muse adapter was additionally checked against the installed CLI's offline echo event stream. Live authenticated coding runs and browser login flows require manual integration validation.

Protocol references: [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude programmatic execution](https://code.claude.com/docs/en/headless), and installed `muse exec --help` plus `muse exec --provider echo --no-session-log --json` (verified 2026-09-08).

## Current boundaries

This is a working 0.2 foundation. The TUI is an Ink renderer, not a full terminal emulator: multiline input composition is basic. Task trees are at most two levels deep (a task and its children), and a local orchestrator is not supported. Local workers are LM Studio only (an Ollama backend exists in the source but is not yet selectable from a profile) and need Docker on PATH for any command. Claude/Codex messages render as structured events arrive; Muse renders output deltas. Native session resume is used only for review rework inside orchestrator mode (Claude `--resume`, Codex `thread/resume`, Muse checkpoint re-launch); classic turns still start a fresh process with a handoff. Semantic long-history compaction and interactive tool approvals are not implemented. Skills are installed as copies rather than being run by bounce: which of them an agent actually loads, and when, stays that agent's decision, and a vendor changing its skill directory or frontmatter needs the table in [Skills](#skills) revisited. Quota is only as good as what each CLI reports: Codex answers on demand, Claude reports during turns, Muse reports nothing. Context is bounded and may omit older decisions; `/note` helps record current handoff details. Raw events preserve unrecognized provider data for adapter updates. Providers can change their flags/event formats, so review adapter fixtures when upgrading them.

## Improve bounce using bounce

After `npm link`, run `bounce dev` from any directory. It opens the actual bounce source directory as the agent workspace. Ask for an improvement, for example:

> Add a /status command showing the current provider, model, routing order, and local cooldowns. Add relevant tests and update the README.

In dev mode, a successful agent turn that changes `src/` or `package.json` triggers `npm run check` and `npm test`. If both pass, a supervisor starts a fresh process and resumes the same journal, workspace, selected provider, model settings, and permission mode. Failed validation keeps the current process running so you can ask the agent to fix the problem. No relink is needed: npm's link already points to these source files.

Use `/restart` in any TUI session to validate and reload manually. A regular launch does not automatically reload. Restart happens between turns, never during a running agent command. Source edits are kept on disk even when checks fail; there is no automatic rollback. Passing tests cannot guarantee the updated app starts successfully; if startup fails, fix the source and use `bounce --resume ID` (IDs are listed by `bounce sessions`). Changes to the supervisor itself require fully quitting and launching again. This reloads local changes; it does not download releases or run Git pulls.
