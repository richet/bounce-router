// End to end through `bounce` (T8): the real src/cli.js is spawned as a user would run it,
// with BOUNCE_HOME in a tmp root and every vendor CLI replaced by a fake under test/helpers/.
// No real vendor CLI is ever reachable: writeE2EConfig sets `executables` for all three
// providers last, from a fixed map of fakes, whatever else a caller asks for.
//
// Probes E1, E3, E4 and E6 of the T8 brief are NOT here: they need a worker to actually launch
// on a live adapter, which no shipped surface can do yet. The gap is pinned by the last test in
// this file (see its comment) and reported with the task.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {supervise, pidAlive} from '../src/reload.js';
import {takeCheckpoint} from '../src/checkpoint.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const helper = name => fileURLToPath(new URL(`./helpers/${name}`, import.meta.url));

// Applied last in every config this file writes: no provider name can resolve to a real binary.
const FAKE_EXECUTABLES = {
  claude: helper('fake-claude.js'),
  codex: helper('fake-orchestrator-cli.js'),
  muse: helper('fake-muse.js'),
};

const tmpRoot = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const bounceEnv = (root, extra = {}) => ({...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1', ...extra});

function writeE2EConfig(root, {operation, orchestrator, profiles, executables} = {}) {
  const settings = {
    order: ['codex'], mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000,
    skills: {scope: 'user', autoSync: false},
    ...(operation ? {operation, orchestrator, profiles} : {}),
  };
  settings.executables = {...FAKE_EXECUTABLES, ...executables}; // last, always: every name is a fake
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(settings));
}

function run(args, env, {timeout = 20000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${args.join(' ')}\n${stdout}\n${stderr}`)); }, timeout);
    child.once('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
    child.once('error', reject);
  });
}

const waitFor = async (fn, {timeout = 20000, interval = 20} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, interval));
  }
};

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) { previous[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}

const journalOf = dir => fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

// Starts a real `bounce run` in orchestrator mode as its own OS process and returns once the
// daemon has published its socket and minted the orchestrator grant. The orchestrator's CLI is
// fake-orchestrator-cli.js in FAKE_ORCH_MODE=submit, which holds the turn open (waiting up to
// 20 s for its child's completion) — that wait is the window in which a probe drives the bridge.
async function startOrchestratorDaemon(root, cwd, env = {}) {
  const child = spawn(process.execPath, [cliPath, 'run', 'go', '--json', '--cwd', cwd], {
    env: bounceEnv(root, {FAKE_ORCH_MODE: 'submit', FAKE_ORCH_PROFILE: 'build', ...env}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  const id = await waitFor(() => {
    const sessions = path.join(root, 'sessions');
    if (!fs.existsSync(sessions)) return null;
    return fs.readdirSync(sessions).find(candidate => fs.existsSync(path.join(sessions, candidate, 'daemon.json')));
  });
  const dir = path.join(root, 'sessions', id);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
  const orchestratorToken = await waitFor(() => {
    const tokens = path.join(dir, 'tokens');
    const name = fs.existsSync(tokens) ? fs.readdirSync(tokens).find(f => f.startsWith('orchestrator-')) : undefined;
    return name ? path.join(tokens, name) : null;
  });
  return {child, id, dir, info, orchestratorToken, stdout: () => stdout};
}

// ---- E2 ------------------------------------------------------------------
// CONTRACT.md §4 (amendment A2): the availableStarts check and the reservation are one
// synchronous span, before the checkpoint's own await — an await between check and
// reservation would let two concurrent submits over-reserve the same root (see W8 in
// test/watchdog.test.js). So a baseline refusal here DOES reserve, then releases what it
// never consumed; this probe takes the checkpoint on the clean tree and dirties the tracked
// file before submitting, which is the alternative the brief names.
test('E2 baseline refusal: a task submitted against a checkpoint the tree no longer matches fails with reason "baseline" and never launches', async t => {
  const root = tmpRoot('bounce-e2-');
  const cwd = tmpRoot('bounce-e2-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  // The main conversation is a plain (classic) fake turn here; the probe is about the worker.
  writeE2EConfig(root, {executables: {codex: helper('fake-cli.js')}});

  const git = args => execFileSync('git', ['-c', 'user.email=e2e@bounce.test', '-c', 'user.name=e2e', ...args], {cwd, stdio: ['ignore', 'pipe', 'ignore']});
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'seed']);

  // A fake runner: the tree comparison is head/status/diff only (src/checkpoint.js sameTree),
  // so the verified test/check result is supplied rather than run.
  const fakeRun = () => ({status: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n'});
  const checkpoint = await takeCheckpoint({cwd, run: fakeRun});
  assert.equal(checkpoint.status, '', 'the checkpoint must be taken on a clean tree');
  assert.deepEqual(checkpoint.tests, {pass: 1, total: 1, fail: 0});

  fs.appendFileSync(path.join(cwd, 'a.txt'), 'two\n'); // tracked file, now dirty

  const trigger = path.join(root, 'finish-turn');
  const worker = fakeAdapter(() => []);
  let session, taskId, scheduler;
  await withEnv({BOUNCE_HOME: root, FAKE_CLI_WAIT_FILE: trigger}, async () => {
    const done = supervise(['run', 'hi', '--json', '--cwd', cwd], {
      adapters: {fake: worker},
      profiles: {
        main: {adapter: 'codex', mode: 'yolo', fallback: []},
        build: {adapter: 'fake', mode: 'yolo', fallback: []},
      },
      onReady: async ({session: s, scheduler: sch}) => {
        session = s;
        scheduler = sch;
        taskId = scheduler.submit({parent: null, profile: 'build', orders: 'x', deadline: null, checkpoint}).task;
      },
    });
    // A failed assertion must still release the held vendor turn and let the supervisor exit,
    // or the leaked child keeps the whole test runner alive.
    try {
      const failed = await waitFor(() => session?.events.find(e => e.kind === 'task.failed' && e.task === taskId));
      assert.equal(failed.reason, 'baseline');
      assert.equal(failed.text, 'tree differs from the task checkpoint');
      assert.equal(worker.calls.launch, 0, 'the adapter must never be launched against a drifted tree');
      const kinds = session.events.filter(e => e.task === taskId).map(e => e.kind);
      assert.deepEqual(kinds, ['task.submitted', 'budget.reserved', 'budget.released', 'task.failed']);
      const released = session.events.find(e => e.kind === 'budget.released' && e.task === taskId);
      assert.deepEqual(released.amount, {starts: 1});
      assert.equal(released.text, 'baseline refusal');
      // No `budget` on this submission: it's its own root with no declared allowance.
      const budgets = scheduler.budgets().roots[taskId];
      assert.equal(budgets.reserved.starts, 1);
      assert.equal(budgets.released.starts, 1);
      assert.equal(session.events.some(e => e.kind === 'task.started' && e.task === taskId), false);
      assert.equal(session.events.some(e => e.kind === 'peer.joined' && e.name === `worker:${taskId}`), false);
    } finally {
      fs.writeFileSync(trigger, 'go');
      await done;
    }
  });
  // The supervisor ran to a clean finish (its own exit code is this process's, in-process),
  // and the worker adapter was never touched at all — not even to cancel.
  assert.equal(process.exitCode, 0);
  assert.equal(worker.calls.launch, 0);
  assert.equal(worker.calls.cancel, 0);
});

// ---- E5 ------------------------------------------------------------------
// Deviation from the T8 brief, reported with the task: the brief expects `control.stop` from the
// orchestrator token to be accepted (exit 0) and journaled from 'orchestrator', then ignored.
// src/bus.js:119 refuses control.* from any peer but `user` outright, so the row never reaches
// the log at all — a strictly stronger outcome, asserted here, and the one daemon.test.js O3
// already pins from inside the fake CLI.
test('E5 the orchestrator grant cannot escalate: budget.reserved, task.completed, a user row and control.stop are all refused -32001, and the daemon survives', async t => {
  const root = tmpRoot('bounce-e5-');
  const cwd = tmpRoot('bounce-e5-cwd-');
  const daemon = await (async () => {
    writeE2EConfig(root, {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}});
    // The probes below need the daemon and its grants alive: hold the orchestrator's turn open
    // after its task ends (the wait no longer runs out the clock on a failed task — P15).
    return startOrchestratorDaemon(root, cwd, {FAKE_ORCH_HOLD_MS: '20000'});
  })();
  t.after(async () => {
    try { await run(['stop', daemon.id], bounceEnv(root)); } catch {}
    if (pidAlive(daemon.info.pid)) { try { process.kill(daemon.info.pid, 'SIGKILL'); } catch {} }
    try { daemon.child.kill('SIGKILL'); } catch {}
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(cwd, {recursive: true, force: true});
  });

  const asOrchestrator = bounceEnv(root, {BOUNCE_BUS: daemon.info.bus, BOUNCE_BUS_TOKEN_FILE: daemon.orchestratorToken});
  const publish = event => run(['publish', '--event', JSON.stringify(event), '--json'], asOrchestrator);

  const reserve = await publish({kind: 'budget.reserved', task: 'x', root: 'x', amount: {starts: 1}});
  assert.equal(reserve.code, 3);
  assert.equal(reserve.stdout, 'bounce: -32001 unauthorized\n');

  const complete = await publish({kind: 'task.completed', task: 'x', summary: 'forged'});
  assert.equal(complete.code, 3);
  assert.equal(complete.stdout, 'bounce: -32001 unauthorized\n');

  const user = await publish({kind: 'user', text: 'FORGED'});
  assert.equal(user.code, 3);
  assert.equal(user.stdout, 'bounce: -32001 unauthorized\n');

  const stop = await publish({kind: 'control.stop'});
  assert.equal(stop.code, 3);
  assert.equal(stop.stdout, 'bounce: -32001 unauthorized\n');

  // Liveness proved positively, not by sleeping: a kind the orchestrator grant DOES allow still
  // round-trips through the same daemon after the four refusals.
  const allowed = await publish({kind: 'message', to: 'user', text: 'still here'});
  assert.equal(allowed.code, 0);
  const row = JSON.parse(allowed.stdout);
  assert.equal(row.kind, 'message');
  assert.equal(row.from, 'orchestrator');
  assert.equal(row.text, 'still here');
  assert.equal(pidAlive(daemon.info.pid), true, 'the daemon must still be alive after the orchestrator tried to stop it');

  const journal = journalOf(daemon.dir);
  assert.equal(journal.filter(e => e.kind === 'user').length, 1, 'exactly the one real user row, nothing forged');
  assert.equal(journal.some(e => e.kind === 'control.stop'), false);
  assert.equal(journal.some(e => e.kind === 'control.stopped'), false);
  assert.equal(journal.some(e => e.kind === 'budget.reserved' && e.task === 'x'), false);
  assert.equal(journal.some(e => e.kind === 'task.completed' && e.task === 'x'), false);
  assert.equal(journal.find(e => e.kind === 'operation').shape, 'single-provider');
});

// ---- the gap that blocks E1, E3, E4 and E6 -------------------------------
// QUARANTINE: this test asserts a defect, not a contract. src/reload.js:166 builds the task
// adapter registry as `{...extraAdapters}` alone, so nothing imports src/adapters/*-live.js into
// a running daemon: a config-declared profile on claude/codex/muse reaches dispatch with
// `adapters[profile.adapter] === undefined` and dies on a TypeError. Delete this test and write
// the real E1/E3/E4/E6 probes the moment that wiring lands.
