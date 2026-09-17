# Claude Code

## Workers

If `~/.claude/agents/orch-*.md` exist, use them by `subagent_type` and pass no `model` — the file pins model, effort, and tools, and is the contract.

| Role | `subagent_type` | Model | Tools |
|---|---|---|---|
| Scout | `orch-scout` | `haiku` low | Read, Grep, Glob |
| Researcher | `orch-researcher` | `sonnet` medium | + Bash (read-only), WebFetch, WebSearch |
| Builder | `orch-builder` | `sonnet` medium | + Edit, Write, Bash |
| Reviewer | `orch-refuter` | `opus` high | Read, Grep, Glob, Bash |
| Debugger | `orch-debugger` | `opus` high | Read, Grep, Glob, Bash |

If they are missing, use `Explore` for reconnaissance and `general-purpose` with an explicit `model` for everything else; the brief then has to carry the tool restrictions as instructions.

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
