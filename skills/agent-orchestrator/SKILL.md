---
name: agent-orchestrator
description: Coordinate decomposable work across whichever workers the active harness can actually reach — bounce worker profiles, Claude Code subagents, or Codex workers — choosing by task, capability, and cost rather than vendor. Use only when the user explicitly asks to delegate, orchestrate, use workers or subagents, or save their limit, or when you are a bounce orchestrator (BOUNCE_BUS is set / an ORDERS.md was handed to you). Do not trigger on the shape of the task alone — a multi-step change, research or a review is done directly unless delegation was asked for.
---

# Agent orchestrator

You own the plan, the judgment calls, integration, and talking to the user. Delegate to buy parallelism, context relief, or independence — not to make simple work ceremonial.

**Read the harness reference first**, for the one you are actually in:

- `references/bounce.md` — you are a bounce orchestrator if `BOUNCE_BUS` is set in your environment, or a session ORDERS.md was handed to you. Read this one **only**: your own subagent tools are switched off, workers exist as profiles, and the vendor references below describe a *worker's* harness, not yours.
- `references/claude-code.md` — a plain Claude Code session.
- `references/codex.md` — a plain Codex session.

They name the workers that exist there, how to constrain them, and any one-time setup those workers need. Never design a workflow around a worker this session cannot reach.

## Decide whether to delegate

Do it yourself: a short edit, a single grep, a file whose path you know, a sequential task with shared live state, a call that needs the whole conversation, or when the brief would cost more than the work.

Delegate: reading you don't need to keep, sweeping a codebase, independent questions that can run at once, a diff from a spec you can already write, or a review that must not share the builder's reasoning.

Where the harness forbids you to edit at all — bounce does — the first bullet stops applying to code and starts applying only to your own reading. A dispatch that fails is reported, never worked around by doing it yourself.

## Pick the worker

The top model does not spawn copies of itself for work a cheaper worker can do reliably. Pick the least expensive worker that can make the judgment the task requires, and promote when it can't:

| Work | Tier | Why it is safe there |
|---|---|---|
| Locate files, symbols, call sites; extract structured facts | Cheapest | Output is paths and facts the next reader opens — a wrong one fails loudly |
| Research, routine implementation, test triage | Mid | Judgment is bounded by a spec and a test suite |
| Independent review, ambiguous or cross-cutting debugging, security-sensitive calls | Strongest | Failure here is quiet: a wrong verdict looks exactly like a right one |

Tiers are dials, the per-role contract is not. The moment a cheap role must judge unstructured material, promote it.

Where the roster is fixed for you — bounce hands you named profiles with adapters, models and roles — map the tier onto the roster you were given rather than asking for a worker that is not in it. A read-only role is never escalated to get a task done: work that needs writes goes to a writing profile or is refused.

When a real choice exists between providers for a substantial workstream, run one small read-only trial against the same acceptance criteria and route the rest by the result, not by brand. Don't invent a comparison you haven't run.

## Write the brief

Every brief states:

1. **Goal** — one observable outcome, not a topic.
2. **Scope** — exact files, paths, or questions in bounds; one writer per file.
3. **Authority** — read-only, or exactly what it may edit; forbidden side effects (no commits unless stated, no new dependencies, no adjacent refactors, no spawning further workers).
4. **Verification** — the commands it must run, or why none can run. Name the project's own test and style rules instead of assuming it finds them.
5. **Report shape and cap** — e.g. "under ~1.5k tokens: `path:line` refs, commands with results, open risks; never paste file bodies or whole diffs". "Keep it short" is not a cap.
6. **Known context** — what you already know, so it isn't rediscovered.

Close with: *if you cannot finish within scope, stop and report why instead of expanding it.*

Put a one-shot brief wherever the harness takes it — the spawn call, or bounce's `orders` field. For multi-round work, write it to `ORDERS.md` in a task folder: the builder reads it and never edits it, because the reviewer grades against it.

## Patterns

**Reconnaissance.** Fan out read-only, disjoint questions at once. Brief a cheap scout as a search tool with no judgment: one thing to find, exact paths back. Verify any result that changes the plan.

**Build.** One builder owns the change and runs the checks. Batch related fixes into one brief so the same large files aren't reread by several workers.

**Independent review.** A fresh reviewer sees three things: the orders, the actual diff, and test output it produced itself. Never the builder's summary or transcript — a summary rounds in the builder's favour, a transcript carries every doubt the builder talked itself out of. It returns `ACCEPT` or `REWORK` with must-fixes and does not fix them. Most of what an isolated reviewer catches is sloppy scope; a `REWORK` is as often a reason to fix the orders as the diff.

**Debugging.** Give a strong worker the failure, the reproduction, and the evidence; it returns cause plus proof, not a patch. Use it once a straightforward attempt has failed.

**Ticket loop** (multi-file or multi-round): use a task folder with `ORDERS.md`, a `CHANGES.md` log, and each round's verdict; ticket goes `OPEN → DONE → ACCEPTED`, back to `OPEN` on rework. The orders must say whether worktrees, commits, or a PR are authorized.

1. Isolate the builder in its own worktree and branch when the harness supports it.
2. Build, run the suite in that tree, leave the change in the state the orders require (working tree, commit, or PR), and log to `CHANGES.md`. Deviations flagged, not buried.
3. Review with a **new** reviewer every round; retire it after its verdict.
4. Rework goes back to the **same** builder, context intact.
5. Integrate and run the full suite behind the merge; a red suite reverts rather than being patched forward. Where direct commits to the main branch are forbidden, integrating means opening the PR.
6. Clean up the worktree and branch.

Reviewers are always cold and new, or they grade their own expectations. Builders persist, or you pay for the same context twice.

## Integrate

A report is evidence, not proof, and so is a terminal row: `task.completed` says a worker believed it was done. Check that it answered the brief, open the actual diff or artifact, and rerun high-risk verification yourself — "tests passed" in a report is a claim.

- **The diff must be the whole change.** Review the specified revision *and* its staged and unstaged working-tree changes. A clean tree is required only when the orders require a commit; otherwise unexpected files or changes are a `REWORK`.
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
