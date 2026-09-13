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
