// `bounce watch`: one call that returns when a session is done, needs attention, or has gone quiet (src/session-watch.js).
// Found live, 2026-11-04: control polled `bounce tasks --json` every minute with its own idle counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {watchSession, WATCH_EXIT} from '../src/session-watch.js';

const T0 = Date.parse('2026-11-04T12:00:00Z');
const at = minutes => new Date(T0 + minutes * 60000).toISOString();
const journal = rows => rows.map((row, index) => ({seq: index + 1, time: at(index), ...row}));
const submitted = task => ({kind: 'task.submitted', task, parent: null, profile: 'builder', orders: `do ${task}`});

test('a session whose daemon has exited is done, with each task\'s final state and whether its work landed', () => {
  const events = journal([submitted('a'), submitted('b'), submitted('c'),
    {kind: 'task.completed', task: 'a', summary: 'done'}, {kind: 'task.integrated', task: 'a', artifactId: 'x'}, {kind: 'task.accepted', task: 'a'},
    {kind: 'task.cancelled', task: 'b', reason: 'orchestrator'},
    {kind: 'task.blocked', task: 'c', reason: 'integration_conflict', text: 'Artifact integration conflict: AGENTS.md'}]);
  const result = watchSession(events, {live: false, now: T0 + 8 * 60000});
  assert.equal(result.outcome, 'done');
  assert.equal(WATCH_EXIT[result.outcome], 0);
  assert.equal(result.seq, 8);
  assert.deepEqual(result.tasks, [
    {task: 'a', state: 'accepted', integrated: true},
    {task: 'b', state: 'cancelled', integrated: false},
    {task: 'c', state: 'blocked', integrated: false, reason: 'integration_conflict', text: 'Artifact integration conflict: AGENTS.md'}]);
});

test('a live session needs attention for a task still blocked, failed or asking, and for a refused integration; one already decided is not reported', () => {
  const events = journal([submitted('a'), submitted('b'), submitted('c'), submitted('d'),
    {kind: 'task.blocked', task: 'a', reason: 'check_failed', text: 'check failed'},
    {kind: 'task.accepted', task: 'a', overrides: 'check_failed'},
    {kind: 'task.input_required', task: 'b', text: 'which port?'},
    {kind: 'task.failed', task: 'c', reason: 'error', text: 'boom'},
    {kind: 'task.blocked', task: 'd', reason: 'integration_conflict', text: 'Artifact integration conflict: AGENTS.md', paths: ['AGENTS.md']}]);
  const result = watchSession(events, {live: true, now: T0 + 9 * 60000});
  assert.equal(result.outcome, 'attention');
  assert.equal(WATCH_EXIT.attention, 2);
  assert.equal(result.seq, 9);
  assert.deepEqual(result.rows.map(row => [row.seq, row.kind, row.task, row.reason ?? null]), [
    [7, 'task.input_required', 'b', null], [8, 'task.failed', 'c', 'error'], [9, 'task.blocked', 'd', 'integration_conflict']]);
  // Resumed after what was reported: nothing new, so it waits.
  const later = watchSession(events, {live: true, after: result.seq, now: T0 + 9 * 60000});
  assert.equal(later.outcome, 'waiting');
  assert.equal(WATCH_EXIT.waiting, 4);
  // A blocked orchestrator turn needs attention too.
  const turn = watchSession([...events, {seq: 10, time: at(10), kind: 'main.blocked', text: 'needs a login'}], {live: true, after: 9, now: T0 + 10 * 60000});
  assert.deepEqual([turn.outcome, turn.rows.map(row => row.kind)], ['attention', ['main.blocked']]);
});

test('a live session with no row for --idle minutes is stuck; a live detached run is never done before its daemon exits', () => {
  const events = journal([submitted('a'), {kind: 'task.completed', task: 'a', summary: 'ok'}]);
  const quiet = watchSession(events, {live: true, run: true, now: T0 + 12 * 60000, idleMs: 10 * 60000});
  assert.deepEqual([quiet.outcome, quiet.idleMinutes, WATCH_EXIT.stuck], ['stuck', 11, 3]);
  const busy = watchSession(events, {live: true, run: true, now: T0 + 3 * 60000, idleMs: 10 * 60000});
  assert.equal(busy.outcome, 'waiting', 'every task ended, but the run itself is still going (its orchestrator may be taking the next turn)');
});

test('a live interactive session is done when every task ended and its orchestrator is idle; not while a turn runs or before any task', () => {
  const ended = journal([{kind: 'main.started', requestId: 'r1'}, submitted('a'), {kind: 'task.completed', task: 'a', summary: 'ok'}, {kind: 'main.terminal', requestId: 'r1', status: 'completed'}]);
  assert.deepEqual(watchSession(ended, {live: true, now: T0 + 4 * 60000}), {outcome: 'done', seq: 4, tasks: [{task: 'a', state: 'completed', integrated: false}]});
  assert.equal(watchSession(ended.slice(0, 3), {live: true, now: T0 + 3 * 60000}).outcome, 'waiting', 'its turn is still running');
  assert.equal(watchSession(journal([{kind: 'main.started', requestId: 'r1'}, {kind: 'main.terminal', requestId: 'r1', status: 'completed'}]), {live: true, now: T0 + 2 * 60000}).outcome, 'waiting', 'no task yet');
  assert.equal(watchSession(ended, {live: true, after: 4, now: T0 + 4 * 60000}).outcome, 'waiting', 'done already reported');
});

// Found live, 2026-11-05: `watch --idle 40` fired while the orchestrator waited on a builder or ran gates itself, so
// control kept its own 10-quiet-minutes script. `--done` returns only when the run's job has ended, with its result.
test('--done waits through quiet stretches and held tasks, and returns when the run\'s job ends, with its answer and what it delivered', () => {
  const working = journal([{kind: 'main.started', requestId: 'r1'}, submitted('a'), {kind: 'main.terminal', requestId: 'r1', status: 'completed'},
    {kind: 'task.blocked', task: 'a', reason: 'check_failed', text: 'check failed'}]);
  assert.equal(watchSession(working, {live: true, run: true, done: true, now: T0 + 90 * 60000, idleMs: 10 * 60000}).outcome, 'waiting', 'quiet and held: not done');
  const delivered = {kind: 'task.integrated', task: 'a', delivery: 'branch', branch: 'ui-polish', head: 'h'.repeat(40), tree: 't'.repeat(40), copy: '/w/1', checkStale: true, text: 'Delivered as branch ui-polish'};
  const ended = journal([...working.map(({seq, time, ...row}) => row), {kind: 'task.accepted', task: 'a'}, delivered,
    {kind: 'assistant', text: 'Merged ui-polish; gates green on hhhh.'}, {kind: 'run.ended', status: 'completed', waiting: []}]);
  const result = watchSession(ended, {live: true, run: true, done: true, now: T0 + 9 * 60000});
  assert.deepEqual({outcome: result.outcome, seq: result.seq, answer: result.answer, status: result.status, delivered: result.delivered}, {outcome: 'done', seq: 8,
    answer: 'Merged ui-polish; gates green on hhhh.', status: 'completed',
    delivered: [{task: 'a', branch: 'ui-polish', head: 'h'.repeat(40), tree: 't'.repeat(40), copy: '/w/1', checkStale: true}]});
  assert.equal(WATCH_EXIT[result.outcome], 0);
  // A message sent after the job ended starts it again: not done until its own end.
  const again = journal([...ended.map(({seq, time, ...row}) => row), {kind: 'send.queued', requestId: 'r2', text: 'merge main'}]);
  assert.equal(watchSession(again, {live: true, run: true, done: true, now: T0 + 10 * 60000}).outcome, 'waiting');
  // A job that ended with tasks waiting on the user needs them: attention.
  const asking = journal([submitted('b'), {kind: 'task.input_required', task: 'b', text: 'which port?'}, {kind: 'run.ended', status: 'completed', waiting: ['b']}]);
  assert.deepEqual([watchSession(asking, {live: true, run: true, done: true, now: T0 + 3 * 60000}).outcome], ['attention']);
});

// The command end to end: a real CLI process over a journal on disk, with daemon.json saying whether its daemon runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('bounce watch: done (0) once the daemon is gone, attention (2) for a live session\'s blocker, waiting (4) at --timeout after it, a bad flag refused', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-watch-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  session.append(submitted('a'));
  session.append({kind: 'task.blocked', task: 'a', reason: 'integration_conflict', text: 'Artifact integration conflict: AGENTS.md'});
  const watch = (...args) => spawnSync(process.execPath, [cliPath, 'watch', session.id, ...args], {env: {...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1'}, encoding: 'utf8', timeout: 15000});
  const done = watch('--json');
  assert.equal(done.status, 0, done.stderr);
  const doneJson = JSON.parse(done.stdout);
  assert.deepEqual([doneJson.outcome, doneJson.tasks], ['done', [{task: 'a', state: 'blocked', integrated: false, reason: 'integration_conflict', text: 'Artifact integration conflict: AGENTS.md'}]]);
  // A live detached run: this test's own pid stands in for its daemon.
  fs.writeFileSync(path.join(session.dir, 'daemon.json'), JSON.stringify({pid: process.pid, run: true}));
  const attention = watch();
  assert.equal(attention.status, 2, attention.stderr);
  const seq = session.events.at(-1).seq;
  assert.equal(attention.stdout, `Session ${session.id} needs you · resume with --after ${seq}\n#${seq} task.blocked a · integration_conflict: Artifact integration conflict: AGENTS.md\n`);
  const waiting = watch('--after', String(seq), '--timeout', '1', '--json');
  assert.equal(waiting.status, 4, waiting.stderr);
  assert.deepEqual(JSON.parse(waiting.stdout), {outcome: 'waiting', seq});
  const bad = watch('--idle', 'soon');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--idle takes minutes, a positive number/);
});
