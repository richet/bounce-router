// Found live (ACE d1bc0206, task f17544d3): a live-proof worker completed, and listed two real product bugs
// it had found as remaining. Jev read that as unfinished (remaining_work, unmet_acceptance at 0.83) and sent
// it back; the rework then exhausted the job and the evidence-backed result was failed. A worker cannot
// rework away what it already reported as left: the task is accepted and the orchestrator gets the follow-ups.
import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultStrategy} from '../src/strategy.js';

const api = remaining => ({submittedRow: () => ({}), lastRework: () => null, lastFired: () => null, reAsked: () => false, roundsUsed: () => 0, roundsCap: () => 3, remainingOf: () => remaining});
const rework = fired => ({verdict: 'rework', choice: 'rework', confidence: 0.83, threshold: 0.8, fired, findings: ['The report says done but names remaining work; finish it or report the task as blocked/failed with what is left.']});
const view = {t: {state: 'reviewing'}};

test('a confident rework whose only findings are the remaining work the worker itself reported is accepted with that work as follow-ups', () => {
  const decision = defaultStrategy.onReviewVerdict('t', [rework(['remaining_work', 'unmet_acceptance'])], view, api('rollback deletes a persistent volume without --allow-destructive'));
  assert.equal(decision.action, 'accept');
  assert.equal(decision.advice, 'The worker completed and reported what is left, which a rework round cannot finish: rollback deletes a persistent volume without --allow-destructive. Jev flagged: remaining_work, unmet_acceptance. Decide the follow-up.');
});

test('a rework with any other finding, or with nothing reported as remaining, still goes back to the worker', () => {
  assert.equal(defaultStrategy.onReviewVerdict('t', [rework(['remaining_work', 'outside_scope'])], view, api('x')).action, 'rework');
  assert.equal(defaultStrategy.onReviewVerdict('t', [rework(['remaining_work'])], view, api('')).action, 'rework');
  assert.equal(defaultStrategy.onReviewVerdict('t', [rework(['unverified_claims'])], view, api('x')).action, 'rework');
});

// User, 2026-09-27: a review with no readable verdict is not decided by bounce — neither accepted nor
// re-asked — the orchestrator gets what the reviewer said and picks the way forward.
test('a review with no readable verdict goes to the orchestrator with what the reviewer said', () => {
  const decision = defaultStrategy.onReviewVerdict('t', [{verdict: 'unreadable', excerpt: 'I think it is fine, mostly.'}], view, api(''));
  assert.equal(decision.action, 'escalate');
  assert.equal(decision.reason, 'review_unreadable');
  assert.match(decision.text, /^The review ended without a verdict bounce could read\. Decide: accept the work \(task\.accepted with what you checked\), send it back \(task\.rework with what to fix\), or check it another way — another reviewer, a probe, or yourself\. The reviewer said: I think it is fine, mostly\.$/);
});
