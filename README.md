# bounce-router

[![npm version](https://img.shields.io/npm/v/bouncerouter?logo=npm&color=cb3837)](https://www.npmjs.com/package/bouncerouter)
[![npm downloads](https://img.shields.io/npm/dm/bouncerouter?logo=npm)](https://www.npmjs.com/package/bouncerouter)
[![Node.js 22+](https://img.shields.io/node/v/bouncerouter?logo=node.js&color=339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/github/license/richet/bounce-router?color=blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/richet/bounce-router?style=flat&logo=github)](https://github.com/richet/bounce-router/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/richet/bounce-router?logo=github)](https://github.com/richet/bounce-router/commits/main)

bounce-router is one TUI for your installed Claude Code, Codex and Muse coding agents — and a local LM Studio model through OpenCode — run with the `bounce` command. It uses each CLI's own login, owns the conversation, and carries context between providers: when one subscription runs out, the next signed-in agent picks up where it stopped.

Since 0.2 it also has an **orchestrator mode**: the main agent plans and delegates to a team of agents (analyst, builder, debugger, reviewer), each played by whichever AI fits, while bounce runs the tasks, checks and reviews.

> **In active development.** bounce is in daily use and changes just as often: commands, settings and behaviour can change from one release to the next, sometimes without notice, and this README can lag behind the code. Expect rough edges, and check `bounce --help` when something here does not match.

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

Then, inside bounce:

- `/login claude`, `/login codex`, `/login muse` — sign in. Agents already signed in on this machine need nothing.
- `/model` — pick a model on any signed-in agent.
- `/skills import` — bring an agent's existing skills into bounce, so they work whichever agent answers.

Login briefly hands the terminal to the vendor's own CLI; finish its browser or device flow and you are back. bounce never reads or exchanges credentials. Each CLI's own settings and environment still apply: if you have vendor API keys set, the vendor may prefer them over your subscription.

## Updates

A global install checks for a newer release in the background at startup (set `BOUNCE_NO_UPDATE_CHECK=1` to stop it). Updates are explicit: bounce never installs one by itself. `/update` or `bounce update` installs it and restarts into the same session.

## Commands

**Start and steer work**

| Command | What it does |
| --- | --- |
| `bounce` | Open the TUI in the current folder (`--cwd PATH` for another). |
| `bounce run "prompt"` | Run one prompt headless; `--detach` keeps it going in the background. |
| `bounce send "message"` | Message a live session as if typed there; `--wait` prints the answer. |
| `bounce watch SESSION` | Wait until a session is done or needs you. |
| `bounce stop SESSION` | Cancel its work and end it. |

**Sessions**

| Command | What it does |
| --- | --- |
| `bounce sessions` | List sessions; ● marks a live one. |
| `bounce attach SESSION` | Reopen a live session's view from any terminal. |
| `bounce --resume SESSION` | Continue a session (a name, an id or an id prefix). |
| `bounce rename SESSION NAME` | Name it. |

**Agents, models and quota**

| Command | What it does |
| --- | --- |
| `bounce login PROVIDER` | Sign in to claude, codex or muse. |
| `bounce models` | Every model each signed-in agent offers. |
| `bounce quota` | Subscription usage each agent reports. |
| `bounce agents` | The team: which AI plays each job. |
| `bounce local` | Local models and the OpenCode bridge; `local setup` configures them. |
| `bounce skills` | The skills bounce keeps in sync across agents. |
| `bounce skill install` | Teach your own agents how to run bounce. |

**Housekeeping**

| Command | What it does |
| --- | --- |
| `bounce doctor` | CLI versions and quota; `--fix` installs an OpenCode bounce can drive. |
| `bounce stats [SESSION]` | What a session did: tasks, time, tokens, checks. |
| `bounce prune` | List workers' copies and remove the ones you pick; `--stacks` for leftover Docker stacks. |
| `bounce update` | Install the newest release (`--check` only checks). |

`bounce --help` lists every command with its options.

## In the TUI

- **Enter** sends, **Shift+Enter** adds a line (or Alt+Enter / Ctrl+J in terminals without modern key reporting).
- **`/`** opens the command picker; **Tab** switches agent.
- **Esc** or **Ctrl+C** cancels the running turn; Ctrl+C when idle exits.
- **F2** freezes the screen for copying; **F3** turns off mouse capture for plain text selection.
- **Ctrl+O** switches between classic and orchestrator mode.

| Command | What it does |
| --- | --- |
| `/model`, `/order claude,codex,muse` | Pick a model; set the fallback order. |
| `/mode yolo` / `/mode plan` | Let agents run freely (default), or ask for read-only. Plan mode is each vendor's own restriction, not an approval prompt. |
| `/steer TEXT` | Redirect the agent while it works. |
| `/btw QUESTION` | A quick side question that never touches the running turn. |
| `/config` | Every setting in a panel, validated as you change it. |
| `/quota`, `/sidebar` | Usage per agent; show or hide the right sidebar. |
| `/details` | Show every tool call and output instead of the folded view. |
| `/sessions`, `/resume`, `/rename`, `/detach` | Manage sessions; detach leaves the work running. |
| `/new`, `/retry`, `/note TEXT`, `/help`, `/quit` | The rest. |

Any other `/NAME` runs one of your agents' own commands — a repo's `.claude/commands/NAME.md`, a Codex prompt or a skill — with `$ARGUMENTS` filled in. bounce expands it itself, so a Claude command still works after fallback to Codex; anything inside it that only Claude understands (a subagent, a nested command) still only means something to Claude.

Drop image files into the prompt to attach them (PNG, JPEG, GIF, WebP; up to 10, 5 MiB each). The model must support images. Pasting a bitmap from the clipboard is not supported: save the screenshot and drag the file in. Images are copied into the session first, so a fallback agent gets the same bytes.

`NO_COLOR=1` turns colours off; `TERM=dumb` turns off all styling.

YOLO mode lets agents run commands and change files with your permissions: start bounce in the folder you mean them to work in.

## How fallback works

- Default order is Claude → Codex → Muse; `/order` changes it.
- When an agent hits its usage limit, the turn moves to the next one with a handoff: the request, recent conversation and the git state. A successful fallback sticks for the session.
- An exhausted agent is skipped for 30 minutes (`cooldownMinutes`); `/retry` clears that. This is a local delay, **not** an estimate of when the subscription resets.
- Each provider is tried at most once per turn, and Escape never causes a fallback.
- Other failures — auth, network, a bad model — stop the turn instead of replaying it elsewhere, because the first agent may already have run commands.
- **Switching is not transactional.** An agent that ran out mid-turn may have changed files already; the next one is told to inspect the partial work, and bounce never commits, stashes or rolls anything back.
- The handoff sends the recent conversation and workspace state to the next provider, so whatever was in it reaches that vendor too. Context is bounded and may omit older decisions; `/note TEXT` records what the next agent must know.
- On the same agent, a turn continues its own thread (Claude `--resume`, Codex `exec resume`), so it keeps its context and prompt cache.

## Sessions

Every launch is a session, named after its first prompt until you rename it. Sessions run in a daemon that outlives the view:

- `bounce run "…" --detach` or `/detach` leaves it working in the background.
- `bounce attach` reopens it from any terminal; `bounce send` messages it.
- An agent outside bounce can drive a session through MCP: `claude mcp add bounce-control -- bounce mcp-serve --control`.

## Orchestrator mode

Switch with Ctrl+O or `/operation orchestrator`. The main agent stops editing and starts coordinating: it plans the work, submits tasks to the team, and reports back to you. Every delegation is visible in bounce.

**How a task runs**

1. The orchestrator submits a task to an agent (builder, reviewer, …) with its orders and a `check` — a shell command that proves the work is done.
2. A worker starts in its own copy of the repo and does the work.
3. bounce runs the check, and a review if one was asked for.
4. Work that passes lands in your checkout. Work that fails goes back once, then waits for the orchestrator to decide.
5. The orchestrator is woken with the outcome; it never has to poll.

**What bounce looks after**

- **Big work is split** into phases in sequence and chunks in parallel, each with its own check.
- **Deadlines are leases**, renewed while a worker makes progress; a stuck worker is asked for its conclusion, then stopped.
- **Rework is capped**, and a send-back that names no concrete defect goes to the orchestrator instead of the worker.
- **Machine failures** (a full disk, Docker down, missing git objects) are held with the cause, not sent back as the worker's fault.
- **The machine comes first:** with too little disk or too much load, nothing new starts until it recovers.
- **Workers stand:** a follow-up goes to the worker that knows the code, and lessons from redone work reach the next worker.
- **Nothing is lost:** unfinished work is saved in its copy, and long or forgotten tasks are raised to you.
- **Branch delivery:** with `git config bounce.delivery branch`, work stays on the worker's branch and is never written into your checkout.

**In the TUI:** `/agents` opens a pane per worker, `/tasks` lists them, `/stop [TASK]` cancels, `/msg TASK TEXT` talks to a worker, `/stats` shows what the session cost and got.

**Configuring the team.** bounce ships a roster for every model the vendors offer, so nothing needs configuring. To add or replace one, use a `profiles` block in `~/.bounce/config.json`:

```json
{
  "operation": "orchestrator",
  "profiles": {
    "main":  {"adapter": "claude"},
    "scout": {"adapter": "claude", "model": "haiku", "tier": "cheapest"}
  }
}
```

**Settings worth knowing** (all in `/config`):

| Setting | Default | What it does |
| --- | --- | --- |
| `taskMinutes` / `taskCeilingMinutes` | 15 / 60 | A task's lease, and the most it can be renewed to. |
| `escalateMinutes` | 90 | Raise a task still open after this long. |
| `sweepMinutes` | 20 | Hand the orchestrator waiting work when nothing is running. |
| `idleNudgeMinutes` | 5 | Nudge an orchestrator idle with no tasks while its note names a next step. |
| `checkInMinutes` | 10 | Give the orchestrator a turn when work waits on it and nothing woke it; doubles up to an hour. |
| `gateSlots` | 3 | Checks that may run at once on the machine. |
| `maxConcurrentCloud` | 3 | Cloud workers at once. |
| `minFreeDiskGB` / `maxLoadPerCore` | 30 / 2 | Pause new work below this free disk or above this load. |
| `pruneAfterDays` | 7 | Remove copies of finished work after this long. |
| `verify` | `auto` | Who runs the final gates: `orchestrator`, `worker` or `auto`. |

## Agents and local models

An **agent** is a job written as a markdown file: a short frontmatter and the worker's instructions.

```markdown
---
name: reviewer
description: Reads and probes the integrated tree for defects; never edits.
policy: read-only
---
You are the reviewer. …
```

bounce ships four (`analyst`, `builder`, `debugger`, `reviewer`). A project can bring its own team in `.bounce/agents/`.

Which AI plays each job lives apart from the job, so a team travels between machines:

```yaml
# .bounce/bindings.yml
agents:
  builder: [auto, qwen_coder, claude/sonnet]   # auto lets Jev pick; the rest is the fallback chain
  "*": [auto, codex]
```

**Local models.** Install the `opencode` CLI, start LM Studio's server, and run `bounce local setup`. A local model then plays agents like any cloud AI, at no cost, in your workspace. A writing local agent edits files and runs commands like a cloud worker in YOLO mode, so review its diff the same way; vendor API keys are never passed to it. `bounce local --verify` runs one real turn to check it works.

## Jev routing and verdicts

> **Very experimental.** Jev's routing and verdicts are still being tried out and may change or go away; leave it off unless you want to test it.

Optional. [Jev](https://docs.typesafe.ai) is TypeSafe's decision model. With a key (`/jev key`) and `/jev on`, bounce uses it to:

- **Pick the AI** for each task: the job, then the cost tier the orders need, then the vendor with the most quota left — a loaded local model first.
- **Judge finished work** that has no reviewer: accept it, or send it back once with what is wrong.

Both only act when Jev is confident; otherwise bounce does what it would do without it, and a missing key or an unreachable API just skips Jev. The key lives in `~/.bounce/secrets.json` (0600) and never enters `config.json` or a journal. `/jev` shows the status, `/jev test` makes one live call.

## Skills

Each CLI keeps skills in its own folder, so a skill installed for one agent disappears when the turn falls back to another. bounce keeps one copy of each skill in `~/.bounce/skills` and installs it into every agent.

```sh
bounce skills                       # what bounce manages, and which agents have it
bounce skills import codex          # adopt an agent's skills
bounce skills new deploy-web        # scaffold a new one
bounce skills sync                  # install into every agent
```

A project's own skills live in `.bounce/skills/` and replace yours while you work there. bounce marks every copy it installs and only ever updates or removes those, so a skill a vendor shipped or you installed yourself is never overwritten.

| Agent | Your skills | A project's skills |
| --- | --- | --- |
| Claude | `~/.claude/skills` | `<repo>/.claude/skills` |
| Codex | `~/.codex/skills` | `<repo>/.codex/skills` |
| Muse | `~/.agents/skills` | `<repo>/.agents/skills` |

Project scope writes into the repository you are working in, so commit or ignore those folders deliberately. Symbolic links inside a skill are not copied, so an installed skill cannot reach outside itself. `bounce skills reset` empties bounce's own store and cannot be undone, so it only acts with `--force`. bounce seeds its own `agent-orchestrator` skill once; if you delete it, it stays gone until `bounce skills seed --force`.

Skills are the only thing bounce carries across providers. `CLAUDE.md`, `AGENTS.md` and each vendor's own configuration stay that vendor's business.

## Quota

`/quota` or `bounce quota` shows the usage each agent reports about itself — nothing is estimated.

- **Codex** reports its 5-hour and weekly windows on request.
- **Claude** reports them while a turn runs; the last reading is kept.
- **Muse** reports none.

The sidebar shows each window with its reset time, and this session's own token use per model. A reading is the vendor's own percentage at the moment it reported it, and a reset time is what the vendor said: neither is a prediction of when work will succeed again.

## Where things live

Everything is under `~/.bounce` (or `BOUNCE_HOME`), owner-only:

| Path | What |
| --- | --- |
| `config.json` | Your settings; only what you changed. |
| `secrets.json` | The Jev key, if you stored one. |
| `agents/`, `skills/` | Your team and your skills. |
| `sessions/<id>/journal.jsonl` | Every event of a session. |
| `quota.json` | The last usage reading each agent reported. |
| `sessions/<id>/handoff.txt` | The latest prompt handed to another provider. |
| `sessions/<id>/orchestrator/ORDERS.md` | The orchestrator's standing brief. |
| `sessions/<id>/daemon.json`, `bus.sock` | The live daemon and its session bus. |
| `w/` | Workers' copies of your repositories. |

Journals hold prompts and tool output, which can include sensitive project content; delete a session's folder (while it is not running) to remove it. Each vendor's own history stays under that vendor's control.

## Development

```sh
npm install
npm test
npm run check
```

Tests use fixture processes and temporary folders, never a subscription. Live sign-in and real coding runs still need checking by hand, and a vendor changing its flags or events means the adapter fixtures need a look when you upgrade a CLI.

**Writing this README.** Keep it short and easy to scan: what each thing is for, why it works that way when that is not obvious, and what to watch out for — in a sentence, a list or a table. A new feature gets a line where it belongs. Details live in `--help`, the bounce skill and the commit history.

## Current boundaries

- The TUI is an Ink renderer, not a terminal emulator.
- Task trees are two levels deep, and the orchestrator must be a cloud agent.
- Local models run through LM Studio and OpenCode only.
- Quota is only what each CLI reports.
- Providers change their flags and event formats; adapters may need updating when you upgrade a CLI.

## Improve bounce using bounce

After `npm link`, run `bounce dev` from any directory. It opens bounce's own source as the workspace. Ask for an improvement, for example:

> Add a /status command showing the current provider, model, routing order, and local cooldowns. Add relevant tests and update the README.

When a turn changes `src/` or `package.json`, bounce runs `npm run check` and `npm test`. If both pass, it restarts on the new code and resumes the same session; if not, the current process keeps running so you can ask the agent to fix it.
