# Claude Code

## Workers

The five roles are agent files. If `~/.claude/agents/orch-*.md` exist, use them by `subagent_type` and pass no `model` — the file pins model, effort, and tools, and is the contract.

| Role | `subagent_type` | Model | Tools |
|---|---|---|---|
| Scout | `orch-scout` | `haiku` low | Read, Grep, Glob |
| Researcher | `orch-researcher` | `sonnet` medium | + Bash (read-only), WebFetch, WebSearch |
| Builder | `orch-builder` | `sonnet` medium | + Edit, Write, Bash |
| Reviewer | `orch-refuter` | `opus` high | Read, Grep, Glob, Bash |
| Debugger | `orch-debugger` | `opus` high | Read, Grep, Glob, Bash |

### Install the roles once

The five files ship inside this skill, in `agents/` beside `SKILL.md` — `~/.claude/skills/agent-orchestrator/agents/` at user scope, `<workspace>/.claude/skills/agent-orchestrator/agents/` at project scope. Claude Code does not read them from there: agent files are loaded only from `~/.claude/agents`, or `<workspace>/.claude/agents` for that one repository. Nothing installs them for you — a skill carries only itself.

So when the roles are missing, say so before the first delegation and offer to install them:

```sh
mkdir -p ~/.claude/agents && cp -n ~/.claude/skills/agent-orchestrator/agents/orch-*.md ~/.claude/agents/
```

Ask first — this writes outside the workspace — and copy only the files that are absent. An existing `orch-*.md` that differs is the user's, to be reported as a conflict rather than overwritten. Agent files are read when a worker is spawned; if a `subagent_type` is still unknown after the copy, restart the session before relying on the roles.

Until they are installed, use `Explore` for reconnaissance and `general-purpose` with an explicit `model` for everything else, and say which roles are running degraded: with no agent file behind them, the tool restrictions are requests the brief has to carry, not facts the harness enforces.

## Enforcement

- **Tool sets are the enforcement.** A rule in a brief is a request; a missing tool is a fact. Of these roles, only the builder can edit; no role holds the Agent tool.
- If the session has `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` configured, it additionally prevents nested spawns. Do not assume an environment setting is present—roles must still be told not to delegate.
- None of the roles carry `memory`, so a reviewer is cold by construction.
- `subagent_type: "fork"` inherits the parent model and context and ignores the agent file — never use it for a worker role, and never for a reviewer.

## Mechanics

- Worktrees: `isolation: "worktree"` on the Agent call, per builder that earns one. It only covers the session's own repository; for any other repository, create the worktree yourself with `git worktree add` and name its absolute path in the orders.
- Continue a builder across rounds with `SendMessage` to its ID; a new Agent call starts cold — which is what a reviewer needs. A resumed builder runs in the background even if its first run did not: wait for its completion notification before spawning the next reviewer.
- Put task folders at an absolute path outside the builder's working tree — the session scratchpad when one is listed, otherwise a directory you create and name in the brief. A folder inside the tree shows up in the diff the reviewer grades, and a worktree builder cannot reach it by a relative path.
- Codex workers are not spawnable from here. Reaching them means handing the turn over (for example through bounce), not a subagent call.
