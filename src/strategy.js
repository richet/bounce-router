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
    if (v.verdict === 'unreadable') return {action: 'escalate', reason: 'review', text: 'unreadable review verdict'};
    // Prelaunch (state still 'queued' at the moment the verdict is decided) never reworks:
    // any other verdict string is a rejection, same as today.
    if (view[task]?.state === 'queued') return {action: 'reject', questions: v.questions ?? v.findings ?? []};
    const findings = v.findings ?? v.questions ?? [];
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
