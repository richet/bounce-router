# bounce-router

[![npm version](https://img.shields.io/npm/v/bouncerouter?logo=npm&color=cb3837)](https://www.npmjs.com/package/bouncerouter)
[![npm downloads](https://img.shields.io/npm/dm/bouncerouter?logo=npm)](https://www.npmjs.com/package/bouncerouter)
[![Node.js 22+](https://img.shields.io/node/v/bouncerouter?logo=node.js&color=339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/github/license/richet/bounce-router?color=blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/richet/bounce-router?style=flat&logo=github)](https://github.com/richet/bounce-router/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/richet/bounce-router?logo=github)](https://github.com/richet/bounce-router/commits/main)

bounce-router is one TUI for your installed Claude Code, Codex, and Muse coding agents, run with the `bounce` command. Uses native CLI login and headless processes; bounce owns the conversation and carries context between providers. When one provider's subscription usage is exhausted, it automatically fails over to the next signed-in provider.

Since 0.2, bounce also has an **orchestrator** operation mode: the main agent coordinates and delegates work to a team of agents — each a job (analyst, builder, integrator, reviewer) played by Claude, Codex, Muse or a local LM Studio model through OpenCode — over a per-session bus, with an AGENTS pane, a task board, reviews and budgets. Big work is broken into phases in sequence and chunks in parallel, no task longer than a set cap; [Jev](#jev-typesafe-decisions) can pick the job and the AI for each task and judge each result. Sessions have names, can run detached in the background, and can be reattached from any terminal. See [Orchestrator mode](#orchestrator-mode), [Agents and local models](#agents-and-local-models) and [Sessions](#sessions).

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
bounce agents                       # the team: which AI plays each job
bounce local                        # local models, the OpenCode bridge, agents a local model may play
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

The transcript is about what was said and how to continue. Your prompt is a `>` line and each answer a `●` block whose text hangs two columns in. A run of the orchestrator's own tool calls is one dimmed line (`⚙ 3 tool calls · last: Bash(Run the gate)`); a worker's outcome is a block with its whole summary, and a worker waiting on you is marked in place with its question and the command to answer it (`/agents <id>`). Vendor plumbing, the hand-off prompt and bounce's own bookkeeping rows stay out of the folded view; `/details` shows everything, and the journal keeps everything. A finished turn ends on a `▸ Next` line: the answer's TLDR when the answer is long, how many workers are still running, and who is waiting on you. Lists use `-` and `1.` markers and a wrapped item continues under its own text; fenced code is indented and highlighted. Claude's final result, which repeats the last answer, and Codex's bare `Turn completed` are not shown twice.

When the orchestrator's answer ends by proposing what to do next (`Next: …`, `Should I …?`), that step is prefilled dim in the prompt: Tab takes it, typing replaces it, and it is never sent on its own. An open question, or a list of steps, is not prefilled.

What the orchestrator says to you is the one thing painted in colour; a run of tool calls, bounce's own bookkeeping rows and a worker's mechanics are dim, so the eye lands on the answer and on the `▸ Next` line.

The status rail on the right shows who is working: a moving glyph while a worker works (`✓` done, `✗` failed, `?` waiting on you, `◌` queued), the model it runs on by its short identifier (`qwen3.6-35b-a3b`, never the whole packaging name), how long since it last did anything, and under a working agent the phase it last reported and how long ago that milestone was. Under every working agent's row, and under the main worker's, a line says what it is doing right now and for how long: `… thinking · 4s`, `⚙ bash: deno test · 12s`, or `⏳ waiting on 79981b05 · 6m` for a `bounce wait` on a task, with that task's own state in the header and the pane. A working row turns red after two silent minutes. The header line says the same for the main worker. The screen redraws four times a second while anything works, once a second at rest.

Live progress — Claude's thinking-token counters, tool heartbeats and the start and end of each foreground Bash call, Codex's command starts — is never written to the journal, and a run of readings for the same thing (`Thinking · ~50 tokens`, `~150`, `~265`…) is one transcript line showing the latest, so a long turn no longer buries the conversation in repeated `thinking_tokens` rows. Short bookkeeping events (agent selected, activity, cooldown, agent finished, turn finished) render as a single line. `/details` shows everything: every tool call field by field with real newlines rather than as escaped JSON, full tool output, and worker dispatch (`/details on|off` sets it explicitly); the journal keeps the original text for handoffs.

The header names the agent that is actually running: under orchestration, the orchestrator profile's adapter and model; in classic mode, the active provider in the fallback order. It updates when the provider reports its model. If neither a model override nor runtime metadata is available, it shows `Default (not reported)`; use `/model ID` to select one explicitly. Bounce activity labels describe local progress. Restart validation shows concise success messages and retains diagnostic output on failure.

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
- `/local` shows local models, the OpenCode bridge and the agents a local model may play; `/local verify` runs one real turn; `/local setup [loaded]` picks which model plays each agent and applies it to this session; `/local activate [AGENT]` re-reads agent files into the running session.
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

Bounce ships a worker roster, so nothing needs configuring to start: `main` (the orchestrator, on your first provider) plus one builder for every model the cloud vendors list in the `/model` picker, each with a cost tier and a note on what it is good for (`src/model-catalog.js`) so [Jev routing](#jev-typesafe-decisions) can choose between them out of the box. That roster is the baseline of every orchestrator config: it is always present, and never copied into `config.json`. The two frontier builders keep their historical names; the rest are `<adapter>_<model>`:

| profile | model | tier |
| --- | --- | --- |
| `build` | codex / gpt-6-astra | strongest |
| `build_claude` | claude / opus[1m] | strongest |
| `claude_fable` | claude / claude-fable-5-1[1m] | strongest |
| `codex_sol` | codex / gpt-5.6-sol | mid |
| `codex_terra` | codex / gpt-5.6-terra | mid |
| `claude_sonnet` | claude / sonnet | mid |
| `codex_55` | codex / gpt-5.5 | mid |
| `muse_spark` | muse / muse-spark-1.3 | mid |
| `muse_spark_12` | muse / muse-spark-1.2 | mid |
| `codex_luna` | codex / gpt-5.6-luna | cheapest |
| `claude_haiku` | claude / haiku | cheapest |

Each builder falls back across vendors at the same tier (`build` → `build_claude`, `codex_terra` → `claude_sonnet`, `codex_luna` → `claude_haiku`, …), so an exhausted account moves a task sideways rather than down. The Muse `-contributor` variants share your prompts and code with the vendor and are not shipped as profiles; local models are added by `/local setup`.

Your `profiles` block in `config.json` is an overlay on that roster: an entry with a new name adds a profile after the shipped ones, an entry with a shipped name replaces that profile outright (its fields are not merged — write the whole entry, fallbacks included), and setting a shipped name to `null` drops it, along with any shipped fallback that pointed at it. Shipped order is kept, so `build` stays the routing fallback unless you drop or reorder around it. The saved config only ever holds your overlay — `/local setup`, `/model worker … --save` and `bounce local profile --save` write just the profile they change — so an upgraded bounce brings new shipped builders with it, and deleting the block returns you to the defaults. `orchestrator` defaults to `main`. With the config below the roster is the shipped builders with `main`, `build` and `build_claude` as written here, plus `scout` and `critic`, minus `muse_spark_12`:

```json
{
  "operation": "orchestrator",
  "orchestrator": "main",
  "strategy": "default",
  "profiles": {
    "main":   {"adapter": "claude"},
    "build":  {"adapter": "codex", "model": "gpt-6-astra", "fallback": ["build_claude"]},
    "build_claude": {"adapter": "claude", "model": "opus[1m]"},
    "scout":  {"adapter": "claude", "model": "haiku", "tier": "cheapest", "capabilities": "Finds files and symbols fast; never give it a refactor."},
    "critic": {"adapter": "muse", "role": "critic"},
    "muse_spark_12": null
  }
}
```

- `adapter` is `claude`, `codex`, `muse`, `local` or `typesafe`; `model` is passed through to that CLI. `orchestrator` names the profile that coordinates; its role is derived, never declared. An optional `tier` (`cheapest`, `mid`, `strongest`) and `capabilities` sentence are shown in the roster and read by [Jev routing](#jev-typesafe-decisions); they override what bounce ships for that model, and for a model bounce does not know (a local model, a new vendor id) bounce describes the model itself.
- `role` is a free label (default `builder`) the orchestrator sees beside each profile. `critic`, `verifier` and `analyst` default to `policy: read-only`; any other role defaults to `write`. A read-only profile is never escalated: a task that needs writes is refused rather than downgraded.
- `mode` (`yolo` or `plan`) defaults to the session mode and may not exceed it. Execution policy only ratchets down across dispatch, fallback and review.
- `fallback` lists profiles to try, in order, when the first one's provider is exhausted or missing. Role and policy are preserved across a fallback.
- `strategy` is `default` (a single reviewer decides), `no-review` (configured reviews are ignored, tasks dispatch and complete directly) or `quorum:N` (N reviewers must accept). `"strict": true` refuses any task submitted without both a prelaunch and a completion review.

Each task carries its orders, an optional deadline, `depends_on` (held until those tasks are accepted), and optional `review` stages: a *prelaunch* review can reject the plan before a worker starts; a *completion* review can accept it or send it back for a bounded number of rework rounds through the worker's native session. Budgets are reserved per task and released on completion; a watchdog times out a task past its deadline. Every state change is a journal row (`task.submitted`, `task.milestone`, `task.blocked`, `task.completed`, `task.failed`, `task.cancelled`, `task.deadline`, `task.rejected`, `task.accepted`), so `bounce attach --json` and `bounce task compare SESSION A B` work from the log alone. Workers publish milestones with a phase, text, what happens next and evidence; a refusal is a `task.failed` row with its reason, never a silent stop.

The orchestrator does not have to poll. Every outcome of a task it submitted that none of its own `bounce wait` calls returned (the bus journals a `wait.served` row when one does) is handed to it by the daemon: when it is idle, the daemon starts its next turn itself with the outcome in front of it — task id, profile, how it ended, the reason, and the final report summary or failure text — and asks it to synthesize; a task that ends mid-turn without being waited on is handed over at the next idle. Several tasks ending together become one turn, and a prompt you type first carries the same block instead. That block is journaled as a `handoff` row (`wake: true` for a turn bounce started, `false` when it rode on your prompt), distinct from a `user` row, so `bounce attach --json` and the transcript can tell them apart; it counts as delivered only once that turn actually starts, so a wake-up whose provider fails to launch (its own vendor limited, say) is retried once and otherwise leaves the outcomes to ride on the next prompt. A worker whose vendor account is exhausted mid-task or at launch (Codex's "You've hit your usage limit", a rejected Claude rate limit, a Muse quota refusal) ends as `task.failed` with reason `limited` and is replaced on the profile's `fallback` chain.

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
bounce publish --event '{"kind":"task.milestone","task":"TASK_ID","phase":"inspect","text":"…","next":"…","evidence":["…"]}'
bounce report --report '{"op":"milestone","phase":"test","text":"…","next":"…"}'
```

`wait`'s `--timeout` is seconds and may run to the task deadline (the bridge re-arms the bus's 600 s wait); a `null` reply is an expired timeout, exit code 1. Every `task.*` row a peer publishes needs its `task`; without it the bus answers `invalid event: <kind> requires task`.

A grant can publish only what its role allows: the orchestrator submits tasks and messages, a worker reports on its own task, and `control.*` rows belong to the user peer alone.

### Big work is broken down

However large the request, the orchestrator does not hand one worker the whole job. Its standing orders tell it to plan **phases in sequence, each made of chunks that run in parallel** where their owned paths are disjoint, to chain phases with `depends_on`, and to review each phase before the next starts. The scheduler holds it to that: no task may be given more than `taskMinutes` (config.json, default 15, 1–240). A deadline over the cap is refused before anything runs (`task.failed`, reason `size`), and the refusal says how to split. A task with no deadline gets the cap as its deadline.

**A plan is judged before its chunks run.** The orchestrator submits a phase's breakdown as `plan.submitted` (chunks with `id`, `profile`, `orders`, `owns`, `depends_on`, `deadline`). bounce refuses overlapping owned paths and a deadline over the cap itself; with Jev on, each chunk is also judged for being phase-sized, having no acceptance criterion, or a hidden dependency on another chunk. The answer is `plan.accepted` or `plan.rejected` with findings per chunk and the fix. Live, real Jev: a clean three-chunk plan accepted with no findings in 308 ms; a plan with a "finish P2" chunk, an audit with no acceptance and two chunks on the same paths rejected for exactly those. The gate warns; it does not yet refuse chunks submitted without an accepted plan.

While a worker runs, the status rail shows under its row the phase it last reported and how long ago that milestone was, and its block in the conversation names the phase. The stall alarm treats five minutes without any output as silence and ten minutes without a milestone as a stall; at two minutes it used to fire on every test run.

## Agents and local models

The orchestrator can submit work to two kinds of target. A **profile** is one AI (the shipped roster above, routed by tier and capabilities when `profile: "auto"` is on — see Jev below). An **agent** is a job — one markdown file: frontmatter for what bounce routes on, the body as the worker's system prompt.

```markdown
---
name: reviewer
description: Reads and probes the integrated tree for defects; never edits.
policy: read-only                 # read-only | write (default)
maxSteps: 40
models: [auto, lmstudio/qwen3.8-27b-mlx@4bit, claude/default]   # auto: Jev picks the AI per task
---
You are the reviewer. …
```

`models:` lists the AIs that may play the agent, in fallback order, named by **provider** (`claude/sonnet`, `codex/gpt-5.6-terra`, `muse`, `lmstudio/<model>`; `provider/default` is that provider's default model). A fallback is therefore always the same job on another AI. With no `models:`, every signed-in provider plays it in your routing order, then a local model. Put `auto` first (`models: [auto, claude/default]`) to let Jev pick the AI for each task; what follows `auto` is what the agent runs on when Jev is off or unsure.

Agent files are layered, later ones shadowing by name: the four shipped with bounce (`analyst`, `builder`, `integrator`, `reviewer`) → `~/.bounce/agents/` → `<workspace>/.bounce/agents/`.

```sh
bounce agents                                  # the team in force: name · policy · source · who may play it
bounce agents show reviewer
bounce agents set coder --scope project < coder.md    # validated against this machine before it lands
bounce agents remove coder
```

### Local models (LM Studio, through OpenCode)

A local model is just another AI that can play an agent. bounce runs it the way it runs Claude Code and Codex: one [`opencode run`](https://opencode.ai) process per turn **in your workspace**, prompt in, JSON events out, process exit = turn done. Read-only agents get read/grep/glob only; write agents edit files and run commands exactly like a cloud worker in YOLO mode — so review their diff the same way. Out-of-workspace paths are refused by OpenCode itself, and vendor API keys are never passed to a local worker.

The only local-specific step is setup: install the `opencode` CLI, start LM Studio's server, then

```sh
bounce local            # what is loaded, whether OpenCode is installed, which agents a local model may play
bounce local --verify   # additionally run one real one-line turn through OpenCode
bounce local setup      # pick which model plays each agent — Enter accepts the suggestion
```

or `/local`, `/local verify`, `/local setup` inside the TUI (setup applies to the running session). `bounce local on|off` (`/local on|off`) is the switch, in the same words as `bounce jev on|off`: off makes every agent skip its local AIs and run on the rest of its list, and inside the TUI it applies to the running session. With routing on, `bounce jev` also lists the jobs `auto` can route to, which agents hand their AI to Jev, and whether local models are candidates. Loaded models are listed first; downloaded ones load on first use. Setup writes `lmstudio/<model>` first in the agent's `models:` and keeps your cloud providers behind it as fallbacks.

`local.endpoints.<name>.contextTokens` (optional, at least 4096) is the context OpenCode is told each local model has: a worker's conversation is compacted at that size instead of growing to whatever LM Studio loaded the model with (these MLX builds load at 262k whatever the CLI asks). Verified live: with a 32k limit a worker reading a 60k-token file compacted twice and still answered correctly; without it the prompt grew to 82k. `local.endpoints.<name>.maxConcurrent` (default 1) is how many local workers run on that endpoint at once; set it to the parallel slots the model is loaded with. A task past the limit stays queued, says so once, and starts when a local turn ends. Cloud workers are never held by it.

What to expect from local models: the fast ones (3B-active MoE builds such as Qwen3-Coder-30B-A3B or Qwen3.6-35B-A3B) read, build and pass tests quickly, and tend to keep re-issuing a call they have already made instead of concluding; dense thinking models (Qwen3.8-27B) conclude on their own and review well, at several times the time. bounce stops a worker that repeats a call four times with nothing changed, or spins on empty steps. If that worker had already read the material, it gets one more turn on the same session with every tool off and is asked to state its conclusion from what it has: an answer becomes the task's result (still reviewed like any other), silence leaves the failure as it was and the job falls to the next AI in the agent's list. A read-only worker may read outside the project folder as a cloud worker may; what it can do there is still only its tools.

A task may declare `owns` (relative paths or globs) on `task.submitted`: the paths its worker may change. After a write worker's turn, every change outside them — an edit, a new file, a deletion — is put back before the completion is journaled, and a `task.reverted` row names what was reverted. This is by the filesystem, so it holds in a tree git does not track yet. A local worker is told that its final answer is its report and that there is no report endpoint to reach; only cloud workers get the report protocol. Text a worker said before its tool work is a plan, not an answer: a turn that ends with tool calls and nothing said after them has no answer and falls to the next AI, instead of that opening sentence becoming the task's completion. The standing orders tell the orchestrator to wait on a task it dispatched rather than investigate the same question itself.

## Jev (TypeSafe) decisions

Optional, off by default. [Jev](https://docs.typesafe.ai) is TypeSafe's decision model: it answers typed questions over a state in ~150 ms and returns probabilities and a confidence, never text. bounce uses it for two harness decisions — both on once Jev is enabled, both gated on confidence so an unconfident answer means today's behaviour, and both skipped — with a `jev.skipped` row saying why — whenever the key is missing or the API is unreachable, times out (10 s), or errors (one retry on 429/529).

    /jev                  status: enabled?, key (last 4 chars), model, review/routing flags
    /jev key [KEY|clear]  store the key in ~/.bounce/secrets.json (0600); no KEY opens a masked prompt
    /jev on | off         enable or disable everything Jev does: verdicts and routing
    /jev review on|off    completion verdicts (default on when enabled)
    /jev routing on|off   model routing for "profile":"auto" (default on when enabled)
    /jev roster [refresh] what routing knows about each worker model (tier, capabilities, who described it); refresh describes them again
    /jev model ID         default jev-1.13.0 — pinned, because an alias like jev-latest moves between releases and shifts the calibrated thresholds
    /jev confidence N     threshold, default 0.8
    /jev test             one live noul call ("Is this a test?"): latency and the answer, or the error

`/typesafe` is an alias; `bounce jev …` is the headless twin. The key never enters `config.json` or a journal.

**A deadline is bounce's decision, not the user's.** A task that runs out of its deadline is cancelled with reason `deadline`, and whoever submitted it is told, with the way forward: its partial progress is in the journal, resubmit what is left as a smaller task or drop it. The orders say the same; only a cancellation with reason `user` means stop.

**A rework loop cannot run away.** Each root task has a rounds cap (`budget.rounds`, default 2). A rework whose findings are the same as the previous round's is not run again: the task is escalated to the orchestrator as blocked with both verdicts on record, because a worker sent back twice for the same thing has shown it cannot satisfy it. A check the state itself contradicts is not a finding: `empty_diff` is dropped when the diff Jev was shown is not empty, and a rework left with nothing actionable is an accept. A repository with no commit yet has no diff to judge, so no verdict is asked there.

**Completion verdicts.** With `jev.enabled` and `jev.review`, a root task submitted without a `review.completion` profile is reviewed by Jev before it is accepted: the state is the orders, the worker's final report, the `git diff` of the tree against the task's start (bounded to ~24k tokens) and the test-result lines found in the report; the questions are one accept/rework choice plus narrow yes/no checks (diff outside the owned paths, forbidden files changed, tests claimed without output, work named as remaining, an acceptance criterion unmet, unverified claims, an empty diff). A `rework` with confidence ≥ the threshold takes the same path a critic's rework does — one rework round to the same worker with the checks that fired as its must-fix list; anything else accepts. The verdict is journaled (`jev.verdict`, probabilities and confidence, never the request) and shown like any review verdict. An explicit `review.completion` always wins, and only the default strategy is decorated.

**Model routing.** With `jev.routing`, the orchestrator may submit `"profile":"auto"`: bounce classifies the orders against the whole roster — a choice over every worker profile's adapter/model/role/policy, its cost `tier` and a sentence on what its model is good and bad at, plus whether the orders need write or shell access — and dispatches the top pick when it is confident and its policy fits; otherwise `jev.routing.default` (`/jev routing default NAME`) or the first writing builder that is not the orchestrator. With routing off or Jev unavailable, `auto` resolves to that same fallback, so an orchestrator that uses it never breaks. Each decision is a `jev.routed` row.

**Tier first.** The same call asks which cost tier the orders need (`cheapest`, `mid`, `strongest`). A tier chosen at 0.6 or above decides: bounce takes the first profile of that tier, in your provider order (`order`), whose policy fits the access the orders need. Picking between named profiles of one tier is not a question a model answers reliably — they are near-equal — so the named choice is only the second chance, at the usual threshold, when the tier is unsure or no profile of it fits. An `auto` agent's AI is chosen the same way, without the access gate (the policy is the job's).

**Local models as the AI.** For an `auto` agent — and only there, since a local model is always an agent's backend — the candidates also include the tool-capable models LM Studio has **loaded**; when nothing is loaded, the downloaded ones, marked as costing a load. Each is described by its roster note (`lmstudio/<model>`; the roster setup describes them like any other model) and, with no note, conservatively as `cheapest`. A local model of the needed tier runs first, because it costs nothing, so the tiers do the mixing: cheap work goes local and the rest goes cloud until a local model is rated that high. `/local on|off` is the one switch: on supplies the local candidates and puts `auto` first in every agent file you wrote (the models you chose stay behind it as the fallback); off leaves Jev choosing between cloud AIs only. Local models are rated like any other model: `/jev roster` lists them with their tier, and `/jev roster refresh` (or the daemon, when routing is on) has your cloud agent describe the ones nobody has described, shown the already-rated roster so they land on the same scale. Between two local models of one tier, the one the agent's own list names plays it, so a reviewer keeps its reviewer model. A local pick that fails falls to the agent's own list like any other.

The tier and capabilities need no configuring. Precedence is: a profile's own `tier`/`capabilities` (`"tier": "mid", "capabilities": "…"`) always win; every model in the vendors' `/model` pickers has a shipped note (`src/model-catalog.js`, shown as source `catalog` in `/jev roster`), so the default roster routes with no agent turn at all; any other model — a local model, a vendor id newer than this bounce — is described once by one of your own cloud agents — the orchestrator's model, else the first cloud profile in the roster — in a single read-only, tool-free turn when the daemon starts with routing on (or on `/jev roster refresh`). Those notes are cached in `~/.bounce/roster-notes.json` per adapter/model, journaled as a `jev.roster` row, shown in ORDERS.md, and listed by `/jev roster`. If the description fails, a `jev.skipped` row says why and routing sees adapter/model/role/policy only for that model.

A `typesafe` profile can also be declared in `config.json` (`{"adapter": "typesafe", "role": "critic"}`) and named as a `review.completion` reviewer explicitly; it is always read-only and never runs a task.

**Routing picks the job, then the AI.** With agent files present, the same routing call also asks *which job the orders describe* — each agent's description and policy, plus `none`. A confident job whose policy can do the work (a read-only job is never given orders that need to edit files) wins: the task goes to that agent, and the agent file's own `models:` order decides the AI — Jev never overrides a list you wrote. With no clear job, or no agent files at all, routing chooses a worker profile exactly as before. An agent whose `models:` opens with `auto` is the exception you asked for: the job is fixed and Jev picks the AI per task from your worker profiles, judged on tier and capabilities alone — mode, policy, role and prompt stay the agent's. Below the confidence threshold, with Jev off, or when the picked AI fails, the agent runs on the rest of its list. `jev.routed` records the job (or why none was chosen) beside the profile decision. For an `auto` agent the row also names the AI (`agent@profile`). A task submitted to an agent is Jev-reviewed like any other, and a local worker's answer is what the verdict judges.

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

bounce ships its own `agent-orchestrator` skill and seeds it into the store the first time an orchestrator session starts, so the brief resolves even on a machine that has never run `bounce skills import`. If you already have a skill named `agent-orchestrator`, or you edit the seeded copy, seeding never overwrites it. Seeding is first-run only: remove it, or reset the store, and it stays gone — `bounce skills seed --force` puts it back. The store entry is named `agent-orchestrator` rather than `orchestrator` so it cannot collide with a skill of that name you already keep for your own agents; the two are separate copies from then on, and yours is the one bounce leaves alone. The skill carries five roles for each harness in `agents/`: Claude Code Markdown files and Codex TOML files. Skill sync transports both sets; activation is a separate, conflict-preserving copy into the chosen harness’s user or project agents directory. The harness references explain installation and fallback behavior, including Codex’s parent permission overrides. Existing role files are never overwritten.

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

Orchestrator main turns also fail over on provider exhaustion or a missing CLI. The main
profile chooses the initial provider and model (an omitted model uses `models[provider]`).
If that profile explicitly declares `fallback`, its ordered profile chain is authoritative;
`fallback: []` disables automatic fallback. Otherwise the configured provider `order` and
per-provider `models` apply, including `/order` and `/model` changes on the next request.
Profile-table changes take effect when the daemon is reloaded. Local profiles are not eligible
main agents. Each provider is tried at most once per logical request, exhausted providers
observe `cooldownMinutes`, and `/retry` clears the journaled cooldowns.

The daemon verifies the old process has stopped before starting a fallback with the standing
orders, current request, saved images and bounded workspace/history handoff. Ordinary failures
and cancellation stop the request. Unverified termination blocks further launches. Selection
is journaled and shared with attached views; the chosen provider, model and any narrower
mode/policy persist across later turns and daemon restarts. A fallback cannot widen the
request's mode or read-only policy. Exhausting the eligible routes ends as `unavailable`.

Every turn starts a fresh native CLI process with a handoff. The handoff includes the original request, a bounded recent journal suffix, current request, and Git HEAD/status/diff-stat. It asks the next agent to inspect partially completed work. Full raw provider events and normalized conversation/tool events remain in the journal. Git observation does not commit, stash, reset, or roll back files. Switching is not transactional: an exhausted agent may already have performed side effects.

## Quota

`/quota` in the TUI, or `bounce quota [--json]`, reports the subscription usage each agent states about itself. Nothing is estimated: a window appears only because a CLI reported that percentage.

- **Codex** answers between turns over its app-server (`account/rateLimits/read`): the 5-hour and weekly windows, their reset times, and the plan. bounce asks at startup, after every turn, and on `/quota`.
- **Claude** reports its 5-hour and weekly windows only while a turn runs, in the `rate_limit_event` records of its stream. The last reading is kept, so it stays visible between turns and across restarts.
- **Muse** reports no quota in its protocol, and says so instead of showing a number.

The fallback order in the header carries each agent's short reading, e.g. `claude (5h 42% · 7d 7%) → codex (5h 100% · 7d 16%) → muse`. Readings are stored in `~/.bounce/quota.json`; repeated identical readings do not rewrite the file or redraw the screen. `bounce doctor` prints the same reading beside each CLI version. A reading is a vendor's own percentage at the moment it was reported, and reset times are what the vendor stated, not a prediction of when work will succeed again.

## Local storage

`~/.bounce` (override with `BOUNCE_HOME`). A `~/.localrouter` directory left by the previous name is moved to `~/.bounce` on first launch, keeping existing config, sessions and quota readings:

- `config.json`: order, mode, per-provider models, cooldownMinutes, contextChars, executable overrides, skill scope and auto-sync, `jev` (never its key); in orchestrator mode also `operation`, `orchestrator`, `profiles`, `strategy`, `strict` and `local`.
- `secrets.json` (0600): the TypeSafe API key stored by `/jev key`; `TYPESAFE_API_KEY` in the environment overrides it.
- `agents/<name>.md`: your agent files (the team); a workspace may add its own under `.bounce/agents/`.
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

Tests use fixture processes and temporary directories, without subscription calls. Two checks touch the real OpenCode: `test/opencode-contract.test.js` holds the installed binary to every flag, event name and tool id the adapter relies on (skipped when `opencode` is absent), and `BOUNCE_LIVE_OPENCODE=1 node --test test/local-opencode.live.test.js` runs real turns against LM Studio — run it after upgrading OpenCode or changing how local workers run. The Muse adapter was additionally checked against the installed CLI's offline echo event stream. Live authenticated coding runs and browser login flows require manual integration validation.

Protocol references: [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude programmatic execution](https://code.claude.com/docs/en/headless), and installed `muse exec --help` plus `muse exec --provider echo --no-session-log --json` (verified 2026-09-08).

## Current boundaries

This is a working 0.3 foundation. The TUI is an Ink renderer, not a full terminal emulator: multiline input composition is basic. Task trees are at most two levels deep (a task and its children), and a local orchestrator is not supported. Local workers are LM Studio through OpenCode only; other OpenAI-compatible endpoints are not selectable yet. Claude/Codex messages render as structured events arrive; Muse renders output deltas. Native session resume is used for review rework and for a stalled local worker's conclusion turn inside orchestrator mode (Claude `--resume`, Codex `thread/resume`, OpenCode `-s`, Muse checkpoint re-launch); classic turns still start a fresh process with a handoff. A Jev completion verdict needs a git repository to diff against; outside one the task is accepted as it was before Jev. Checkpoint reviews during a task (Jev judging each milestone) are planned, not built. Semantic long-history compaction and interactive tool approvals are not implemented. Skills are installed as copies rather than being run by bounce: which of them an agent actually loads, and when, stays that agent's decision, and a vendor changing its skill directory or frontmatter needs the table in [Skills](#skills) revisited. Quota is only as good as what each CLI reports: Codex answers on demand, Claude reports during turns, Muse reports nothing. Context is bounded and may omit older decisions; `/note` helps record current handoff details. Raw events preserve unrecognized provider data for adapter updates. Providers can change their flags/event formats, so review adapter fixtures when upgrading them.

## Improve bounce using bounce

After `npm link`, run `bounce dev` from any directory. It opens the actual bounce source directory as the agent workspace. Ask for an improvement, for example:

> Add a /status command showing the current provider, model, routing order, and local cooldowns. Add relevant tests and update the README.

In dev mode, a successful agent turn that changes `src/` or `package.json` triggers `npm run check` and `npm test`. If both pass, a supervisor starts a fresh process and resumes the same journal, workspace, selected provider, model settings, and permission mode. Failed validation keeps the current process running so you can ask the agent to fix the problem. No relink is needed: npm's link already points to these source files.

Use `/restart` in any TUI session to validate and reload manually. A regular launch does not automatically reload. Restart happens between turns, never during a running agent command. Source edits are kept on disk even when checks fail; there is no automatic rollback. Passing tests cannot guarantee the updated app starts successfully; if startup fails, fix the source and use `bounce --resume ID` (IDs are listed by `bounce sessions`). Changes to the supervisor itself require fully quitting and launching again. This reloads local changes; it does not download releases or run Git pulls.
