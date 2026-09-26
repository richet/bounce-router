import {readJournal} from '../src/core.js';
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {supervise, installControlAuthority, pidAlive} from '../src/reload.js';
import {createTypesafeLive} from '../src/adapters/typesafe-live.js';
import {socketPathFor, connectBus} from '../src/bus.js';
import {quotaFile} from '../src/quota.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const fakeCli = fileURLToPath(new URL('./helpers/fake-cli.js', import.meta.url));
const harnessPath = fileURLToPath(new URL('./helpers/daemon-harness.js', import.meta.url));

function tmpRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function writeConfig(root, order = ['codex']) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order, mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000,
    executables: Object.fromEntries(order.map(p => [p, fakeCli])), skills: {scope: 'user', autoSync: false}, // never the real user scope: autosync from an empty tmp store removes the user's installed skills
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
  const daemon = spawn(process.execPath, [harnessPath, 'run', 'hi', '--json'], {
    env: bounceEnv(root, {HARNESS_ADAPTER: kind, BOUNCE_DETACHED: '1'}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // What the daemon said and how it ended, for a failure message to show instead of a bare boolean.
  const trail = {stderr: '', exit: null};
  daemon.stderr.on('data', d => { trail.stderr = (trail.stderr + d).slice(-4000); });
  daemon.stdout.resume();
  daemon.once('exit', (code, signal) => { trail.exit = {code, signal}; });
  const id = await waitFor(() => {
    if (!fs.existsSync(path.join(root, 'sessions'))) return null;
    return fs.readdirSync(path.join(root, 'sessions')).find(candidate => fs.existsSync(path.join(root, 'sessions', candidate, 'daemon.json')));
  });
  const dir = path.join(root, 'sessions', id);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
  return {id, dir, info, trail};
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
  const journal = readJournal(path.join(dir, 'journal.jsonl')).events;
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
  const journal = readJournal(path.join(dir, 'journal.jsonl')).events;
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

// A worker probing `bounce` from its shell (observed while hunting the report schema) must not
// become a second, headless daemon: no session directory, no bus, a one-line refusal instead —
// even when the daemon's own process flags leak in, which vendorEnv/runProcess now also prevent.
test('a headless bare `bounce` in orchestrator config refuses before creating any session', async t => {
  const root = tmpRoot('bounce-headless-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order: ['codex'], mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000, executables: {codex: fakeCli},
    skills: {scope: 'user', autoSync: false}, operation: 'orchestrator', orchestrator: 'main',
    profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}},
  }));
  for (const flags of [{}, {BOUNCE_DETACHED: '1', BOUNCE_SUPERVISED: '1'}]) {
    const {code, stderr} = await run([], bounceEnv(root, flags), {timeout: 8000});
    assert.equal(code, 1, stderr);
    assert.match(stderr, /TUI requires a terminal/);
    assert.equal(fs.existsSync(path.join(root, 'sessions')) && fs.readdirSync(path.join(root, 'sessions')).length > 0, false, 'no session was created');
  }
});

// /operation switches the mode by restarting the session: the TUI saves the config and exits 75
// with a state naming the mode; supervise() then re-hosts the SAME session id under the other
// path — classic (no daemon, no BOUNCE_ROLE) ↔ orchestrator (daemon, BOUNCE_ROLE set) — and back.
test('a mode switch restarts the same session under the other supervisor path, in both directions', async t => {
  const root = tmpRoot('bounce-reoperate-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const {EventEmitter} = await import('node:events');
  const {Session} = await import('../src/core.js');
  const classicConfig = {order: ['codex'], mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000, executables: {codex: fakeCli}, skills: {scope: 'user', autoSync: false}};
  const orchestratorConfig = {...classicConfig, operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}};
  const saveConfig = config => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  saveConfig(classicConfig);
  const adapter = {async launch() { return {}; }, async *events() { await new Promise(() => {}); }, async cancel() { return {verified: true}; }};
  const spawns = [];
  const spawnChild = (_exe, args, options) => {
    const child = new EventEmitter();
    child.send = () => {}; child.kill = () => {};
    spawns.push({child, args, env: options.env});
    return child;
  };
  await withEnv({BOUNCE_HOME: root}, async () => {
    const seed = new Session(process.cwd(), {root});
    const id = seed.id;
    const state = operation => ({id, settings: {}, provider: 'codex', dev: false, operation});
    const done = supervise([], {spawnChild, adapters: {fake: adapter}, profiles: {main: {adapter: 'fake', mode: 'yolo', fallback: []}}});

    // 1. Classic TUI: no daemon apparatus in its env. It "runs" /operation orchestrator.
    await waitFor(() => spawns.length === 1);
    assert.equal(spawns[0].env.BOUNCE_ROLE, undefined);
    assert.equal(spawns[0].env.BOUNCE_SUPERVISED, '1');
    saveConfig(orchestratorConfig);
    spawns[0].child.emit('message', {type: 'restart', state: state('orchestrator')});
    spawns[0].child.emit('close', 75, null);

    // 2. The orchestrator TUI for the same session, under the daemon: BOUNCE_ROLE set, session resumed.
    await waitFor(() => spawns.length === 2);
    assert.equal(spawns[1].env.BOUNCE_ROLE, 'orchestrator');
    assert.equal(spawns[1].env.BOUNCE_REMOTE_SESSION, '1');
    assert.deepEqual(spawns[1].args.slice(-2), ['--resume', id]);
    assert.equal(JSON.parse(spawns[1].env.BOUNCE_RESTART).id, id);
    assert.equal(fs.existsSync(path.join(root, 'sessions', id, 'daemon.json')), true, 'the daemon hosts the session');
    // It "runs" /operation classic.
    saveConfig(classicConfig);
    spawns[1].child.emit('message', {type: 'restart', state: state('classic')});
    spawns[1].child.emit('close', 75, null);

    // 3. Back to a classic TUI for the same session: the daemon is gone, the state carries the id.
    await waitFor(() => spawns.length === 3);
    assert.equal(spawns[2].env.BOUNCE_ROLE, undefined);
    assert.equal(spawns[2].env.BOUNCE_SUPERVISED, '1');
    assert.deepEqual(JSON.parse(spawns[2].env.BOUNCE_RESTART), state('classic'));
    await waitFor(() => !fs.existsSync(path.join(root, 'sessions', id, 'daemon.json')));
    spawns[2].child.emit('close', 0, null);
    await done;
    assert.equal(spawns.length, 3);
  });
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
  const {id, dir, info, trail} = await runHarnessDaemon(root, 'hang');
  const stop = await run(['stop', id], bounceEnv(root), {timeout: 20000});
  assert.equal(stop.code, 0);
  assert.match(stop.stdout, /control\.stopped/);
  assert.match(stop.stdout, /"cancelled"/);
  await waitFor(() => !pidAlive(info.pid));
  assert.equal(fs.existsSync(path.join(dir, 'daemon.json')), false, `daemon ended ${JSON.stringify(trail.exit)} with daemon.json left; stop: ${stop.stdout}${stop.stderr}; daemon stderr: ${trail.stderr}`);
});

test('D5 stop with unverifiable termination exits 1, lists the unverified id, keeps daemon.json', async t => {
  const root = tmpRoot('bounce-d5-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const {id, dir, info: started, trail} = await runHarnessDaemon(root, 'stubborn');
  const stop = await run(['stop', id], bounceEnv(root), {timeout: 20000});
  assert.equal(stop.code, 1);
  assert.match(stop.stdout, /unverified/);
  assert.ok(fs.existsSync(path.join(dir, 'daemon.json')), 'daemon.json must remain so `sessions` can show it');
  // The daemon writes its final daemon.json asynchronously (after bus.close()
  // resolves); the `stop` client can exit slightly before that write lands.
  const info = await waitFor(() => {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
    return value.unverified ? value : null;
  }).catch(error => { throw new Error(`${error.message}; daemon ended ${JSON.stringify(trail.exit)}; stop: ${stop.stdout}${stop.stderr}; daemon stderr: ${trail.stderr}`); });
  assert.equal(info.unverified.length, 1);
  // Found in a gate (2026-09-25): the teardown's rmSync hit ENOTEMPTY while the daemon was still
  // writing its session; wait for it to exit, as D4 and D10 do.
  await waitFor(() => !pidAlive(started.pid));
});

// Incident (Phase 3 gate, 2026-09-12): under load the D5 daemon's main child survived the
// supervisor's SIGTERM and, holding the IPC channel, kept the daemon — and every runner
// waiting on the daemon's pipes — alive for minutes. Termination of the child is verified
// the same way a vendor process is (runProcess, verifiedCancel): SIGTERM, then SIGKILL.
test('D11 stop escalates to SIGKILL when the main child ignores SIGTERM, so a stuck child cannot hold the daemon', async t => {
  const root = tmpRoot('bounce-d11-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const {EventEmitter} = await import('node:events');
  const adapter = {
    async launch() { return {}; },
    async *events() { await new Promise(() => {}); },
    async cancel() { return {verified: true}; },
  };
  const kills = [];
  const spawnChild = () => {
    const child = new EventEmitter();
    child.send = () => {};
    // Ignores SIGTERM; only SIGKILL makes it close.
    child.kill = signal => { kills.push({signal, at: Date.now()}); if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    return child;
  };
  await withEnv({BOUNCE_HOME: root}, async () => {
    let session;
    const done = supervise(['run', 'hi'], {
      spawnChild,
      adapters: {fake: adapter},
      profiles: {main: {adapter: 'fake', mode: 'yolo', fallback: []}},
      onReady: async ({session: s, scheduler}) => {
        session = s;
        scheduler.submit({parent: null, profile: 'main', orders: 'x', deadline: null});
      },
    });
    await waitFor(() => kills.length === 0 && session);
    session.publish({kind: 'control.stop', from: 'user'});
    const outcome = await Promise.race([done.then(() => 'finished'), new Promise(r => setTimeout(r, 6000, 'still running after 6 s'))]);
    assert.equal(outcome, 'finished');
    assert.deepEqual(kills.map(k => k.signal), ['SIGTERM', 'SIGKILL']);
    const grace = kills[1].at - kills[0].at;
    assert.ok(grace >= 1400 && grace <= 3000, `SIGKILL must follow the ignored SIGTERM after the grace period, got ${grace} ms`);
  });
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

// ---- T3b orchestrator mode (O1-O6) ---------------------------------------
// The orchestrator profile is hosted as the main peer: its vendor CLI is a stand-in
// (test/helpers/fake-orchestrator-cli.js) that holds the orchestrator grant and drives
// the bridge, while the worker it delegates to runs on a fake task adapter injected
// through supervise()'s own {adapters} seam. No real vendor CLI is ever spawned.
const fakeOrchestratorCli = fileURLToPath(new URL('./helpers/fake-orchestrator-cli.js', import.meta.url));

function writeOrchestratorConfig(root, {orchestrator = 'main', profiles, order = ['codex']} = {}) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order, mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000,
    executables: Object.fromEntries(order.map(p => [p, fakeOrchestratorCli])),
    skills: {scope: 'user', autoSync: false},
    operation: 'orchestrator', orchestrator, profiles,
  }));
}

async function finalWorkerReport(profile) {
  const client = await connectBus({path: profile.report.BOUNCE_REPORT_BUS, token: fs.readFileSync(profile.report.BOUNCE_REPORT_TOKEN_FILE, 'utf8').trim()});
  try { await client.report({op: 'final', outcome: 'completed', phase: 'done', text: 'child done', next: 'none', summary: 'child done', evidence: [], remaining: ''}); }
  finally { await client.close(); }
}

const completingAdapter = () => ({
  async launch({profile}) { return {profile}; },
  async *events({profile}) { await finalWorkerReport(profile); yield {kind: 'result', status: 'completed', text: 'child done'}; },
  async cancel() { return {verified: true}; },
});

// Runs one whole orchestrator-mode session in this process (real spawned child, real bus,
// injected worker adapters) and returns the supervisor's own Session.
async function runOrchestratorSession(root, {adapters, env = {}}) {
  let session;
  await withEnv({BOUNCE_HOME: root, FAKE_ORCH_MODE: 'submit', FAKE_ORCH_PROFILE: 'build', ...env}, async () => {
    let timer;
    try {
      await Promise.race([
        supervise(['run', 'go'], {adapters, onReady: async ({session: s}) => { session = s; }}),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('orchestrator run did not finish within 25s')), 25000); }),
      ]);
    } finally { clearTimeout(timer); } // a live timer kept every daemon test file alive 25 s past its last test
  });
  return session;
}

const ABSENT_ORCHESTRATOR_ENV = {BOUNCE_BUS: 'absent', BOUNCE_BUS_TOKEN_FILE: 'absent', BOUNCE_ROLE: 'absent', BOUNCE_ORCHESTRATOR_PROFILE: 'absent'};

function writeClassicConfig(root) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order: ['codex'], mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000,
    executables: {codex: fakeOrchestratorCli}, skills: {scope: 'user', autoSync: false},
  }));
}

test('O1 classic: the main child gets no bus, token file, role or profile, and the journal has one user row', async t => {
  const root = tmpRoot('bounce-o1-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeClassicConfig(root);
  const {code, stdout} = await run(['run', 'hi', '--json'], bounceEnv(root, {FAKE_ORCH_MODE: 'env'}));
  assert.equal(code, 0);
  const rows = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(JSON.parse(rows.find(r => r.kind === 'assistant').text), ABSENT_ORCHESTRATOR_ENV);
  const dir = path.join(root, 'sessions', fs.readdirSync(path.join(root, 'sessions'))[0]);
  const journal = readJournal(path.join(dir, 'journal.jsonl')).events;
  assert.equal(journal.filter(r => r.kind === 'user').length, 1);
  assert.equal(journal.some(r => r.kind === 'task.submitted'), false);
});

// Rework round 1, item 1: the child's operation mode is decided by the validated config alone.
// A parent environment that already carries all four orchestrator vars (a nested bounce, an
// exported shell var, a stale export) must not smuggle orchestrator authority into a classic run.
test('O7 classic with all four orchestrator env vars pre-set in the parent: the vendor CLI still sees none', async t => {
  const root = tmpRoot('bounce-o7-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeClassicConfig(root);
  const {code, stdout} = await run(['run', 'hi', '--json'], bounceEnv(root, {
    FAKE_ORCH_MODE: 'env',
    BOUNCE_BUS: '/tmp/smuggled.sock', BOUNCE_BUS_TOKEN_FILE: '/tmp/smuggled.token',
    BOUNCE_ROLE: 'orchestrator', BOUNCE_ORCHESTRATOR_PROFILE: JSON.stringify({adapter: 'codex', model: '', mode: 'yolo'}),
  }));
  assert.equal(code, 0);
  const rows = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(JSON.parse(rows.find(r => r.kind === 'assistant').text), ABSENT_ORCHESTRATOR_ENV);
  // Classic stayed classic: no orchestrator brief on the prompt, no operation row.
  assert.equal(rows.find(r => r.kind === 'user').text, 'hi');
  assert.equal(rows.some(r => r.kind === 'operation'), false);
});

// Only the TUI ever called recordQuota from a raw event (src/cli.js); a headless daemon session
// never opened one, so a worker's quota reporting went unrecorded until the next `bounce quota`.
test('the daemon records quota from a worker\'s raw rate_limit_event, not only the TUI', async t => {
  const root = tmpRoot('bounce-quota-daemon-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'claude'}}});
  const raw = {type: 'rate_limit_event', rate_limit_info: {unifiedWindows: {five_hour: {utilization: 0.42, resetsAt: 1900000000}}}};
  const claudeWorker = {
    async launch({profile}) { return {profile}; },
    async *events({profile}) {
      yield {kind: 'raw', raw};
      await finalWorkerReport(profile);
      yield {kind: 'result', status: 'completed', text: 'child done'};
    },
    async cancel() { return {verified: true}; },
  };
  await runOrchestratorSession(root, {adapters: {codex: completingAdapter(), claude: claudeWorker}});
  const quota = JSON.parse(fs.readFileSync(quotaFile(root), 'utf8'));
  assert.deepEqual(quota.claude.windows, [{label: '5h', percent: 42, resetsAt: 1900000000000, minutes: 300}]);
});

test('O2 orchestrator single-provider: the orchestrator submits over the bridge, the worker completes, its wait returns', async t => {
  const root = tmpRoot('bounce-o2-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const session = await runOrchestratorSession(root, {adapters: {codex: completingAdapter()}});

  const submitted = session.events.find(e => e.kind === 'task.submitted');
  assert.equal(submitted.from, 'orchestrator');
  assert.equal(submitted.profile, 'build');
  const completed = session.events.find(e => e.kind === 'task.completed' && e.task === submitted.task);
  assert.equal(completed.from, `worker:${submitted.task}`);
  assert.equal(session.events.some(e => e.kind === 'assistant' && e.text === 'child completed'), true);
  assert.equal(session.events.filter(e => e.kind === 'user').length, 1);
  // The role brief: one prepended prompt line, and the ORDERS.md it points at.
  const ordersFile = path.join(session.dir, 'orchestrator', 'ORDERS.md');
  assert.equal(session.events.find(e => e.kind === 'user').text,
    `You are the orchestrator peer of session ${session.id}; the bounce bridge is available via BOUNCE_BUS/BOUNCE_BUS_TOKEN_FILE; see ${ordersFile}.\ngo`);
  const orders = fs.readFileSync(ordersFile, 'utf8');
  assert.equal(orders.includes(path.join(root, 'skills', 'agent-orchestrator', 'SKILL.md')), true);
  // Seeding runs before the orders are written, so the pointer resolves on a machine that has
  // never run `skills import`.
  const skillLine = orders.split('\n').find(line => line.startsWith('Skill: '));
  assert.equal(fs.existsSync(skillLine.slice('Skill: '.length)), true);
  assert.equal(orders.includes('BOUNCE_BUS_TOKEN_FILE='), true);
  // The orders govern over the user's own global CLAUDE.md/WORKFLOW.md (item 2): first lines say so.
  assert.match(orders, /^These orders govern this session\. Where the user's CLAUDE\.md or WORKFLOW\.md conflict with them/m);
  assert.equal(orders.includes('Never push, and never add'), true);
  assert.equal(orders.includes('AI attribution to commits or PRs.'), true);
  // Small work stays with the orchestrator (item 1): it may do it itself, not dispatch everything.
  assert.equal(orders.includes('Do small things yourself: answer questions, read files, run read-only checks, and run a short real-folder'), true);
  assert.equal(orders.includes('Dispatch a worker for anything that edits source or will take more than about five'), true);
  assert.equal(orders.includes('Delegate every implementation task to a worker profile below'), false);
  assert.equal(orders.includes('Do not edit the repository yourself and do not read bounce\'s own source'), false);
  // A retry may name its own next profile (item 3).
  assert.equal(orders.includes('After a failed attempt, you may name the next profile for the retry yourself and say why'), true);
  // No jev block: the Jev advice line is absent too, same as every other Jev-conditional line.
  assert.equal(orders.includes('A task.accepted row may carry advice from an unsure Jev review'), false);
  // Found live: a reviewer's 12 KB FAIL verdict reached the orchestrator cut at
  // 1,200 characters. It tried task_get, four shapes of `bounce wait` and two --help pages, concluded the
  // bridge had no full-report option, and began re-reading the source itself. The option now exists; the
  // orders are where it learns that, since the same orders forbid reading the journal.
  assert.equal(orders.includes('`task_get` with `full: true` (or `bounce task <id> --report`)'), true,
    'the orders name the one way to read a finished report in full');
  // The stated capability is the bus's own allowlist (src/bus.js PEER_KINDS), verbatim.
  assert.equal(orders.includes('You may publish only: task.submitted, task.accepted, task.rework, task.milestone, task.blocked, task.input_required, task.usage, task.activity, message.'), true);
  // steps is refused-without when the completion reviewer is a verifier, so the brief has to name it.
  assert.equal(orders.includes('steps (the verification steps, as text) — required when the completion reviewer is a verifier profile'), true);
  // Milestone/report contract is a worker instruction, not an orchestrator order (item 7): the
  // orchestrator only reads outcomes and does not publish milestones on a worker's behalf.
  assert.equal(orders.includes('Workers report their own progress and final result through `bounce report`/their report tool'), true);
  assert.equal(orders.includes('you do not publish milestones for them'), true);
  assert.equal(orders.includes('Publish task.milestone with task, phase, text, next, and evidence'), false);
  assert.equal(orders.includes('A Codex worker calls its scoped `bounce_report` tool'), false);
  // The input prefill (Tab, Enter) needs the answer to state its next prompt; nothing else asked for it.
  assert.equal(orders.includes('end the answer with one line `Next: <the prompt, as the user would type it>`'), true, 'the orchestrator is asked for the prefill line');
  assert.equal(orders.includes('A live container check (starting Docker, inspecting or running one) needs requires including "docker", and only a worker that may write gets it: a read-only or probing analyst never reaches Docker, because a container can write the checkout. Send live container checks to a builder.'), true, 'docker only for workers that may write');
  // Found live (session 159f4746): the orchestrator offered to commit, then sent the commit to workers seven
  // times — each found a copy with no .git. Docs/plans/in-place-tasks.md: an in-place task is now the way.
  assert.equal(orders.includes('Workers run in copies of the repository: only an in-place task (task.submitted with `inPlace: {authorizedBy: <seq>}`) runs in the real checkout, for a version-control or other real-folder step (commit, push, open a PR) the user\'s own message asked for. Cite that message\'s seq (omit authorizedBy to cite the user\'s latest message) and keep the orders to exactly what it asked — push and PR only when it asked for them. A refusal names what exceeded the request.'), true, 'the orchestrator knows how to use an in-place task');
  // No `jev` block in config.json: the brief is exactly today's — no auto roster line, no Jev
  // sentence, and the synthetic reviewer is neither a submit target nor the example's profile.
  assert.equal(orders.includes('auto →'), false);
  assert.equal(/jev/i.test(orders), false);
  // the example submits to a JOB (the first agent), never to a cloud profile by name
  assert.equal(orders.includes('"profile":"analyst"'), true);
  assert.match(orders, /^Who to submit to — the job, not the AI:$/m);
  // The team block: where the roster comes from, which AIs exist here, and how to change it —
  // the orchestrator specialises the shipped defaults through the bridge, never by hand.
  assert.match(orders, /^Team: analyst, builder, debugger, reviewer ← skill agent-orchestrator$/m);
  assert.equal(orders.includes('debugger to root-cause a failure that resisted a first attempt'), true, 'every shipped job is named in the choosing orders');
  assert.match(orders, /^AIs on this machine: codex, lmstudio\/<loaded model> \(via opencode\)$/m);
  assert.match(orders, /bounce agents set NAME --scope project/);
  assert.match(orders, /references\/team\.md/);
  assert.match(orders, /^`bounce agents set` journals agents\.defined for you\.$/m);
});

test('O3 the orchestrator grant cannot publish a user row (even with `from` omitted) nor control.stop', async t => {
  const root = tmpRoot('bounce-o3-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const session = await runOrchestratorSession(root, {adapters: {codex: completingAdapter()}, env: {FAKE_ORCH_FORGE: '1'}});

  // The forgery omits `from` entirely, so the bus cannot fall back to the from-mismatch rule:
  // `user` is simply not a kind any peer may publish, and control.* is the user peer's alone.
  const tried = JSON.parse(session.events.filter(e => e.kind === 'assistant').map(e => e.text).find(text => text.includes('user')));
  assert.deepEqual(tried, {user: 'refused -32001', stop: 'refused -32001'});
  assert.equal(session.events.filter(e => e.kind === 'user').length, 1);
  assert.equal(session.events.find(e => e.kind === 'user').text.endsWith('\ngo'), true);
  assert.equal(session.events.some(e => e.kind === 'control.stop'), false);
  assert.equal(session.events.some(e => e.kind === 'control.stopped'), false);
  // The daemon stayed up for the whole delegation: the child still completed after the forgeries.
  assert.equal(session.events.some(e => e.kind === 'task.completed'), true);
  assert.equal(session.events.some(e => e.kind === 'assistant' && e.text === 'child completed'), true);
});

test('O4 multi-provider: orchestrator on codex delegates to a muse profile; sessions JSON reports the mode', async t => {
  const root = tmpRoot('bounce-o4-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'muse'}}});
  const session = await runOrchestratorSession(root, {adapters: {codex: completingAdapter(), muse: completingAdapter()}});

  const submitted = session.events.find(e => e.kind === 'task.submitted');
  assert.equal(submitted.from, 'orchestrator');
  const started = session.events.find(e => e.kind === 'task.started' && e.task === submitted.task);
  assert.equal(started.from, `worker:${submitted.task}`);
  assert.equal(session.events.find(e => e.kind === 'peer.joined' && e.name === `worker:${submitted.task}`).adapter, 'muse');
  assert.equal(session.events.some(e => e.kind === 'assistant' && e.text === 'child completed'), true);

  const {code, stdout} = await run(['sessions', '--json'], bounceEnv(root));
  assert.equal(code, 0);
  const listed = JSON.parse(stdout).find(s => s.id === session.id);
  assert.equal(listed.operation, 'orchestrator');
  assert.equal(listed.orchestrator, 'main');
});

test('O5 invalid orchestration config: exit 1 with the validation error, and nothing is launched', async t => {
  const root = tmpRoot('bounce-o5-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {orchestrator: 'absent', profiles: {main: {adapter: 'codex'}}});
  const {code, stderr} = await run(['run', 'go', '--json'], bounceEnv(root));
  assert.equal(code, 1);
  assert.match(stderr, /orchestrator must name a profile/);
  const sessionsDir = path.join(root, 'sessions');
  const ids = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  for (const id of ids) {
    assert.equal(fs.existsSync(path.join(sessionsDir, id, 'daemon.json')), false);
    assert.equal(fs.existsSync(socketPathFor(path.join(sessionsDir, id))), false);
  }
});

// A worker's token file, found the way anything outside the daemon must find it: by looking in
// the session's own tokens directory. The daemon keeps the path in a Map of its own, not on the row.
const workerTokenFile = (session, task) => {
  const dir = path.join(session.dir, 'tokens');
  const name = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.startsWith(`worker_${task}`)) : undefined;
  return name ? path.join(dir, name) : null;
};

// Drives one orchestrator-mode session whose worker is held open until `release()`, so a test can
// observe the grant mid-flight and then decide how the task goes terminal.
async function withRunningWorker(root, body) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gated = {
    async launch({profile}) { return {profile}; },
    async *events({profile}) { await gate; await finalWorkerReport(profile); yield {kind: 'result', status: 'completed', text: 'child done'}; },
    async cancel() { return {verified: true}; },
  };
  let session;
  await withEnv({BOUNCE_HOME: root, FAKE_ORCH_MODE: 'submit', FAKE_ORCH_PROFILE: 'build'}, async () => {
    const done = supervise(['run', 'go'], {adapters: {codex: gated}, onReady: async ({session: s}) => { session = s; }});
    const started = await waitFor(() => session?.events.find(e => e.kind === 'task.started'), {timeout: 20000});
    // The daemon runs in this process: a failed assertion must still let the worker finish and
    // the daemon exit, or the leaked bus/child keeps the whole test runner alive.
    try { await body({session, started, release}); }
    finally { release(); await done; }
  });
}

// Short on purpose: the daemon revokes every grant on its own exit too, so a revoke this test
// only sees after the daemon tears down (≥20s, once the orchestrator's own wait times out)
// would prove nothing about the terminal-row rule.
const REVOKE_TIMEOUT = {timeout: 5000};

test('O6 worker grant lifecycle: a token file exists from task.started and is revoked on task.completed', async t => {
  const root = tmpRoot('bounce-o6-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  await withRunningWorker(root, async ({session, started, release}) => {
    const tokenFile = workerTokenFile(session, started.task);
    assert.equal(typeof tokenFile, 'string');
    assert.equal(fs.existsSync(tokenFile), true);
    assert.equal('tokenFile' in started, false, 'the token path is daemon-side state, never a journaled field');
    release();
    await waitFor(() => session.events.some(e => e.kind === 'task.completed'), {timeout: 20000});
    await waitFor(() => workerTokenFile(session, started.task) === null, REVOKE_TIMEOUT);
  });
});

// Rework round 1, item 2: task.deadline is the fourth terminal kind (reducers.js maps it to the
// `timed_out` state); there is no `task.timed_out` row for the revoke to key on.
test('O8 a task.deadline row revokes the worker grant just like a completion does', async t => {
  const root = tmpRoot('bounce-o8-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  await withRunningWorker(root, async ({session, started}) => {
    assert.equal(fs.existsSync(workerTokenFile(session, started.task)), true);
    session.append({kind: 'task.deadline', task: started.task, context: started.context});
    await waitFor(() => workerTokenFile(session, started.task) === null, REVOKE_TIMEOUT);
    assert.equal(session.events.find(e => e.kind === 'task.deadline').task, started.task);
  });
});

// Rework round 1, item 4: `tasks: []` is the grant's starting point, not its ceiling — the daemon
// widens it in place as the orchestrator opens tasks, so it can report on its own work and no other.
test('O9 the orchestrator may publish a milestone for the task it submitted, and never for a foreign id', async t => {
  const root = tmpRoot('bounce-o9-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
  const session = await runOrchestratorSession(root, {adapters: {codex: completingAdapter()}, env: {FAKE_ORCH_MILESTONE: '1'}});

  const submitted = session.events.find(e => e.kind === 'task.submitted');
  const tried = JSON.parse(session.events.filter(e => e.kind === 'assistant').map(e => e.text).find(text => text.includes('own')));
  assert.deepEqual(tried, {own: 'accepted', foreign: 'refused -32001'});
  const milestone = session.events.find(e => e.kind === 'task.milestone');
  assert.equal(milestone.from, 'orchestrator');
  assert.equal(milestone.task, submitted.task);
  assert.equal(milestone.text, 'mine');
  assert.equal(session.events.some(e => e.kind === 'task.milestone' && e.task === 'foreign-task-id'), false);
});

// Jev (src/jev.js) end to end through the daemon: the config's `jev` block, the registered
// `jev` critic, the bus's prepare hook, the typesafe adapter on a stubbed fetch, and the
// orchestrator's wait resolving on the accept — plus the ORDERS.md lines that tell it.
test('O-jev orchestrator with Jev review on: the root task is Jev-reviewed before its wait resolves, and ORDERS.md says so', async t => {
  const root = tmpRoot('bounce-ojev-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeOrchestratorConfig(root, {profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex', tier: 'mid'}}});
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({...config, jev: {enabled: true, review: true, routing: false}}));
  // A cached roster note (src/roster-notes.js) reaches ORDERS.md; routing is off here so the daemon never describes anything itself.
  fs.writeFileSync(path.join(root, 'roster-notes.json'), JSON.stringify({'codex/default': {tier: 'strongest', capabilities: 'Steady on routine implementation.', by: 'claude/opus'}}));
  const bodies = [];
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({model: 'jev-1.13.0', answers: {decision: {type: 'choice', choice: 'accept', probabilities: {accept: 0.96, rework: 0.04}, confidence: 0.93}}, usage: {input_tokens: 40, output_tokens: 2}})};
  };
  // the session's folder is a temp dir, not a repository: answer the repository probe so the verdict is asked
  const typesafe = createTypesafeLive({fetchImpl, readKey: () => ({key: 'daemon-test-key-4242', source: 'env'}), readSettings: () => ({enabled: true, model: 'jev-1.13.0', review: true, routing: {enabled: false, default: null}, confidence: 0.8}), git: async args => args[0] === 'rev-parse' ? 'true\n' : ''});
  const session = await runOrchestratorSession(root, {adapters: {codex: completingAdapter(), typesafe}});

  const submitted = session.events.find(e => e.kind === 'task.submitted');
  assert.deepEqual(submitted.review, {completion: 'jev'}, 'the bus journaled the decorated row');
  const kinds = session.events.filter(e => e.task === submitted.task).map(e => e.kind);
  assert.ok(kinds.indexOf('task.completed') < kinds.indexOf('review.started') && kinds.indexOf('review.started') < kinds.indexOf('jev.verdict') && kinds.indexOf('jev.verdict') < kinds.indexOf('task.accepted'), kinds.join(','));
  const verdict = session.events.find(e => e.kind === 'jev.verdict');
  assert.equal(verdict.verdict, 'accept');
  assert.equal(verdict.confidence, 0.93);
  assert.equal(session.events.find(e => e.kind === 'review.started').profile, 'jev');
  assert.equal(session.events.some(e => e.kind === 'assistant' && e.text === 'child ended: task.accepted'), true, 'the orchestrator\'s wait resolved on the accept');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].state.orders, 'child orders');
  assert.equal(bodies[0].state.report.summary, 'child done');
  const journal = fs.readFileSync(path.join(session.dir, 'journal.jsonl'), 'utf8');
  assert.equal(journal.includes('daemon-test-key-4242'), false);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8').includes('daemon-test-key-4242'), false);
  const orders = fs.readFileSync(path.join(session.dir, 'orchestrator', 'ORDERS.md'), 'utf8');
  // The roster prose (tier/capabilities per profile) is gone (item 6): just the one-line roster.
  assert.match(orders, /^Worker profiles \(one AI each\): [\w, ]*\bbuild\b[\w, ]* — name one only when the user asks for that AI, or for a retry \(see above\)\.$/m);
  assert.equal(session.events.some(e => e.kind === 'jev.roster' || (e.kind === 'jev.skipped' && e.reason === 'roster')), false);
  assert.equal(orders.includes('jev →'), false, 'the synthetic reviewer is not a roster entry');
  assert.match(orders, /auto → Jev routing is off \(\/jev routing on\): resolves to build/);
  assert.match(orders, /Jev completion verdicts are on/);
  assert.equal(orders.includes('"profile":"analyst"'), true, 'the example names a job, never the synthetic reviewer');
  assert.equal('head' in session.events.find(e => e.kind === 'task.started'), true, 'the Jev-reviewed task records its diff base');
});
