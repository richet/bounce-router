// Phase 8 — pluggable orchestration strategy (CONTRACT.md, docs/local-orchestration.md
// "Phase 8"). A strategy is a plain object of pure, synchronous decision functions the
// scheduler (CORE) calls at fixed points; each hook returns a declared intent the CORE
// executes. Strategies never journal, launch, or touch budgets directly — see CONTRACT §0.
//
// `defaultStrategy` reproduces Phase 3–7's inline reaction policy exactly (the decisive
// self-host proof, CONTRACT §2). `noReviewStrategy` and `quorumStrategy(n)` are Tier 1
// presets over the same hooks (CONTRACT §3).

// Only these dependency states fail a dependent outright (mirrors scheduler.js's own
// DEPENDENCY_FAIL_STATES) — `completed` (no reviewer yet accepted) and `reviewing` hold the
// dependent until `task.accepted`, they never fail it.
const DEPENDENCY_FAIL_STATES = new Set(['failed', 'cancelled', 'timed_out', 'rejected']);

// Shared by every stock strategy's onSubmitted: a depends_on member that has actually failed
// fails this task outright; one merely not yet accepted holds it; no depends_on at all (or
// all accepted) falls through to the caller's own review/dispatch decision.
function dependsOnIntent(row, view, api) {
  const deps = row?.depends_on ?? [];
  if (!deps.length) return null;
  const stateOf = id => api?.dependencyState ? api.dependencyState(id) : view[id]?.state;
  const badDep = deps.find(id => DEPENDENCY_FAIL_STATES.has(stateOf(id)));
  if (badDep) return {action: 'fail', reason: 'dependency', text: badDep};
  if (!deps.every(id => stateOf(id) === 'accepted')) return 'hold';
  return null;
}

const reviewersFor = spec => Array.isArray(spec) ? spec : [spec];

// CONTRACT.md §2 — byte-identical to Phase 3–7 (the decisive self-host, S1). Single reviewer,
// quorum 1, prelaunch never reworks (any non-accept/non-unreadable verdict rejects), completion
// reworks bounded by the root's own rounds allowance (or the scheduler's limits.rounds default).
const sameFindings = (a = [], b = []) => a.length > 0 && a.length === b.length && [...a].sort().every((f, i) => f === [...b].sort()[i]);

export const defaultStrategy = {
  onSubmitted(task, view, api) {
    const row = api.submittedRow(task);
    const held = dependsOnIntent(row, view, api);
    if (held) return held;
    if (row?.review?.prelaunch) return {action: 'review', stage: 'prelaunch', reviewers: reviewersFor(row.review.prelaunch), quorum: 1};
    return 'dispatch';
  },
  onCompleted(task, view, api) {
    const row = api.submittedRow(task);
    if (row?.review?.completion) return {action: 'review', stage: 'completion', reviewers: reviewersFor(row.review.completion), quorum: 1};
    return 'none';
  },
  onReviewVerdict(task, verdicts, view, api) {
    const v = verdicts[0];
    if (v.verdict === 'accept') return {action: 'accept'};
    // An unreadable verdict from a reviewer that RAN used to block the task, which needs a human. Found
    // live: the reviewer hit its step cap, its notice failed to parse, and the task sat
    // blocked. That fails instead, so the orchestrator is woken by an outcome and decides. A review that
    // never produced anything — launch failed, cancelled, or still before any worker ran (prelaunch) — is
    // an infrastructure problem, not a verdict, and still escalates exactly as before.
    if (v.verdict === 'unreadable') {
      if (v.launchFailed || v.cancelled || view[task]?.state === 'queued') return {action: 'escalate', reason: 'review', text: 'unreadable review verdict'};
      // A reviewer that answered in prose is asked once for the verdict line alone; twice unreadable is
      // the reviewer's answer, and the task fails with it rather than waiting for a person.
      if (!api.reAsked?.(task)) return {action: 'rereview', text: 'Your last answer carried no readable verdict. Answer again with the verdict line only, as JSON.'};
      return {action: 'fail', reason: 'review_unreadable', text: 'the reviewer returned no readable verdict'};
    }
    // Prelaunch (state still 'queued' at the moment the verdict is decided) never reworks:
    // any other verdict string is a rejection, same as today.
    if (view[task]?.state === 'queued') return {action: 'reject', questions: v.questions ?? v.findings ?? []};
    const findings = v.findings ?? v.questions ?? [];
    // A rework for the SAME findings as the previous round is evidence the worker cannot satisfy
    // them (observed live: a correct change sent back three times on the same five checks). The
    // decision goes to the orchestrator instead of a further identical round.
    const previous = api.lastRework?.(task);
    if (previous && sameFindings(previous.findings, findings)) {
      const checks = api.lastFired?.(task);
      return {action: 'escalate', reason: 'repeated_findings', findings, text: `Sent back twice for the same findings${checks?.length ? ` (${checks.join(', ')})` : ''}; the worker cannot satisfy them. Accept, resubmit with different orders, or cancel.`};
    }
    if (api.roundsUsed(task) < api.roundsCap(task)) return {action: 'rework', findings};
    return {action: 'escalate', reason: 'rounds', findings};
  },
  onTerminal() { return {submit: []}; },
};

// CONTRACT.md §3 — a completion (or prelaunch) review in the row's config is never launched;
// every completed task is accepted by the strategy itself, with no reviewer in the loop.
export const noReviewStrategy = {
  onSubmitted(task, view, api) {
    const row = api.submittedRow(task);
    const held = dependsOnIntent(row, view, api);
    if (held) return held;
    return 'dispatch'; // a configured review.prelaunch is ignored: never gate the launch
  },
  onCompleted() { return {action: 'accept'}; },
  onReviewVerdict() { return {action: 'accept'}; }, // unreachable: no review ever runs
  onTerminal() { return {submit: []}; },
};

// CONTRACT.md §3 — n reviewers must accept before task.accepted; any reject routes to
// reject/rework as today, a reject taking precedence over a rework among the reported verdicts.
export function quorumStrategy(n) {
  return {
    onSubmitted(task, view, api) {
      const row = api.submittedRow(task);
      const held = dependsOnIntent(row, view, api);
      if (held) return held;
      if (row?.review?.prelaunch) return {action: 'review', stage: 'prelaunch', reviewers: reviewersFor(row.review.prelaunch), quorum: n};
      return 'dispatch';
    },
    onCompleted(task, view, api) {
      const row = api.submittedRow(task);
      if (row?.review?.completion) return {action: 'review', stage: 'completion', reviewers: reviewersFor(row.review.completion), quorum: n};
      return 'none';
    },
    onReviewVerdict(task, verdicts, view, api) {
      const accepts = verdicts.filter(v => v.verdict === 'accept').length;
      if (accepts >= n) return {action: 'accept'};
      const rejects = verdicts.filter(v => v.verdict === 'reject');
      if (rejects.length) return {action: 'reject', questions: rejects.flatMap(v => v.questions ?? v.findings ?? [])};
      const reworks = verdicts.filter(v => v.verdict === 'rework');
      if (reworks.length) {
        const findings = reworks.flatMap(v => v.findings ?? v.questions ?? []);
        if (api.roundsUsed(task) < api.roundsCap(task)) return {action: 'rework', findings};
        return {action: 'escalate', reason: 'rounds', findings};
      }
      // Every reviewer reported (the CORE waits for all, CONTRACT §5); none rejected or
      // reworked, but quorum still unmet (e.g. mixed accept/unreadable short of n accepts).
      return {action: 'escalate', reason: 'quorum'};
    },
    onTerminal() { return {submit: []}; },
  };
}
