import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {supervise, installControlAuthority, pidAlive} from '../src/reload.js';
import {socketPathFor} from '../src/bus.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const fakeCli = fileURLToPath(new URL('./helpers/fake-cli.js', import.meta.url));
const harnessPath = fileURLToPath(new URL('./helpers/daemon-harness.js', import.meta.url));

function tmpRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function writeConfig(root, order = ['codex']) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order, mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000,
    executables: Object.fromEntries(order.map(p => [p, fakeCli])), skills: {scope: 'user', autoSync: true},
  }));
}

function bounceEnv(root, extra = {}) {
  return {...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1', ...extra};
}

function run(args, env, {timeout = 15000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${args.join(' ')}\n${stdout}\n${stderr}`)); }, timeout);
    child.once('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
    child.once('error', reject);
    child.stdin.end();
  });
}

const waitFor = async (fn, {timeout = 5000, interval = 20} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, interval));
  }
};

// Temporarily sets process.env vars for a direct, in-process supervise() call (used
// by tests that inject adapters/profiles through the seam rather than spawning a real
// subprocess), restoring whatever was there before.
async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}

// Spawns test/helpers/daemon-harness.js as a real, separate OS process: it calls the
// real supervise() with a fake task adapter installed through the {adapters, profiles}
// seam (never an env-gated adapter in shipped code) and BOUNCE_DETACHED=1 so it behaves
// like a backgrounded daemon. Returns once daemon.json is on disk.
async function runHarnessDaemon(root, kind) {
  writeConfig(root);
  spawn(process.execPath, [harnessPath, 'run', 'hi', '--json'], {
    env: bounceEnv(root, {HARNESS_ADAPTER: kind, BOUNCE_DETACHED: '1'}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const id = await waitFor(() => {
    if (!fs.existsSync(path.join(root, 'sessions'))) return null;
    return fs.readdirSync(path.join(root, 'sessions')).find(candidate => fs.existsSync(path.join(root, 'sessions', candidate, 'daemon.json')));
  });
  const dir = path.join(root, 'sessions', id);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
  return {id, dir, info};
}

test('D1 legacy run unchanged: exit 0, route+turn rows, journal seq, no daemon/bus left behind', async t => {
  const root = tmpRoot('bounce-d1-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const {code, stdout} = await run(['run', 'hi', '--json'], bounceEnv(root));
  assert.equal(code, 0);
  assert.equal(stdout.includes('"provisional"'), false, 'no provisional row should ever reach stdout');
  const rows = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(rows.filter(r => r.kind === 'route').length, 1, 'expected exactly one route row');
  assert.equal(rows.filter(r => r.kind === 'turn').length, 1, 'expected exactly one turn row');
  assert.equal(rows.filter(r => r.kind === 'attempt').length, 1, 'expected exactly one attempt row');
  assert.equal(rows.at(-1).kind, 'turn', 'the turn row must be the tail of the run, not dropped by exit');
  assert.equal(rows.at(-1).text, 'completed');
  const sessionsDir = path.join(root, 'sessions');
  const ids = fs.readdirSync(sessionsDir);
  assert.equal(ids.length, 1);
  const dir = path.join(sessionsDir, ids[0]);
  const journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(journal.map(r => r.seq), journal.map((_, i) => i + 1));
  assert.equal(fs.existsSync(path.join(dir, 'daemon.json')), false);
  assert.equal(fs.existsSync(socketPathFor(dir)), false);
});

// Race detector: a RemoteSession child that exits before its final IPC round trip
// completes drops the tail rows (attempt, turn) intermittently, not every time — five
// back-to-back runs make that race show up reliably if it regresses.
test('D1b five back-to-back runs each end with a turn row (no dropped tail rows)', async t => {
  const root = tmpRoot('bounce-d1b-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  for (let i = 0; i < 5; i++) {
    const {code, stdout} = await run(['run', `hi-${i}`, '--json'], bounceEnv(root));
    assert.equal(code, 0, `run #${i} exit code`);
    const rows = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(rows.at(-1)?.kind, 'turn', `run #${i} must end with a turn row, got: ${JSON.stringify(rows.at(-1))}`);
    assert.equal(rows.at(-1).text, 'completed', `run #${i} turn row`);
  }
});

// BLOCKER fix (T3b rework round 2): the run/TUI child must never receive bus authority
// — only BOUNCE_REMOTE_SESSION signals the remote-session decision. A vendor CLI spawned
// as this child's own subprocess (runProcess) inherits its env, so if BOUNCE_BUS /
// BOUNCE_BUS_TOKEN_FILE ever leaked in there, a stand-in/compromised vendor CLI could
// forge a `user` row (e.g. control.stop) straight over the bus.
test('the run child never receives bus/token env vars, so a vendor CLI cannot forge bus access', async t => {
  const root = tmpRoot('bounce-envprobe-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const {code, stdout} = await run(['run', 'hi', '--json'], bounceEnv(root, {FAKE_CLI_PROBE_ENV: '1'}));
  assert.equal(code, 0);
  const rows = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const probeRow = rows.find(r => r.kind === 'assistant');
  assert.ok(probeRow, 'expected the probe agent_message row');
  const probe = JSON.parse(probeRow.text);
  assert.equal(probe.bus, 'absent');
  assert.equal(probe.token, 'absent');
  const sessionsDir = path.join(root, 'sessions');
  const dir = path.join(sessionsDir, fs.readdirSync(sessionsDir)[0]);
  const journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(journal.filter(r => r.kind === 'user').length, 1, 'exactly the one real user row, nothing forged');
});

test('legacy no-regression: --help and sessions never create a daemon or bus', async t => {
  const root = tmpRoot('bounce-legacy-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const help = await run(['--help'], bounceEnv(root));
  assert.equal(help.code, 0);
  const sessions = await run(['sessions'], bounceEnv(root));
  assert.equal(sessions.code, 0);
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'daemon.json')), false);
  const anyDaemonFiles = fs.existsSync(path.join(root, 'sessions'))
    ? fs.readdirSync(path.join(root, 'sessions')).some(id => fs.existsSync(path.join(root, 'sessions', id, 'daemon.json')))
    : false;
  assert.equal(anyDaemonFiles, false);
});

test('D2 restart keeps workers: a task submitted before a /restart (exit 75) stays running and receives a milestone after', async t => {
  const root = tmpRoot('bounce-d2-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const {EventEmitter} = await import('node:events');

  let releaseMilestone;
  const gate = new Promise(resolve => { releaseMilestone = resolve; });
  const adapter = {
    async launch() { return {}; },
    async *events() {
      await gate;
      yield {kind: 'milestone', text: 'post-restart', evidence: null};
      await new Promise(() => {}); // then hang: the attached-exit path cancels it below
    },
    async cancel() { return {verified: true}; },
  };

  const children = [];
  const spawnChild = () => {
    const child = new EventEmitter();
    child.send = () => {};
    child.kill = () => {};
    children.push(child);
    return child;
  };

  await withEnv({BOUNCE_HOME: root}, async () => {
    let scheduler, taskId;
    const donePromise = supervise(['run', 'hi'], {
      spawnChild,
      adapters: {fake: adapter},
      profiles: {main: {adapter: 'fake', mode: 'yolo', fallback: []}},
      onReady: async ({scheduler: s}) => {
        scheduler = s;
        const row = s.submit({parent: null, profile: 'main', orders: 'x', deadline: null});
        taskId = row.task;
      },
    });

    await waitFor(() => children.length === 1);
    await waitFor(() => scheduler.tasks()[taskId]?.state === 'running');

    // Simulate the child's own /restart: it tells the supervisor to keep the session
    // alive and exits 75.
    children[0].emit('message', {type: 'restart', state: {id: 'resumed', settings: {}, provider: 'codex', dev: false}});
    children[0].emit('close', 75, null);

    await waitFor(() => children.length === 2);
    assert.equal(scheduler.tasks()[taskId].state, 'running', 'task must still be running across the restart');

    releaseMilestone();
    await waitFor(() => scheduler.tasks()[taskId]?.lastMilestone?.text === 'post-restart');

    // Let the second (restarted) child exit normally: attached mode now cancels the
    // still-running tree itself (decision 2), so no explicit scheduler.stop() needed.
    children[1].emit('close', 0, null);
    await donePromise;
    assert.equal(scheduler.tasks()[taskId].state, 'cancelled');
  });
});

// Decision (T3b rework round 2, item 2): attached `bounce run` must not drain forever
// just because a delegated task is still running when its own child process exits —
// it cancels the tree, the same way `stop` does, and returns.
test('attached run cancels a live task when its own child exits, within 5s (task.cancelled)', async t => {
  const root = tmpRoot('bounce-attached-cancel-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const hang = {
    async launch() { return {}; },
    async *events() { await new Promise(() => {}); },
    async cancel() { return {verified: true}; },
  };
  await withEnv({BOUNCE_HOME: root}, async () => {
    let session;
    const start = Date.now();
    await Promise.race([
      supervise(['run', 'hi'], {
        adapters: {hang},
        profiles: {main: {adapter: 'codex', mode: 'yolo', fallback: []}, hang: {adapter: 'hang', mode: 'yolo', fallback: []}},
        onReady: async ({session: sess, scheduler}) => {
          session = sess;
          scheduler.submit({parent: null, profile: 'hang', orders: 'x', deadline: null});
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('attached run with a live task did not exit within 5s')), 5000)),
    ]);
    assert.ok(Date.now() - start < 5000);
    assert.ok(session.events.some(e => e.kind === 'task.cancelled'), 'expected the hanging task to be cancelled when the run child exited');
  });
});

// Decision (item 6): foreground `bounce run` keeps HEAD's exit codes — SIGTERM still
// exits 130, exactly like the pre-Phase-2 supervisor, even though this process now
// also owns a bus/scheduler.
test('foreground bounce run SIGTERM exits 130 (HEAD parity)', async t => {
  const root = tmpRoot('bounce-sigterm130-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const child = spawn(process.execPath, [cliPath, 'run', 'hi', '--json'], {env: bounceEnv(root, {FAKE_CLI_HANG: '1'}), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  await waitFor(() => stdout.includes('"kind":"route"'));
  child.kill('SIGTERM');
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 130);
});

test('D8 control.* authority: only the user peer may trigger a stop', async () => {
  const listeners = new Set();
  const session = {subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  let stopCalls = 0;
  const scheduler = {stop: async () => { stopCalls++; return {cancelled: ['t1'], unverified: []}; }};
  let stopped = null;
  installControlAuthority({session, scheduler, onStopped: result => { stopped = result; }});
  const publish = row => { for (const fn of listeners) fn(row); };

  publish({kind: 'control.stop', from: 'worker:x'});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(stopCalls, 0, 'a worker must never trigger a stop');
  assert.equal(stopped, null);

  publish({kind: 'control.stop', from: 'user'});
  await waitFor(() => stopCalls === 1);
  assert.deepEqual(stopped, {cancelled: ['t1'], unverified: []});
});

test('D9 attach to a nonexistent or dead session prints "not running" and exits 1', async t => {
  const root = tmpRoot('bounce-d9-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const missing = await run(['attach', 'never-existed'], bounceEnv(root));
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /not running/);

  const id = 'dead-session-1';
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({pid: 999999, bus: '/tmp/nonexistent.sock', started: new Date().toISOString(), userToken: '/tmp/nope'}));
  const dead = await run(['attach', id], bounceEnv(root));
  assert.equal(dead.code, 1);
  assert.match(dead.stdout, /not running/);
});

// D3 rework (item 9): no wall-clock assertion, no FAKE_CLI_DELAY_MS race — attach only
// starts once daemon.json exists, and the fake CLI is held open on a file trigger this
// test writes only after attach has already printed its first (replayed) row, so the
// `turn` row genuinely streams to a client that was already attached.
test('D3 --detach returns immediately with an id; attach streams then exits when the daemon does; cleans up', async t => {
  const root = tmpRoot('bounce-d3-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const trigger = path.join(root, 'finish-turn');
  const detach = await run(['run', 'hi', '--detach', '--json'], bounceEnv(root, {FAKE_CLI_WAIT_FILE: trigger}));
  assert.equal(detach.code, 0);
  const {id} = JSON.parse(detach.stdout.trim());
  assert.ok(id);
  const dir = path.join(root, 'sessions', id);
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.json')));
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
  assert.ok(pidAlive(info.pid), 'daemon pid must be alive right after detach');

  const attachChild = spawn(process.execPath, [cliPath, 'attach', id, '--json'], {env: bounceEnv(root), stdio: ['ignore', 'pipe', 'pipe']});
  let attachOut = '', sawFirstRow = false;
  const firstRow = new Promise(resolve => {
    attachChild.stdout.on('data', d => {
      attachOut += d;
      if (!sawFirstRow && attachOut.includes('\n')) { sawFirstRow = true; resolve(); }
    });
  });
  await firstRow;
  fs.writeFileSync(trigger, 'go');
  const code = await new Promise(resolve => attachChild.once('close', resolve));
  assert.equal(code, 0);
  const rows = attachOut.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(rows.some(r => r.kind === 'turn'), 'attach must stream the turn row');

  await waitFor(() => !fs.existsSync(path.join(dir, 'daemon.json')));
  await waitFor(() => !pidAlive(info.pid));
});

test('D4 stop cancels a hanging task, prints control.stopped, exits 0, daemon dies and daemon.json is gone', async t => {
  const root = tmpRoot('bounce-d4-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const {id, dir, info} = await runHarnessDaemon(root, 'hang');
  const stop = await run(['stop', id], bounceEnv(root), {timeout: 20000});
  assert.equal(stop.code, 0);
  assert.match(stop.stdout, /control\.stopped/);
  assert.match(stop.stdout, /"cancelled"/);
  await waitFor(() => !pidAlive(info.pid));
  assert.equal(fs.existsSync(path.join(dir, 'daemon.json')), false);
});

test('D5 stop with unverifiable termination exits 1, lists the unverified id, keeps daemon.json', async t => {
  const root = tmpRoot('bounce-d5-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const {id, dir} = await runHarnessDaemon(root, 'stubborn');
  const stop = await run(['stop', id], bounceEnv(root), {timeout: 20000});
  assert.equal(stop.code, 1);
  assert.match(stop.stdout, /unverified/);
  assert.ok(fs.existsSync(path.join(dir, 'daemon.json')), 'daemon.json must remain so `sessions` can show it');
  // The daemon writes its final daemon.json asynchronously (after bus.close()
  // resolves); the `stop` client can exit slightly before that write lands.
  const info = await waitFor(() => {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
    return value.unverified ? value : null;
  });
  assert.equal(info.unverified.length, 1);
});

test('D10 SIGTERM to a daemon with a running task cancels it and removes bus.sock/daemon.json', async t => {
  const root = tmpRoot('bounce-d10-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const {dir, info} = await runHarnessDaemon(root, 'hang');
  const spath = socketPathFor(dir);
  await waitFor(() => fs.existsSync(spath));

  process.kill(info.pid, 'SIGTERM');
  await waitFor(() => !pidAlive(info.pid), {timeout: 5000});
  assert.equal(fs.existsSync(path.join(dir, 'daemon.json')), false);
  assert.equal(fs.existsSync(spath), false);
  // Explicit choice: the detached daemon catches SIGTERM, cancels the tree, and exits
  // 143 (128+SIGTERM) itself via process.exit(143) — asserted directly in the
  // foreground-SIGTERM test above as 130 for the attached case (HEAD parity); here
  // there is no foreground parent to synchronously observe this background process's
  // own exit code against, so this test only checks the cleanup side effects.
});
