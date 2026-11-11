# Driving a session from outside

For a controlling agent (bounce-control tools or the `bounce` CLI) that runs a session for the user.

## Tune the team per project

The project's `.bounce/agents/*.md`, `.bounce/bindings.yml` and `.bounce/skills/` are where a team is tuned for one
project: what a builder runs and commits, what a reviewer must show before a `FAIL`, which stacks a worker takes
down. Put project rules there, not in the orchestrator's memory or in every order. They load when a session
starts, so a running session keeps the old ones. A project team replaces the user's team as a whole, so copy every
agent the project uses. These files are often kept out of git (`.git/info/exclude`); `git check-ignore -v
.bounce/agents/builder.md` says whether they are.

Example: lines added to a project's `.bounce/agents/builder.md` body:

    Commit on your own branch in your copy: one plain line, the repo's prefix, no attribution.
    Run only the tests you touched plus `make lint`; the gate runs the full suite.
    Take down any stack you started in your copy, with its volumes, before you finish.

and to `.bounce/agents/reviewer.md`:

    A FAIL or rework names a concrete defect: file:line and the behaviour that fails. "Verify independently" is not one.

## Delivery modes

`git config --get bounce.delivery` in the checkout:

- unset or `checkout`: accepted work is written into the user's checkout. The worker may leave it uncommitted.
- `branch`: accepted work never touches the checkout. The worker commits on its own branch in its copy and leaves a
  clean tree; uncommitted work is held as `delivery_uncommitted`. The outcome names the copy path, branch and head;
  the user gets it with `git fetch <copy path> <branch>`.

Under either mode, orders forbid commits on the user's own branches (main/master, the default, the branch they have
checked out), never commits in general. A "don't commit" from the user means that, plus no push.

## What a worker's copy holds

A writer's copy is a light clone of the checkout: tracked files and uncommitted changes. A nested repository with
its own `.git` (a `docs/` that is a separate repo) and anything git ignores are not in it, except what
`.bounce/copy-include` lists. Orders that need such a path give it as an absolute, read-only path in the user's
checkout.

## Blocked is usually held, not failed

`status` lists blocked tasks under "Waiting on a decision". Most are finished work kept for the orchestrator.
Accepting, reworking or cancelling a task is the orchestrator's call: from outside, send the orchestrator a
message (`send`) naming the task and what to do, never write to the session's files.

| reason | means | what the controller does |
|---|---|---|
| `unverified` | the work changed files and no check ran it; kept in the copy | ask the orchestrator to check and accept, or send it back |
| `check_failed` | the task's check failed again after one return to the worker | ask for the failure output and a debugger or a rework with it |
| `check_unrunnable` | the check could not run (missing tool, stack down) | fix the environment or the check, then ask for a rerun |
| `review`, `review_not_accepted`, `review_uncertain` | the reviewer did not accept | read the verdict (`task`, full); if it names no defect, ask the orchestrator to decide or send a concrete one |
| `review_no_defect` | the review asked for rework without naming a defect, so the worker was not sent back | ask the orchestrator to accept with what it checked, or send it back naming a defect |
| `review_unavailable`, `review_unreadable` | no usable verdict came back | ask the orchestrator to review it itself or redispatch the review |
| `worker_blocked` | the worker stopped for a decision, access or a wrong goal | read its text; answer it through the orchestrator |
| `delivery_uncommitted`, `delivery_detached`, `delivery_no_copy` | branch delivery refused the work | have the worker commit on its branch (rework), or see the copy |
| `integration_*` | writing into the checkout failed (conflict, settings) | the copy is kept; ask the orchestrator to reconcile |
| `termination_unverified`, `orphaned` | a worker from a previous daemon may still run | check the process before anything is resubmitted |
| `deadline` | the task's deadline passed and it was cancelled | ask for what it reached and a smaller resubmission |

## Reading results through bounce-control

- `status` first: orchestrator state, its note, live tasks, what waits, quota. `lastAnswer` there is cut at
  1200 characters.
- `send` returns a request id; `answer` with `request: <id>` (not `request_id`) gives the whole answer, and with
  `wait_seconds` waits for a turn that is still running.
- `task` with `full: true` adds the orders, the whole report and the verdict. Its milestones say where a task is
  ("Waiting for a cloud slot: 3 of 3 in use", a check running, a review).
- What the orchestrator says is its claim; check the task record before reporting it to the user as done.

## Throughput

- `maxConcurrentCloud` in `~/.bounce/config.json` caps cloud workers across every session on the machine. A
  "Waiting for a cloud slot: N of N in use" milestone means that cap, not a slow worker.
- A check on every task costs a full gate per task; for a batch of small fixes, one gate at the end (a final task,
  or the orchestrator's) is usually faster.
- Under branch delivery, a batch whose tasks build on each other can share one batch branch, named in every order,
  so the end of the batch is not a reassembly of separate branches.

Measure before naming a cause. A session's record is `~/.bounce/sessions/<id>/journal.jsonl`: one JSON row per event
with `time`, `kind` and `task`. The gaps between a task's `task.launch.requested`, `task.started`, its
`task.milestone` rows, `task.check`, `review.started` / `review.finished`, `task.rework` and `task.integrated` or
`task.delivered` show where its time went:

    jq -r 'select(.task | startswith("<task id prefix>")) | [.time, .kind, (.text // "")[0:80]] | @tsv' journal.jsonl

## Quota

`status` and `bounce quota` show each provider's use of its windows. `auto` routing plans to use a weekly window
only up to its ceiling, set as `quota.ceiling` in `~/.bounce/config.json` (one percent, or one per provider);
a provider over its ceiling is picked only after those under it. Without a ceiling the whole window counts.

## Docker hygiene

A stack a worker starts in its copy (any Docker Compose project whose compose file is in the copy) is taken down,
with its volumes and networks, when its task ends: accepted, failed, cancelled, timed out or rejected. The task's
record says so (`stacks_down`), or names what is still up (`stacks_left`). `bounce prune` does the same before it
removes a copy, and keeps the copy when that fails. For stacks already left behind:

    bounce prune --stacks          # stacks in copies whose task is not running, including copies already removed
    bounce prune --stacks --yes    # take them down with their volumes and networks

Volumes go with them: confirm with the user before `--yes`. `docker network prune` removes every unused network on
the machine, not only bounce's: confirm first too.

## Long tasks

A task still open `escalateMinutes` after it was submitted (config.json, default 90, 0 off; waits, reviews and rework
included) is put to the orchestrator once, between its turns, to tell the user what the task is doing and what blocks
it. The task's record carries a `task.overtime` row.
