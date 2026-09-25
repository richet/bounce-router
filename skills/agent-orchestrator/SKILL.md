---
name: agent-orchestrator
description: Coordinate decomposable work as a bounce orchestrator — dispatching the team's agents (analyst, builder, debugger, reviewer) through the bounce bridge and choosing by job, not by vendor. Use when you are a bounce orchestrator (BOUNCE_BUS is set / an ORDERS.md was handed to you).
---

# Agent orchestrator

You own the plan, the judgment calls, integration, and talking to the user. Delegate to buy parallelism, context relief, or independence — not to make simple work ceremonial.

**Read `references/bounce.md` first**: how to submit, wait, steer and read outcomes through the bridge. Your own subagent tools are switched off; workers exist only as the team's agents.

**The team** is defined once, in `team/*.md` — one file per job, harness-agnostic: frontmatter says what bounce routes on (`policy`, `models`), the body is the worker's instructions. Which AI plays an agent is bounce's call (`models:`, Jev routing, provider order), never the file's. `references/team.md` says how to specialise it. Never design a workflow around an agent the roster in your ORDERS.md does not list.

## Decide whether to delegate

Do it yourself: a short edit, a single grep, a file whose path you know, a sequential task with shared live state, a call that needs the whole conversation, or when the brief would cost more than the work.

Delegate: reading you don't need to keep, sweeping a codebase, independent questions that can run at once, a diff from a spec you can already write, or a review that must not share the builder's reasoning.

You never edit the repository, so the first bullet applies only to your own reading. A dispatch that fails is reported, never worked around by doing it yourself.

## Pick the worker

Submit by job — `analyst` to locate, read and research, `builder` to implement (including landing shared changes behind the full gate — say so in its orders), `reviewer` to grade, `debugger` once a failure resisted a first attempt — and let bounce pick the AI; your orders say not to pick a tier or a model yourself. A read-only or probing agent is never escalated to get a task done: work that needs writes goes to a writing agent or is refused.

## Write the brief

Every brief states:

1. **Goal** — one observable outcome, not a topic.
2. **Scope** — exact files, paths, or questions in bounds; one writer per file.
3. **Authority** — read-only, or exactly what it may edit; forbidden side effects (no commits unless stated, no new dependencies, no adjacent refactors, no spawning further workers).
4. **Verification** — the commands it must run, or why none can run. Name the project's own test and style rules instead of assuming it finds them.
5. **Report shape and cap** — e.g. "under ~1.5k tokens: `path:line` refs, commands with results, open risks; never paste file bodies or whole diffs". "Keep it short" is not a cap.
6. **Known context** — what you already know, so it isn't rediscovered.

Close with: *if you cannot finish within scope, stop and report why instead of expanding it.*

Put a one-shot brief in the task's `orders` field; multi-round work resubmits through bounce's own rework cycle (task.rework), not a hand-maintained file.

## Patterns

**Reconnaissance.** Fan out read-only, disjoint questions at once. Brief a cheap scout as a search tool with no judgment: one thing to find, exact paths back. Verify any result that changes the plan.

**Build.** One builder owns the change and runs the checks. Batch related fixes into one brief so the same large files aren't reread by several workers.

**Independent review.** A fresh reviewer sees three things: the orders, the actual diff, and test output it produced itself. Never the builder's summary or transcript — a summary rounds in the builder's favour, a transcript carries every doubt the builder talked itself out of. It returns `PASS` or `FAIL` with must-fixes and does not fix them. Most of what an isolated reviewer catches is sloppy scope; a `FAIL` is as often a reason to fix the orders as the diff.

**Debugging.** Give a strong worker the failure, the reproduction, and the evidence; it returns cause plus proof, not a patch. Use it once a straightforward attempt has failed.

## Integrate

A report is evidence, not proof, and so is a terminal row: `task.completed` says a worker believed it was done. Check that it answered the brief, open the actual diff or artifact, and rerun high-risk verification yourself — "tests passed" in a report is a claim.

- **The diff must be the whole change.** Review the specified revision *and* its staged and unstaged working-tree changes. A clean tree is required only when the orders require a commit; otherwise unexpected files or changes are a `FAIL`.
- **A rate limit mid-wave is a wave failure.** Siblings can report "complete" with nothing in them. Check each produced real output before using any of it.
- Resolve conflicting reports from primary evidence, not by majority.

## Limits

- Probe once before fanning out: one representative read catches a denied path or wrong layout before it fails the whole wave.
- One writer per file. Never run concurrent workers against the same browser or live state.
- Cap fan-out at the number of genuinely independent workstreams. Don't delegate to use up capacity.
- Stop a worker that drifts off its brief; ignore the out-of-scope part and re-brief tighter.
- Watch for fix-bouncing: check `CHANGES.md` before changing anything a second time. If rounds undo each other, halt and reconcile it yourself.
- Silence is not a crash. Inspect the worker's latest reported state before concluding anything about it.
- Keep large output in the task folder; workers return the path and a summary.
