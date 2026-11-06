// `bounce lineage`: which vendor session did what, from the journal alone, so a reader can walk user message →
// orchestrator turn → task → worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {lineageRows} from '../src/lineage.js';

const clock = minute => `2026-01-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
const at = (minute, row) => ({time: clock(minute), ...row});
const orchestratorNative = (minute, sessionId) => at(minute, {kind: 'peer.native', from: 'main', provider: 'claude', sessionId});
const workerNative = (minute, task, sessionId, provider = 'codex') => at(minute, {kind: 'peer.native', from: `worker:${task}`, provider, sessionId});

const journal = () => [
  at(0, {kind: 'session', cwd: '/p/app', repository: 'git@github.com:example/app.git'}),
  at(0, {kind: 'user', text: 'do it', via: 'send', caller: 'control-1', requestId: 'r1'}),
  at(0, {kind: 'main.requested', requestId: 'r1'}),
  at(1, {kind: 'main.started', requestId: 'r1', from: 'main'}),
  orchestratorNative(1, 'orch-a'),
  at(2, {kind: 'task.submitted', task: 't1', profile: 'builder@codex:gpt', parent: null, replaces: null, from: 'orchestrator', turnRequestId: 'r1'}),
  at(3, {kind: 'task.started', task: 't1', attempt: 1, from: 'worker:t1'}),
  workerNative(3, 't1', 'thread-1'),
  at(5, {kind: 'task.attempt.ended', task: 't1', attempt: 1, from: 'worker:t1'}),
  at(6, {kind: 'main.terminal', requestId: 'r1', status: 'completed', from: 'main'}),
  at(7, {kind: 'review.started', task: 't1', from: 'bounce'}),
  at(7, {kind: 'peer.native', from: 'review:t1', provider: 'claude', sessionId: 'review-1'}),
  at(9, {kind: 'review.finished', task: 't1', from: 'review:t1'}),
];

test('a worker, its turn and its review each say who they are and when', () => {
  const rows = lineageRows(journal(), 'S');
  assert.deepEqual(rows[0], {v: 1, bounceSession: 'S', provider: 'claude', nativeSession: 'orch-a', level: 'orchestrator', role: 'orchestrator', task: null, attempt: null,
    parentTask: null, continues: null, replaces: null, requestId: 'r1', requestInferred: false, via: 'send', control: 'control-1', repository: 'git@github.com:example/app.git', from: clock(1), to: clock(6)});
  assert.deepEqual(rows[1], {v: 1, bounceSession: 'S', provider: 'codex', nativeSession: 'thread-1', level: 'task', role: 'builder', task: 't1', attempt: 1,
    parentTask: null, continues: null, replaces: null, requestId: 'r1', requestInferred: false, via: 'send', control: 'control-1', repository: 'git@github.com:example/app.git', from: clock(3), to: clock(5)});
  assert.deepEqual([rows[2].level, rows[2].role, rows[2].task, rows[2].nativeSession, rows[2].from, rows[2].to], ['review', 'reviewer', 't1', 'review-1', clock(7), clock(9)]);
  assert.equal(rows.length, 3);
});

// Nirby control session, 2026-11-04: a worker's vendor session runs in a copy outside the project, so a reader of it
// could not tell its project. The session row records the checkout's origin, and every lineage row carries it.
test('a session records its checkout\'s origin, and lineage rows carry it as repository (null without one)', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-lineage-repo-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const project = path.join(dir, 'app');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q'], {cwd: project});
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/app.git'], {cwd: project});
  const session = new Session(project, {root: path.join(dir, 'home')});
  assert.equal(session.events[0].repository, 'git@github.com:example/app.git');
  const plain = new Session(dir, {root: path.join(dir, 'home2')});
  assert.equal('repository' in plain.events[0], false, 'not a git checkout: no repository');
  assert.equal(lineageRows(journal().slice(1), 'S')[0].repository, null);
});

test('one vendor session serving two tasks gives one row per task, each with its own window', () => {
  const events = [
    at(0, {kind: 'main.started', requestId: 'r1', from: 'main'}),
    at(1, {kind: 'task.submitted', task: 't1', profile: 'builder~2', from: 'orchestrator', turnRequestId: 'r1'}),
    at(2, {kind: 'task.started', task: 't1', attempt: 1, from: 'worker:t1'}),
    workerNative(2, 't1', 'shared'),
    at(3, {kind: 'task.completed', task: 't1', from: 'worker:t1'}),
    at(4, {kind: 'task.submitted', task: 't2', profile: 'builder', continues: 't1', from: 'orchestrator', turnRequestId: 'r1'}),
    at(5, {kind: 'task.started', task: 't2', attempt: 1, from: 'worker:t2'}),
    workerNative(5, 't2', 'shared'),
    at(8, {kind: 'task.completed', task: 't2', from: 'worker:t2'}),
  ];
  const rows = lineageRows(events, 'S').filter(row => row.level === 'task');
  assert.deepEqual(rows.map(row => [row.task, row.nativeSession, row.continues, row.from, row.to]),
    [['t1', 'shared', null, clock(2), clock(3)], ['t2', 'shared', 't1', clock(5), clock(8)]]);
});

test('a rework on the same thread is a second attempt, a thread change mid-attempt a second row', () => {
  const events = [
    at(1, {kind: 'task.submitted', task: 't1', profile: 'analyst', from: 'orchestrator'}),
    at(2, {kind: 'task.started', task: 't1', attempt: 1, from: 'worker:t1'}),
    workerNative(2, 't1', 'one'),
    at(3, {kind: 'task.started', task: 't1', attempt: 2, from: 'worker:t1'}),
    workerNative(3, 't1', 'one'),
    workerNative(4, 't1', 'two'),
    at(5, {kind: 'task.completed', task: 't1', from: 'worker:t1'}),
  ];
  assert.deepEqual(lineageRows(events, 'S').map(row => [row.attempt, row.nativeSession, row.from, row.to]),
    [[1, 'one', clock(2), clock(3)], [2, 'one', clock(3), clock(4)], [2, 'two', clock(4), clock(5)]]);
});

test('a journal older than the link names the open turn and says it was inferred', () => {
  const events = journal().map(row => {
    if (row.kind !== 'task.submitted') return row;
    const {turnRequestId, ...old} = row;
    return old;
  });
  const task = lineageRows(events, 'S').find(row => row.level === 'task');
  assert.deepEqual([task.requestId, task.requestInferred], ['r1', true]);
});

test('with no turn open a task has no request; a wake turn has no via; a profile with no role has a null role', () => {
  const events = [
    at(1, {kind: 'task.submitted', task: 't1', profile: 'codex_custom', from: 'orchestrator'}),
    at(2, {kind: 'task.started', task: 't1', attempt: 1, from: 'worker:t1'}),
    workerNative(2, 't1', 'one'),
    at(3, {kind: 'main.started', requestId: 'wake', from: 'main'}),
    orchestratorNative(3, 'orch'),
    at(4, {kind: 'main.terminal', requestId: 'wake', from: 'main'}),
  ];
  const [task, turn] = lineageRows(events, 'S');
  assert.deepEqual([task.requestId, task.requestInferred, task.role], [null, false, null]);
  assert.deepEqual([turn.requestId, turn.via, turn.control], ['wake', null, null]);
});

test('a typed turn reads tui, also when its user row carries no request id', () => {
  const events = [
    at(0, {kind: 'user', text: 'hi'}),
    at(0, {kind: 'main.requested', requestId: 'r1'}),
    at(1, {kind: 'main.started', requestId: 'r1', from: 'main'}),
    orchestratorNative(1, 'orch'),
  ];
  const [turn] = lineageRows(events, 'S');
  assert.deepEqual([turn.via, turn.to], ['tui', clock(1)]);
});

test('a row carries ids, roles and times, never a message or its orders', () => {
  const events = journal().map(row => ({...row, text: 'SECRET TEXT', orders: 'SECRET ORDERS', cwd: '/secret/path'}));
  assert.doesNotMatch(JSON.stringify(lineageRows(events, 'S')), /SECRET|\/secret/);
});

const scheduled = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-lineage-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const adapter = {async launch() { return new Promise(() => {}); }, async *events() {}, async deliver() { return 'live'; }, async cancel() { return {verified: true}; }};
  const scheduler = createScheduler({session, adapters: {claude: adapter}, profiles: {builder: {adapter: 'claude', model: '', mode: 'yolo', policy: 'write', fallback: [], role: 'builder', executables: {}}}});
  t.after(() => scheduler.close?.());
  return {session, scheduler};
};

test('a task the orchestrator submits in a turn names that turn, and one outside a turn names none', async t => {
  const {session, scheduler} = scheduled(t);
  session.append({kind: 'main.started', requestId: 'r1', from: 'main'});
  const inTurn = scheduler.submit({parent: null, profile: 'builder', orders: 'one', deadline: null, from: 'orchestrator'});
  session.append({kind: 'main.terminal', requestId: 'r1', status: 'completed', from: 'main'});
  const after = scheduler.submit({parent: null, profile: 'builder', orders: 'two', deadline: null, from: 'orchestrator'});
  assert.equal(inTurn.turnRequestId, 'r1');
  assert.equal(after.turnRequestId, undefined);
});

test('bounce lineage --json prints one versioned row per line for a session, and for every session without one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-lineage-cli-'));
  try {
    const session = new Session(root, {root});
    for (const {time, ...row} of journal()) session.append(row);
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const run = (...args) => execFileSync(process.execPath, [cli, 'lineage', ...args], {env: {...process.env, BOUNCE_HOME: root}, encoding: 'utf8'});
    const rows = run(session.id.slice(0, 8), '--json').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => [row.v, row.level, row.bounceSession]), [[1, 'orchestrator', session.id], [1, 'task', session.id], [1, 'review', session.id]]);
    assert.equal(run('--json').trim().split('\n').length, 3);
    assert.match(run(session.id.slice(0, 8)), /thread-1/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
