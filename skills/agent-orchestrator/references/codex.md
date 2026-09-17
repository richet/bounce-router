# Codex

## Workers

Check the models this session can spawn before routing. The local `$CODEX_HOME/models_cache.json` is useful evidence, but the active harness is authoritative. Its 2026-09-16 cache lists:

| Model | Tier | Best fit | Don't make it sole owner of |
|---|---|---|---|
| `gpt-5.6-luna` | Cheapest | Locating files, extracting structured facts, narrow test triage, disjoint parallel searches | Design decisions, ambiguous diagnosis, changes needing broad judgment |
| `gpt-5.6-terra` | Mid → strongest | Default for implementation, research, review, and debugging; raise reasoning effort (`high`/`xhigh`/`max`) for the strongest tier instead of switching model | Mechanical work a cheaper worker handles reliably |
| `gpt-5.5` | Second opinion | A deliberate independent check where its behaviour is known to be useful | New work by default |

Avoid `ultra` effort for a worker: it delegates automatically and turns a bounded worker into an unbounded orchestrator.

## Install the roles once

The skill carries five Codex custom agents in `agents/orch-*.toml` beside `SKILL.md`: scout, researcher, builder, refuter, and debugger. The scout uses Luna with low effort; researcher and builder use Terra with medium effort; refuter and debugger use Terra with high effort. Check those models are available in the active harness before relying on them.

Codex discovers standalone TOML agents in `~/.codex/agents/` (or `$CODEX_HOME/agents/` with a custom home), and `<workspace>/.codex/agents/` for project scope. Syncing this skill carries the files but does not activate them.

Before the first delegation, check whether the named roles are available. If missing, offer to copy the files into the chosen agent directory. For a user-scope skill:

```sh
codex_role_home="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$codex_role_home/agents"
cp -n "$codex_role_home/skills/agent-orchestrator/agents/"orch-*.toml "$codex_role_home/agents/"
```

For project scope, copy from `<workspace>/.codex/skills/agent-orchestrator/agents/` into `<workspace>/.codex/agents/`. Inspect existing files first: identical files need no action; differing files are conflicts to report, never overwrite. Obtain approval for installation unless already authorized. Do not replace the user's `config.toml`. If roles remain unavailable after copying, start a fresh session and check again.

Use the named custom role when the active spawn tool supports it. If the harness cannot select custom roles, read the corresponding TOML and carry its developer instructions, model, and effort into the brief using the available spawn parameters. State that this is a fallback: copying a role's instructions does not load its configuration.

## Enforcement

Scout, researcher, refuter, and debugger declare `sandbox_mode = "read-only"`. Builder inherits the parent sandbox and is the only role allowed to edit within the brief. All five prohibit further delegation.

A role file is not a tool allowlist. Parent runtime permission overrides can supersede its sandbox setting, and connected tools can affect remote state. Check the actual worker permissions, keep the no-write instructions in the brief, and inspect `git status` / `git diff` afterwards. If read-only verification requires writable test artifacts, report that limitation and route the command to a writing worker; never silently broaden the reader's authority.

Format and permission behavior: [official Codex subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Mechanics

- A worker can inspect, edit, run commands, and report evidence in one task, which suits bounded coding work.
- Give a reviewer a fresh worker, never the builder's thread.
- Claude workers are not spawnable from here. Reaching them means handing the turn over (for example through bounce), not a subagent call.
