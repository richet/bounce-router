---
name: bounce
description: Configure and operate bounce (the `bounce` CLI that runs Claude Code, Codex, Muse and local LM Studio models as one terminal, with an orchestrator mode that dispatches a team of agents). Use when asked to set up bounce for a project (its team of agents, bindings, the orchestrator's model, cloud-only or local models), to start, message, inspect or stop a bounce session from outside it, or to read where a bounce setting lives. Not for working as the orchestrator inside bounce; that is the agent-orchestrator skill.
---

# Operating bounce

bounce wraps the vendor CLIs the user already has signed in: it never holds credentials. Each launch is a
session that runs in a daemon and outlives its view. You drive it from the shell; the user watches in the TUI.

## Read before changing anything

    bounce doctor            # workspace, data dir, mode, provider order, each agent's version and quota
    bounce agents list       # the team in force, its layer, the bindings and models files, each agent's chain
    bounce sessions          # every session; ● marks a live one

Settings live in `~/.bounce/` (or `$BOUNCE_HOME`): `config.json` for the whole machine; `agents/`, `bindings.yml`
and `models.yaml` for the team. A project can carry its own `.bounce/agents/`, `.bounce/bindings.yml` and
`.bounce/skills/`. Almost every change applies to sessions started afterwards: a running session keeps the
roster and settings it started with. Say so when you change one.

Change `config.json` with `/config KEY VALUE` in the TUI where possible: it validates exactly as the loader
does and refuses a bad value without writing. Never put keys or tokens in `config.json`; `bounce jev key` and
the vendor logins keep their own files.

## Two modes

- **classic**: one agent answers each turn; when its subscription runs out, the next signed-in provider in
  `order` takes over with the conversation so far.
- **orchestrator**: the main agent plans and dispatches tasks to the team (analyst, builder, debugger, reviewer)
  and never edits the repository itself. Set by `operation` in `config.json`, or `/operation` (Ctrl+O) in
  the TUI, which restarts the session into it.

## Setting up a project

Team, bindings, orchestrator model, cloud-only and parallel workspaces: follow `references/setup.md`. Key points:

- The team is one layer, whole: a project team replaces the user's entirely, so copy every agent it needs.
- Bindings decide which AI plays each agent; one bindings file is in use, the project's or else the user's.
- The orchestrator's model is the `main` profile in `~/.bounce/config.json`, machine-wide. A `/model`
  pick inside a session overrides it for that session; the session header shows what actually runs.

## Running sessions from outside

    bounce run "prompt" --cwd PATH --detach     # start in the background, print the session id
    bounce send [--session REF] "message"       # message a live orchestrator as if typed; --wait prints the answer
    bounce tasks [--session REF] [--json]       # what each task is doing now
    bounce task TASK [--json]                   # one task: state, milestones, findings, summary
    bounce attach REF [--json]                  # reopen its view; --json streams the journal
    bounce stop REF                             # cancel its task tree and end its daemon
    bounce watch REF [--after N] [--timeout S]  # block until done (0), needs you (2), quiet --idle min (3), timeout (4)
    bounce reserve NAME VALUE --session REF     # hold a shared name (migration 0045, port 5433); --next N takes the first free
    bounce reservations [--session REF]         # what this project's sessions hold; bounce release NAME VALUE gives one back
    bounce prune --ended --older-than 7d --yes  # remove workers' copies of stopped sessions whose task ended (without --yes: list)
    git config bounce.delivery branch            # in a checkout: never write accepted work into it; report the worker's branch to fetch

REF is a session name, id or unique id prefix. With no `--session`, `send` picks the one live session in the
current directory. For tools instead of shell calls, register the control server once:
`claude mcp add bounce-control -- bounce mcp-serve --control` (sessions, status, tasks, task, send, answer, guide).

`watch` replaces polling `tasks`: it prints `--after N` with every return; pass it on the next call so what was
already reported is not reported again. `--idle` defaults to 10 minutes. A detached run is done when its daemon exits.

Two runs on one project share nothing else: before giving each run a migration number, port or database name in its
orders, reserve it for that run's session; a refusal names the session that holds it. The orchestrator reserves its
own the same way and releases them when the task that uses them ends.

Stopping a session or sending into one the user is driving changes their work: confirm first.

## Models, quota and local models

    bounce models            # every model each signed-in agent reports
    bounce quota             # subscription usage per agent
    bounce bindings [update [--save]]   # chains in use; update finds newer releases of the models named
    bounce local [--verify]  # LM Studio, the OpenCode bridge, which agents a local model may play
    bounce local on|off      # let agents use local models, or skip them
    bounce local setup       # interactive: writes models.yaml and bindings.yml; let the user run it

`maxConcurrentCloud` (default 3) caps cloud workers across every session on the machine; local endpoints
have their own `maxConcurrent` and `slotsPerModel`.

## Skills bounce manages

`bounce skills` lists the skills bounce keeps in `~/.bounce/skills` and copies into every agent (`sync`
runs at each launch). Those are for the agents bounce runs. This skill is not one of them: `bounce skill install`
puts it in the agents' own skills folders, and each launch refreshes the installed copy.
A bundled skill such as `agent-orchestrator` is copied into the store only on first run; after a bounce update,
`bounce skills seed --force` brings in its new version.

## When something looks wrong

- The model in the header is not the one in config: an in-session `/model` pick, or a provider fallback
  after a usage limit. Both are journaled; `bounce lineage SESSION` shows which vendor session served each turn.
- A task sits held: `bounce task TASK` gives its reason (`check_failed`, a deadline, a review); the orchestrator is
  woken on outcomes, so a message through `bounce send` is how to nudge it.
- A session shows no ● but the user says it runs: its daemon is gone. `bounce --resume REF` reopens it;
  `/unblock` in the view continues work the old run left behind.
- An agent file or bindings entry is ignored: `bounce agents list` names the source of every chain and any alias
  this machine's `models.yaml` lacks.
