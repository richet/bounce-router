// docs/plans/analytics.md (Daniel, 2026-10-01): what a session cost and what it got, folded from the journal.
// The fold is checked on a journal written here with known counts; the same fold run on the real journals
// is checked by hand against the figures in docs/PROGRESS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionStats, formatStats, compareStats, taskLines} from '../src/stats.js';

const t0 = Date.parse('2026-10-01T10:00:00Z');
const at = m => new Date(t0 + m * 60000).toISOString();
let seq = 0;
const row = (minute, kind, extra = {}) => ({seq: ++seq, time: at(minute), kind, ...(kind === 'task.submitted' ? {review: {completion: 'critic'}} : {}), ...extra});

function journal() {
  seq = 0;
  return [
    row(0, 'session', {cwd: '/p'}),
    // a builder task: one send-back, then accepted
    row(1, 'task.submitted', {task: 'a', profile: 'builder', orders: 'x', check: 'npm test'}),
    row(1, 'task.local_selected', {task: 'a', selection: {model: 'qwen3.6-35b-a3b-mlx'}}),
    row(1, 'task.launch.requested', {task: 'a', worker: 'builder#1'}),
    row(1, 'task.started', {task: 'a', attempt: 1}),
    row(2, 'task.usage', {task: 'a', usage: {input: 50000, output: 800, reasoning: 0}}),
    row(5, 'task.attempt.ended', {task: 'a', attempt: 1}),
    row(5, 'task.completed', {task: 'a', summary: 'done?'}),
    row(5, 'task.check', {task: 'a', passed: false, exit: 1}),
    row(5, 'task.rework', {task: 'a', findings: ['fix']}),
    row(5, 'task.started', {task: 'a', attempt: 2}),
    row(6, 'task.usage', {task: 'a', usage: {input: 60000, output: 400}}),
    row(8, 'task.attempt.ended', {task: 'a', attempt: 2}),
    row(8, 'task.completed', {task: 'a', summary: 'done'}),
    row(8, 'task.check', {task: 'a', passed: true, exit: 0}),
    row(8, 'review.finished', {task: 'a', text: JSON.stringify({verdict: 'accept', findings: []})}),
    row(8, 'task.accepted', {task: 'a', stage: 'completion'}),
    // the orchestrator's turn on that outcome
    row(8, 'main.started', {from: 'main'}),
    row(8, 'usage', {from: 'main', usage: {input: 12000, output: 300}}),
    row(10, 'main.terminal', {from: 'main', status: 'completed'}),
    // a Sonnet task that redoes the accepted work: a correction
    row(10, 'task.submitted', {task: 'b', profile: 'claude_sonnet', orders: 'redo a', retryOf: 'a', replaces: 'a'}),
    row(10, 'task.launch.requested', {task: 'b', worker: 'claude_sonnet#1'}),
    row(10, 'task.started', {task: 'b', attempt: 1}),
    row(11, 'task.usage', {task: 'b', usage: {input: 100, cache_read: 300000, output: 2000}}),
    row(12, 'task.attempt.ended', {task: 'b', attempt: 1}),
    row(12, 'task.completed', {task: 'b', summary: 'redone'}),
    row(12, 'review.finished', {task: 'b', text: JSON.stringify({verdict: 'unavailable', choice: 'accept', confidence: 0.5})}),
    row(12, 'task.accepted', {task: 'b', stage: 'completion'}),
    // a continuation of b, accepted first time
    row(12, 'task.submitted', {task: 'c', profile: 'claude_sonnet', orders: 'more', continues: 'b', worker: 'claude_sonnet#1'}),
    row(12, 'task.launch.requested', {task: 'c', worker: 'claude_sonnet#1', continued: true, continues: 'b'}),
    row(12, 'task.started', {task: 'c', attempt: 1}),
    row(13, 'task.attempt.ended', {task: 'c', attempt: 1}),
    row(13, 'task.completed', {task: 'c', summary: 'more'}),
    row(13, 'review.finished', {task: 'c', text: JSON.stringify({verdict: 'accept'})}),
    row(13, 'task.accepted', {task: 'c', stage: 'completion'}),
    // a held task with a weak check, nothing running for 25 minutes, then a sweep
    row(13, 'task.submitted', {task: 'd', profile: 'builder', orders: 'y', check: 'grep -q x f'}),
    row(13, 'task.local_selected', {task: 'd', selection: {model: 'qwen3.6-35b-a3b-mlx'}}),
    row(13, 'task.launch.requested', {task: 'd', worker: 'builder#1', continued: true, continues: 'a'}),
    row(13, 'task.started', {task: 'd', attempt: 1}),
    row(14, 'task.attempt.ended', {task: 'd', attempt: 1}),
    row(14, 'task.completed', {task: 'd', summary: 'y'}),
    row(14, 'task.check', {task: 'd', passed: true, weak: true, exit: 0}),
    row(14, 'review.started', {task: 'd'}),
    row(14, 'task.blocked', {task: 'd', reason: 'unverified', text: 'waits'}),
    row(40, 'main.requested', {from: 'main', wake: true, sweep: true, requestId: 'r1'}),
    row(40, 'handoff', {sweep: true, requestId: 'r1', tasks: ['d'], text: 'Nothing has happened'}),
    row(40, 'lesson.learned', {agent: 'builder', text: 'Checks must run the work.'}),
    row(41, 'worker.retired', {worker: 'builder#1'}),
    row(41, 'worker.compacted', {worker: 'claude_sonnet#1', status: 'completed'}),
  ];
}

test('the fold counts outcomes, time, tokens, checks, reviews, workers, lessons and sweeps from the journal', () => {
  const s = sessionStats(journal(), {now: t0 + 60 * 60000});
  assert.deepEqual([s.outcome.submitted, s.outcome.accepted, s.outcome.held, s.outcome.failed], [4, 3, 1, 0]);
  assert.equal(s.outcome.firstAttempt, 2, 'a was sent back and later redone; b and c were accepted untouched');
  assert.equal(s.outcome.corrections, 1);
  assert.deepEqual(s.outcome.byAgent.builder, {submitted: 2, accepted: 1, held: 1, failed: 0, open: 0});
  assert.deepEqual(Object.keys(s.time.workerByAI).sort(), ['claude_sonnet', 'local:qwen3.6-35b-a3b-mlx']);
  assert.equal(s.time.workerByAI['local:qwen3.6-35b-a3b-mlx'].attempts, 3);
  assert.equal(s.time.workerByAI['local:qwen3.6-35b-a3b-mlx'].totalMs, 8 * 60000);
  assert.deepEqual([s.time.orchestrator.turns, s.time.orchestrator.totalMs], [1, 2 * 60000]);
  assert.equal(s.time.busyMs, 14 * 60000 - 60000, 'minute 1 to 14, with the orchestrator turn overlapping');
  assert.deepEqual(s.time.quietGaps.map(g => g.minutes), [26]);
  assert.deepEqual(s.tokens.byAI['local:qwen3.6-35b-a3b-mlx'], {input: 110000, output: 1200, cacheRead: 0, reasoning: 0});
  assert.deepEqual(s.tokens.byAI.orchestrator, {input: 12000, output: 300, cacheRead: 0, reasoning: 0});
  assert.equal(s.tokens.totalInput, 110000 + 300100 + 12000);
  assert.deepEqual(s.checks, {run: 3, passed: 2, failed: 1, weak: 1, unrunnable: 0, sendBacks: 1});
  assert.deepEqual([s.reviews.verdicts.accept, s.reviews.verdicts.unavailable, s.reviews.belowBar], [2, 1, 1]);
  assert.deepEqual(s.workers, {fresh: 2, continued: 2, retired: 1, compacted: 1});
  assert.deepEqual([s.lessons, s.sweeps], [1, {fired: 1, withHeld: 1}]);
  assert.equal(s.span.hours, 0.7);
});

test('the lines say what every number is, and name what the journal cannot tell', () => {
  const lines = formatStats(sessionStats(journal()), {title: 'Session abc'});
  assert.equal(lines[0], 'Session abc · 2026-10-01 10:00 → 2026-10-01 10:41 UTC · 0.7 h from first row to last (a session resumed over days counts the gaps)');
  assert.equal(lines[1], 'Outcome: 4 tasks submitted · 3 accepted (2 at the first attempt) · 1 held · 0 failed · 1 corrections of accepted work');
  assert.equal(lines.some(l => l === '  local:qwen3.6-35b-a3b-mlx: 3 attempts, 8.0 min in all, median 3.0 min'), true, lines.join('\n'));
  assert.equal(lines.some(l => l.startsWith('Checks: 3 run · 2 passed · 1 failed · 1 only looked · 0 could not run · 1 send-backs')), true);
  assert.equal(lines.some(l => l === 'Workers: 2 fresh launches · 2 continuations · 1 retired · 1 compacted'), true);
  assert.equal(lines.at(-1).startsWith('Not in the journal, so not here:'), true);
});

test('two sessions compare line by line with the change against the first', () => {
  const a = sessionStats(journal());
  const b = sessionStats(journal().filter(e => e.task !== 'd' && Date.parse(e.time) < t0 + 30 * 60000));
  const lines = compareStats(a, b);
  assert.equal(lines[1], 'Accepted of submitted: 3/3 vs 3/4');
  assert.equal(lines.find(l => l.startsWith('Quiet gaps')), 'Quiet gaps over 20 min: 0 (-1 vs 1)');
});

test('one line per task names what ate its time', () => {
  const lines = taskLines(journal());
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^a · builder · local:qwen3\.6-35b-a3b-mlx · 2 attempts · 7\.0 min · 111k tokens · checks fail\/pass · accepted · 2 attempts$/);
  assert.match(lines[3], /^d · builder · local:qwen3\.6-35b-a3b-mlx · 1 attempt · 1\.0 min · 0 tokens · checks pass · blocked$/);
});
