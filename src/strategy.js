// Phase 8 — pluggable orchestration strategy (CONTRACT.md, docs/local-orchestration.md
// "Phase 8"). A strategy is a plain object of pure, synchronous decision functions the
// scheduler (CORE) calls at fixed points; each hook returns a declared intent the CORE
// executes. Strategies never journal, launch, or touch budgets directly — see CONTRACT §0.
//
// `defaultStrategy` reproduces Phase 3–7's inline reaction policy exactly (the decisive
// self-host proof, CONTRACT §2). `noReviewStrategy` and `quorumStrategy(n)` are Tier 1
// presets over the same hooks (CONTRACT §3).
import {checkFinding, checkStillFails, checkCouldNotRun, heldForAccept} from './command-output.js';

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

// Finished work reaches the checkout by itself only when a check that runs it has passed. Work that
// changed files and has no such check is kept in the worker's copy and handed to the orchestrator,
// with what the review said of it (`said`), to accept, send back or retry.
function acceptOrHold(task, api, {advice = null, said = ''} = {}) {
  if (!api.unverifiedChanges?.(task)) return advice ? {action: 'accept', advice} : {action: 'accept'};
  return {action: 'escalate', reason: 'unverified',
    text: heldForAccept({check: api.checkOf?.(task), byBounce: Boolean(api.reportByBounce?.(task)), said: said || advice || '', copy: api.copyOf?.(task) ?? null})};
}
const still = findings => (findings.length ? `found: ${findings.map(finding => String(finding).replace(/[.\s]+$/, '')).join('; ')}.` : 'did not accept it.');

const sentBack = (task, api) => Boolean(api.lastRework?.(task)) || api.roundsUsed(task) >= api.roundsCap(task);

// A task's check that failed decides before any review (Daniel, 2026-09-28): the work goes back once
// with what the check printed; if it still fails, the work is kept and handed to the orchestrator,
// never put in the checkout. Null when the task names no check, or it passed.
function failedCheckIntent(task, api) {
  const check = api.checkOf?.(task);
  if (!check || check.passed) return null;
  // A check that could not run says nothing about the work: the worker has nothing to fix.
  if (check.unrunnable) return {action: 'escalate', reason: 'check_unrunnable', text: checkCouldNotRun(check)};
  if (sentBack(task, api)) return {action: 'escalate', reason: 'check_failed', text: checkStillFails(check)};
  return {action: 'rework', findings: [checkFinding(check)]};
}

// CONTRACT.md §2. Single reviewer, quorum 1, prelaunch never reworks (any non-accept/non-unreadable
// verdict rejects); completion sends the work back at most once and otherwise accepts it with advice.
const afterReworkAdvice = (findings = [], checks = null) => `Accepted after its one rework round; the review still ${findings.length ? `found: ${findings.join('; ')}` : 'did not accept it'}${checks?.length ? ` (${checks.join(', ')})` : ''}. Decide whether a follow-up task is needed.`;

export const defaultStrategy = {
  onSubmitted(task, view, api) {
    const row = api.submittedRow(task);
    const held = dependsOnIntent(row, view, api);
    if (held) return held;
    if (row?.review?.prelaunch) return {action: 'review', stage: 'prelaunch', reviewers: reviewersFor(row.review.prelaunch), quorum: 1};
    return 'dispatch';
  },
  onCompleted(task, view, api) {
    const failed = failedCheckIntent(task, api);
    if (failed) return failed;
    const row = api.submittedRow(task);
    if (row?.review?.completion) return {action: 'review', stage: 'completion', reviewers: reviewersFor(row.review.completion), quorum: 1};
    return 'none';
  },
  onReviewVerdict(task, verdicts, view, api) {
    const v = verdicts[0];
    // Prelaunch (state still 'queued' when the verdict is decided): no work exists yet, so nothing is
    // thrown away by holding it. Unchanged: accept launches, anything else rejects or escalates.
    if (view[task]?.state === 'queued') {
      if (v.verdict === 'accept') return {action: 'accept'};
      if (v.verdict === 'unavailable') return isJevLean(v) ? {action: 'accept', advice: jevAdvice(v)} : reviewGate(v);
      if (v.verdict === 'unreadable') return {action: 'escalate', reason: 'review', text: 'unreadable review verdict'};
      return {action: 'reject', questions: v.questions ?? v.findings ?? []};
    }
    // Completion. A review never holds finished work (user, 2026-09-27: 99 tasks, 36 accepted — failing and
    // blocked tasks defeat the point). It may send the task back ONCE; every other outcome accepts it, and
    // what the review said rides along as advice for the orchestrator to weigh.
    if (v.verdict === 'accept') return acceptOrHold(task, api, {said: 'The review accepted it.'});
    if (v.verdict === 'unavailable') return acceptOrHold(task, api, {advice: isJevLean(v) ? jevAdvice(v) : `The review gave no verdict (${v.reason ?? 'unavailable'}); check the work yourself before building on it.`});
    // Rare once verdicts are read from whatever the reviewer wrote (src/verdict.js): a review with no verdict
    // in it at all, or one that could not start. Neither is decided by bounce (user, 2026-09-27): the
    // orchestrator gets what the reviewer said and picks the way forward with the tools it has.
    if (v.verdict === 'unreadable') {
      const said = String(v.excerpt ?? '').trim();
      return {action: 'escalate', reason: 'review_unreadable', text: `${v.launchFailed ? 'The review could not start.' : 'The review ended without a verdict bounce could read.'} Decide: accept the work (task.accepted with what you checked), send it back (task.rework with what to fix), or check it another way — another reviewer, a probe, or yourself.${said ? ` The reviewer said: ${said.slice(-600)}` : ' The reviewer said nothing.'}`};
    }
    const findings = v.findings ?? v.questions ?? [];
    // A worker cannot rework away what it already reported as left: when the only findings are that the
    // report names remaining work and that acceptance is not met, and the worker's report says what
    // remains, the task is accepted and the orchestrator decides the follow-up. Found live (ACE d1bc0206,
    // f17544d3): a live proof that also found two product bugs was sent back for them and then failed.
    const remaining = String(api.remainingOf?.(task) ?? '').trim();
    const fired = Array.isArray(v.fired) ? v.fired : [];
    if (remaining && fired.length && fired.every(check => FOLLOW_UP_CHECKS.has(check))) {
      return acceptOrHold(task, api, {advice: `The worker completed and reported what is left, which a rework round cannot finish: ${remaining}. Jev flagged: ${fired.join(', ')}. Decide the follow-up.`});
    }
    // One send-back at most (it used to be two rounds, then a block: observed live, a correct change sent
    // back three times on the same checks). After it, whatever the verdict, the work is accepted.
    if (sentBack(task, api)) {
      return acceptOrHold(task, api, {advice: afterReworkAdvice(findings, api.lastFired?.(task)), said: `After the one rework round the review still ${still(findings)}`});
    }
    return {action: 'rework', findings};
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
  onCompleted(task, view, api) { return failedCheckIntent(task, api) ?? acceptOrHold(task, api, {said: 'No review is set for this session.'}); },
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
      const failed = failedCheckIntent(task, api);
      if (failed) return failed;
      const row = api.submittedRow(task);
      if (row?.review?.completion) return {action: 'review', stage: 'completion', reviewers: reviewersFor(row.review.completion), quorum: n};
      return 'none';
    },
    onReviewVerdict(task, verdicts, view, api) {
      const accepts = verdicts.filter(v => v.verdict === 'accept').length;
      if (accepts >= n) return view[task]?.state === 'queued' ? {action: 'accept'} : acceptOrHold(task, api, {said: `${accepts} reviews accepted it.`});
      const rejects = verdicts.filter(v => v.verdict === 'reject');
      if (rejects.length) return {action: 'reject', questions: rejects.flatMap(v => v.questions ?? v.findings ?? [])};
      const reworks = verdicts.filter(v => v.verdict === 'rework');
      if (reworks.length) {
        const findings = reworks.flatMap(v => v.findings ?? v.questions ?? []);
        if (!api.lastRework?.(task) && api.roundsUsed(task) < api.roundsCap(task)) return {action: 'rework', findings};
        return acceptOrHold(task, api, {advice: afterReworkAdvice(findings), said: `After the one rework round the review still ${still(findings)}`});
      }
      // Every reviewer reported (the CORE waits for all, CONTRACT §5); none rejected or
      // reworked, but quorum still unmet (e.g. mixed accept/unreadable short of n accepts).
      return {action: 'escalate', reason: 'quorum'};
    },
    onTerminal() { return {submit: []}; },
  };
}

// Jev checks that only say "the report names remaining work" / "acceptance is not met".
const FOLLOW_UP_CHECKS = new Set(['remaining_work', 'unmet_acceptance']);

// Jev's own below-threshold answer (it carries its threshold), as opposed to a review that produced no choice.
const isJevLean = v => (v.choice === 'accept' || v.choice === 'rework') && Number.isFinite(Number(v.threshold));
function jevAdvice(v) {
  const p = Number(v.probabilities?.[v.choice]);
  const conf = Number(v.confidence);
  const bar = Number.isFinite(p) && Number.isFinite(conf) ? ` (probability ${p.toFixed(2)}, confidence ${conf.toFixed(2)} below the ${v.threshold} bar)` : '';
  const fired = Array.isArray(v.fired) && v.fired.length ? `; fired: ${v.fired.join(', ')}` : '';
  const findings = Array.isArray(v.leanFindings) ? v.leanFindings.map(f => ` ${f}`).join('') : '';
  return `Jev leaned ${v.choice}${bar}${fired}.${findings}`;
}

// A review that answered below its confidence bar still answered. Rework-leaning is a refusal to
// accept, accept-leaning is doubt; only a review with no choice at all is unavailable. None of them
// accepts or sends work back on its own: the gate holds and the text says what to decide.
function reviewGate(v) {
  const lean = v.choice === 'accept' || v.choice === 'rework' ? v.choice : null;
  if (!lean) return {action: 'escalate', reason: 'review_unavailable', text: `Required review unavailable: ${v.reason ?? 'no confident verdict'}`};
  const p = Number(v.probabilities?.[lean]);
  const conf = Number(v.confidence);
  const range = Number.isFinite(p) && Number.isFinite(conf) ? ` (probability ${p.toFixed(2)}, confidence ${conf.toFixed(2)} below the ${v.threshold ?? 0.8} bar)` : '';
  const bar = `Jev leaned ${lean}${range} on both asks`;
  if (lean === 'accept') return {action: 'escalate', reason: 'review_uncertain', text: `Review uncertain: ${bar}. Decide: accept, or send back with findings of your own.`};
  const fired = Array.isArray(v.fired) && v.fired.length ? `; fired: ${v.fired.join(', ')}` : '';
  const findings = Array.isArray(v.leanFindings) ? v.leanFindings : [];
  return {action: 'escalate', reason: 'review_not_accepted', findings,
    text: `Review did not accept: ${bar}${fired}.${findings.map(f => ` ${f}`).join('')} Decide: accept, send back with these findings, or resubmit.`};
}
