// Phase 9 — the interactive orchestrator (Model B). These tests exercise supervise()'s
// interactive-orchestrator path and the steering IPC in-process (real bus + scheduler, fake
// children). They live in their own file so their in-process daemon apparatus never runs
// alongside daemon.test.js's real-subprocess tests, whose timing it otherwise perturbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {supervise} from '../src/reload.js';
import {Session} from '../src/core.js';

const fakeCli = fileURLToPath(new URL('./helpers/fake-cli.js', import.meta.url));
const fakeOrchestratorCli = fileURLToPath(new URL('./helpers/fake-orchestrator-cli.js', import.meta.url));

function tmpRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeConfig(root, order = ['codex']) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order, mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000,
    executables: Object.fromEntries(order.map(p => [p, fakeCli])), skills: {scope: 'user', autoSync: false},
  }));
}
function writeOrchestratorConfig(root, {orchestrator = 'main', profiles, order = ['codex']} = {}) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order, mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000,
    executables: Object.fromEntries(order.map(p => [p, fakeOrchestratorCli])),
    skills: {scope: 'user', autoSync: false}, operation: 'orchestrator', orchestrator, profiles,
  }));
}
async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}
const completingAdapter = () => ({
  async launch() { return {}; },
  async *events() { yield {kind: 'result', status: 'completed', text: 'child done'}; },
  async cancel() { return {verified: true}; },
});

// Phase 9 (interactive orchestrator, increment 9.1): a bare interactive `bounce` whose config is
// orchestrator takes the daemon apparatus path with an INTERACTIVE child (no `run` positional →
// cli.js's multi-turn TUI branch as the orchestrator peer). Classic config stays on legacySupervise,
// byte-identical. Verified at the spawn seam (a real TUI child needs a TTY these tests do not have).
test('P9.1 interactive orchestrator: a bare bounce with orchestrator config builds the apparatus and spawns a no-run child', async t => {
  const root = tmpRoot('bounce-io-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const {EventEmitter} = await import('node:events');
  let childArgs = null;
  const spawnChild = (_cmd, args) => {
    childArgs = args.slice(1); // drop cliPath; what remains are the bounce args handed to the child
    const child = new EventEmitter();
    child.send = () => {}; child.kill = () => {};
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  await withEnv({BOUNCE_HOME: root}, () => supervise([], {spawnChild, adapters: {codex: completingAdapter()}}));
  assert.equal(childArgs.includes('run'), false, 'the child is interactive — no run positional, so cli.js enters the TUI branch');
  const id = fs.readdirSync(path.join(root, 'sessions'))[0];
  const journal = fs.readFileSync(path.join(root, 'sessions', id, 'journal.jsonl'), 'utf8');
  const operation = journal.trim().split('\n').map(l => JSON.parse(l)).find(r => r.kind === 'operation');
  assert.equal(operation?.operation, 'orchestrator', 'the apparatus ran: an operation row is journaled');
  assert.equal(operation?.orchestrator, 'main');
});

test('P9.1 classic stays classic: a bare bounce with classic config uses legacySupervise, no daemon session', async t => {
  const root = tmpRoot('bounce-cl-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root); // classic order/mode, no operation field
  const {EventEmitter} = await import('node:events');
  let spawned = false;
  const spawnChild = () => {
    spawned = true;
    const child = new EventEmitter();
    child.send = () => {}; child.kill = () => {};
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  await withEnv({BOUNCE_HOME: root}, () => supervise([], {spawnChild}));
  assert.equal(spawned, true, 'legacySupervise still spawns the interactive TUI child');
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false, 'the classic bare TUI builds no daemon session (parent writes nothing; the fake child never runs)');
});

// Phase 9.3 steering: the interactive orchestrator child (the TUI) asks the daemon to cancel work
// over its own IPC channel — `/stop` with no arg is control.stop (the whole tree), `/stop <task>`
// is control.cancel of one task. The scheduler owns the cancel; task.cancelled flows back to the pane.
test('P9.3 steering: a control.stop from the interactive child cancels running tasks', async t => {
  const root = tmpRoot('bounce-steer-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const {EventEmitter} = await import('node:events');
  const hang = (() => { let end; const done = new Promise(r => { end = r; }); return {async launch() { return {}; }, async *events() { await done; }, async cancel() { end?.(); return {verified: true}; }}; })();
  let sessionRef;
  const spawnChild = () => {
    const child = new EventEmitter();
    child.kill = () => {}; child.send = () => {};
    setTimeout(() => child.emit('message', {type: 'control', action: 'stop'}), 60);
    setTimeout(() => child.emit('close', 0, null), 500);
    return child;
  };
  await withEnv({BOUNCE_HOME: root}, () => supervise([], {
    spawnChild, adapters: {codex: hang},
    onReady: async ({scheduler, session}) => { sessionRef = session; scheduler.submit({parent: null, profile: 'build', orders: 'x', deadline: null}); },
  }));
  assert.equal(sessionRef.events.some(e => e.kind === 'task.started'), true, 'the task launched');
  assert.equal(sessionRef.events.some(e => e.kind === 'task.cancelled'), true, 'control.stop from the child cancelled it');
});

test('P9.3 steering: a control.cancel of one task id cancels just that task', async t => {
  const root = tmpRoot('bounce-cancel-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const {EventEmitter} = await import('node:events');
  const hang = (() => { let end; const done = new Promise(r => { end = r; }); return {async launch() { return {}; }, async *events() { await done; }, async cancel() { end?.(); return {verified: true}; }}; })();
  let sessionRef, taskId;
  const spawnChild = () => {
    const child = new EventEmitter();
    child.kill = () => {}; child.send = () => {};
    setTimeout(() => child.emit('message', {type: 'control', action: 'cancel', task: taskId}), 60);
    setTimeout(() => child.emit('close', 0, null), 500);
    return child;
  };
  await withEnv({BOUNCE_HOME: root}, () => supervise([], {
    spawnChild, adapters: {codex: hang},
    onReady: async ({scheduler, session}) => { sessionRef = session; taskId = scheduler.submit({parent: null, profile: 'build', orders: 'x', deadline: null}).task; },
  }));
  const cancelled = sessionRef.events.find(e => e.kind === 'task.cancelled');
  assert.equal(cancelled?.task, taskId, 'the named task was cancelled');
});

test('P9.7 --resume by name reconciles the resumed log (orphaned running task) before the TUI child starts', async t => {
  const root = tmpRoot('bounce-resume-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const cwd = process.cwd();
  const stale = new Session(cwd, {root});
  stale.append({kind: 'user', text: 'old work'});
  stale.append({kind: 'session.renamed', name: 'old work'});
  stale.append({kind: 'task.submitted', task: 'gone', parent: null, profile: 'build', orders: 'x', deadline: null, context: stale.id});
  stale.append({kind: 'task.started', task: 'gone', attempt: 1});
  const {EventEmitter} = await import('node:events');
  let sessionRef;
  const spawnChild = () => {
    const child = new EventEmitter();
    child.kill = () => {}; child.send = () => {};
    setTimeout(() => child.emit('close', 0, null), 100);
    return child;
  };
  await withEnv({BOUNCE_HOME: root}, () => supervise(['--resume', 'old work'], {spawnChild, adapters: {codex: completingAdapter()}, onReady: async ({session}) => { sessionRef = session; }}));
  assert.equal(sessionRef.id, stale.id, 'the name resolved to the stale session');
  const orphan = sessionRef.events.find(e => e.kind === 'task.blocked' && e.task === 'gone');
  assert.equal(orphan?.reason, 'orphaned');
  assert.equal(orphan?.text, 'termination unverified after daemon restart; inspect the previous worker process before resubmitting');
});

test('P9.8 a switch message from the TUI child ends this daemon and supervise() starts one for the chosen session', async t => {
  const root = tmpRoot('bounce-switch-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const {EventEmitter} = await import('node:events');
  const seen = [];
  let spawns = 0;
  const spawnChild = () => {
    const child = new EventEmitter();
    child.kill = () => {}; child.send = () => {};
    const n = ++spawns;
    if (n === 1) { setTimeout(() => child.emit('message', {type: 'switch', id: 'new'}), 40); setTimeout(() => child.emit('close', 76, null), 80); }
    else setTimeout(() => child.emit('close', 0, null), 40);
    return child;
  };
  await withEnv({BOUNCE_HOME: root}, () => supervise([], {spawnChild, adapters: {codex: completingAdapter()}, onReady: async ({session}) => { seen.push(session.id); }}));
  assert.equal(spawns, 2);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'the second daemon runs a new session');
  assert.deepEqual(fs.readdirSync(path.join(root, 'sessions')).sort(), [...seen].sort());
  for (const id of seen) assert.equal(fs.existsSync(path.join(root, 'sessions', id, 'daemon.json')), false, 'both daemons finished cleanly');
});

test('P9.9 plain commands under an orchestrator config never build the apparatus: no session, socket or grant is created', async t => {
  const root = tmpRoot('bounce-plain-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const {EventEmitter} = await import('node:events');
  let daemonChildren = 0, legacyChildren = 0;
  const spawnChild = (exe, args, opts) => {
    if (opts?.env?.BOUNCE_REMOTE_SESSION === '1') daemonChildren++; else legacyChildren++;
    const child = new EventEmitter();
    child.kill = () => {}; child.send = () => {};
    setTimeout(() => child.emit('close', 0, null), 20);
    return child;
  };
  for (const args of [['sessions'], ['sessions', '--json'], ['--help'], ['-v'], ['rename', 'x', 'y'], ['models'], ['skills', 'list'], ['--cwd', root, 'quota']]) {
    await withEnv({BOUNCE_HOME: root, BOUNCE_REMOTE_SESSION: '1'}, () => supervise(args, {spawnChild, adapters: {codex: completingAdapter()}}));
  }
  assert.equal(daemonChildren, 0, 'no plain command reached daemonSupervise');
  assert.equal(legacyChildren, 8);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false, 'no session directory was created');
});
