# Codex

## Workers

Check the models this session can spawn before routing. The local `$CODEX_HOME/models_cache.json` is useful evidence, but the active harness is authoritative. Its 2026-09-16 cache lists:

| Model | Tier | Best fit | Don't make it sole owner of |
|---|---|---|---|
| `gpt-5.6-luna` | Cheapest | Locating files, extracting structured facts, narrow test triage, disjoint parallel searches | Design decisions, ambiguous diagnosis, changes needing broad judgment |
| `gpt-5.6-terra` | Mid → strongest | Default for implementation, research, review, and debugging; raise reasoning effort (`high`/`xhigh`/`max`) for the strongest tier instead of switching model | Mechanical work a cheaper worker handles reliably |
| `gpt-5.5` | Second opinion | A deliberate independent check where its behaviour is known to be useful | New work by default |

Avoid `ultra` effort for a worker: it delegates automatically and turns a bounded worker into an unbounded orchestrator.

## Enforcement

No per-role agent files are configured here (`$CODEX_HOME` has no agents directory as of 2026-09-16). Tool and edit restrictions travel in the brief, so state authority explicitly, and verify afterwards (`git status`, `git diff`) that a read-only worker changed nothing.

## Mechanics

- A worker can inspect, edit, run commands, and report evidence in one task, which suits bounded coding work.
- Give a reviewer a fresh worker, never the builder's thread.
- Claude workers are not spawnable from here. Reaching them means handing the turn over (for example through bounce), not a subagent call.
