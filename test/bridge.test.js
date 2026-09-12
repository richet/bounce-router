import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bridgeCommand} from '../src/bridge.js';
import {createBus} from '../src/bus.js';
import {Session} from '../src/core.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const setup = async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-bridge-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const bus = await createBus({session, dir: session.dir});
  t.after(() => bus.close());
  return {root, session, bus};
};

// D6: bridge publish/wait exit codes and rows.
test('D6a publish as the granted peer returns exit 0 with the journaled row', async t => {
  const {bus} = await setup(t);
  const grant = bus.grant({peer: 'worker:x', tasks: ['t1']});
  const env = {BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file};
  const result = await bridgeCommand(['publish', '--event', JSON.stringify({kind: 'task.milestone', task: 't1', text: 'm'}), '--json'], env);
  assert.equal(result.exitCode, 0);
  const row = JSON.parse(result.stdout);
  assert.equal(row.from, 'worker:x');
  assert.equal(row.kind, 'task.milestone');
  assert.equal(row.text, 'm');
});

test('D6b wait matches the same event, exit 0, identical row', async t => {
  const {bus} = await setup(t);
  const grant = bus.grant({peer: 'worker:x', tasks: ['t1']});
  const env = {BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file};
  const published = await bridgeCommand(['publish', '--event', JSON.stringify({kind: 'task.milestone', task: 't1', text: 'm'}), '--json'], env);
  const publishedRow = JSON.parse(published.stdout);
  const waited = await bridgeCommand(['wait', '--match', JSON.stringify({kind: 'task.milestone', task: 't1'}), '--timeout', '1', '--json'], env);
  assert.equal(waited.exitCode, 0);
  assert.deepEqual(JSON.parse(waited.stdout), publishedRow);
});

test('D6c wait with no match times out: exit 1, prints null', async t => {
  const {bus} = await setup(t);
  const grant = bus.grant({peer: 'worker:x', tasks: ['t1']});
  const env = {BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file};
  const waited = await bridgeCommand(['wait', '--match', JSON.stringify({kind: 'nope'}), '--timeout', '1'], env);
  assert.equal(waited.exitCode, 1);
  assert.equal(waited.stdout.trim(), 'null');
});

test('D6d missing BOUNCE_BUS/BOUNCE_BUS_TOKEN_FILE exits 2', async () => {
  const result = await bridgeCommand(['publish', '--event', '{"kind":"task.milestone","task":"t1"}'], {});
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /BOUNCE_BUS/);
});

test('D6e publish for a sibling task is refused: exit 3, -32001', async t => {
  const {bus} = await setup(t);
  const grant = bus.grant({peer: 'worker:x', tasks: ['t1']});
  const env = {BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file};
  const result = await bridgeCommand(['publish', '--event', JSON.stringify({kind: 'task.milestone', task: 't2', text: 'x'})], env);
  assert.equal(result.exitCode, 3);
  assert.match(result.stdout, /-32001/);
});

// D7: bridge is one process — never a Session/daemon, and fast.
test('D7 bridge never creates a session dir or daemon.json, and is fast', async t => {
  const {bus, root} = await setup(t);
  const grant = bus.grant({peer: 'worker:z', tasks: ['t1']});
  const env = {BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file};
  const sessionsBefore = fs.readdirSync(path.join(root, 'sessions'));
  const start = Date.now();
  const result = await bridgeCommand(['publish', '--event', JSON.stringify({kind: 'task.milestone', task: 't1', text: 'm'})], env);
  const elapsed = Date.now() - start;
  assert.equal(result.exitCode, 0);
  assert.ok(elapsed < 1000, `bridge publish took ${elapsed}ms`);
  assert.deepEqual(fs.readdirSync(path.join(root, 'sessions')), sessionsBefore);
  for (const id of sessionsBefore) assert.equal(fs.existsSync(path.join(root, 'sessions', id, 'daemon.json')), false);
});

// ---- D6/D7 as the orders literally specified: spawn the real CLI process ----

function spawnCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${args.join(' ')}`)); }, 10000);
    child.once('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
    child.once('error', reject);
  });
}

test('D6 (real CLI) publish/wait via `process.execPath src/cli.js publish|wait ...`', async t => {
  const {bus, root} = await setup(t);
  const grant = bus.grant({peer: 'worker:real', tasks: ['t1']});
  const env = {...process.env, BOUNCE_HOME: root, BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file};

  const published = await spawnCli(['publish', '--event', JSON.stringify({kind: 'task.milestone', task: 't1', text: 'm'}), '--json'], env);
  assert.equal(published.code, 0);
  const row = JSON.parse(published.stdout.trim());
  assert.equal(row.from, 'worker:real');
  assert.equal(row.kind, 'task.milestone');
  assert.equal(row.text, 'm');

  const waited = await spawnCli(['wait', '--match', JSON.stringify({kind: 'task.milestone', task: 't1'}), '--timeout', '1', '--json'], env);
  assert.equal(waited.code, 0);
  assert.deepEqual(JSON.parse(waited.stdout.trim()), row);

  const timedOut = await spawnCli(['wait', '--match', JSON.stringify({kind: 'nope'}), '--timeout', '1'], env);
  assert.equal(timedOut.code, 1);
  assert.equal(timedOut.stdout.trim(), 'null');
});

test('D7 (real CLI) bridge invocations create no BOUNCE_HOME session directory', async t => {
  const {bus, root: busRoot} = await setup(t);
  const grant = bus.grant({peer: 'worker:real2', tasks: ['t1']});
  const bounceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-bridge-home-'));
  t.after(() => fs.rmSync(bounceHome, {recursive: true, force: true}));
  const env = {...process.env, BOUNCE_HOME: bounceHome, BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file};
  assert.equal(fs.existsSync(path.join(bounceHome, 'sessions')), false);

  const result = await spawnCli(['publish', '--event', JSON.stringify({kind: 'task.milestone', task: 't1', text: 'm'})], env);
  assert.equal(result.code, 0);
  // BOUNCE_HOME (a distinct directory from busRoot, where the bus's own Session lives)
  // must still have no `sessions/` at all: the bridge never touches config.json or
  // creates a Session of its own.
  assert.equal(fs.existsSync(path.join(bounceHome, 'sessions')), false);
  void busRoot;
});
