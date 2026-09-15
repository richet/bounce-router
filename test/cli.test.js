// Phase 5 (CONTRACT.md #5 bullets 3-4, #6 last paragraph): `bounce sessions` rows gain a
// `spend` field recomputed from the journal via reducers.spend, and `bounce task compare
// <session> <a> <b>` is the built-in A/B, both driven through the real `src/cli.js` as a
// user would run it (spawned, BOUNCE_HOME in a tmp root — same pattern as test/e2e.test.js).
//
// reducers.spend is builder-1's (src/reducers.js); until it lands these assertions are red —
// marked `// depends on builder-1: reducers.spend` — not weakened to pass early.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmpRoot = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const bounceEnv = (root, extra = {}) => ({...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1', ...extra});

function run(args, env, {timeout = 10000} = {}) {
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

function writeConfig(root) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order: ['claude'], mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 48000,
    skills: {scope: 'user', autoSync: false}, executables: {},
  }));
}

// Two root tasks under one orchestrator session, each with its own usage rows — mirrors
// CONTRACT.md #5's W11-style fold, but through the journal a real `bounce sessions`/`task
// compare` call reads, not the reducer called directly.
function seedSession(root, cwd) {
  const session = new Session(cwd, {root});
  session.append({kind: 'operation', operation: 'orchestrator', orchestrator: 'main'});
  session.append({kind: 'task.submitted', task: 'root1', parent: null, orders: 'do the thing', profile: 'build', deadline: null, budget: null});
  session.append({kind: 'task.started', task: 'root1', attempt: 1});
  session.append({kind: 'task.usage', task: 'root1', usage: {input: 10, output: 5}});
  session.append({kind: 'task.completed', task: 'root1', summary: 'ok'});
  session.append({kind: 'task.submitted', task: 'root2', parent: null, orders: 'do the thing', profile: 'build', deadline: null, budget: null});
  session.append({kind: 'task.started', task: 'root2', attempt: 1});
  session.append({kind: 'task.usage', task: 'root2', usage: {input: 1, cache_read: 7}});
  session.append({kind: 'task.completed', task: 'root2', summary: 'ok'});
  return session;
}

test('bounce sessions prints spend recomputed from the journal (depends on builder-1: reducers.spend)', async t => {
  const root = tmpRoot('bounce-cli-'), cwd = tmpRoot('bounce-cli-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  writeConfig(root);
  const session = seedSession(root, cwd);
  const {code, stdout, stderr} = await run(['sessions', '--json'], bounceEnv(root));
  assert.equal(code, 0, stderr);
  const rows = JSON.parse(stdout);
  const row = rows.find(r => r.id === session.id);
  assert.notEqual(row, undefined, 'session must appear in bounce sessions');
  // depends on builder-1: reducers.spend — tokens = 10+5+1+7 = 23 across both roots, both measured
  assert.deepEqual(row.spend, {tokens: 23, measured: true, tasks: 2});
});

test('bounce sessions reads spend: null for a session with no task rows', async t => {
  const root = tmpRoot('bounce-cli-'), cwd = tmpRoot('bounce-cli-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  writeConfig(root);
  const session = new Session(cwd, {root});
  session.append({kind: 'user', text: 'hi'});
  const {code, stdout, stderr} = await run(['sessions', '--json'], bounceEnv(root));
  assert.equal(code, 0, stderr);
  const rows = JSON.parse(stdout);
  const row = rows.find(r => r.id === session.id);
  assert.notEqual(row, undefined);
  assert.equal(row.spend, null);
});

test('bounce task compare prints spend + orders for two tasks, same_orders true for identical orders (depends on builder-1: reducers.spend)', async t => {
  const root = tmpRoot('bounce-cli-'), cwd = tmpRoot('bounce-cli-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  writeConfig(root);
  const session = seedSession(root, cwd);
  const {code, stdout, stderr} = await run(['task', 'compare', session.id, 'root1', 'root2'], bounceEnv(root));
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.session, session.id);
  assert.equal(result.same_orders, true);
  assert.equal(result.a.orders, 'do the thing');
  assert.equal(result.b.orders, 'do the thing');
  // depends on builder-1: reducers.spend
  assert.deepEqual(result.a.usage, {input: 10, output: 5});
  assert.deepEqual(result.b.usage, {input: 1, cache_read: 7});
});

test('bounce task compare: different orders read same_orders false', async t => {
  const root = tmpRoot('bounce-cli-'), cwd = tmpRoot('bounce-cli-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  writeConfig(root);
  const session = new Session(cwd, {root});
  session.append({kind: 'task.submitted', task: 'a1', parent: null, orders: 'orders A', profile: 'build', deadline: null, budget: null});
  session.append({kind: 'task.completed', task: 'a1', summary: 'ok'});
  session.append({kind: 'task.submitted', task: 'b1', parent: null, orders: 'orders B', profile: 'build', deadline: null, budget: null});
  session.append({kind: 'task.completed', task: 'b1', summary: 'ok'});
  const {code, stdout, stderr} = await run(['task', 'compare', session.id, 'a1', 'b1'], bounceEnv(root));
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.same_orders, false);
});

test('bounce task compare exits 1 on stderr for an unknown task', async t => {
  const root = tmpRoot('bounce-cli-'), cwd = tmpRoot('bounce-cli-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  writeConfig(root);
  const session = seedSession(root, cwd);
  const {code, stdout, stderr} = await run(['task', 'compare', session.id, 'root1', 'ghost'], bounceEnv(root));
  assert.equal(code, 1);
  assert.match(stderr, /ghost/);
  assert.equal(stdout, '');
});

test('bounce task compare exits 1 on stderr for an unknown session', async t => {
  const root = tmpRoot('bounce-cli-'), cwd = tmpRoot('bounce-cli-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  writeConfig(root);
  // F3/A6: BOUNCE_HOME already has a real session — proves the failure is the lookup on
  // 'ghost-session' specifically, not an artifact of an empty data dir (or, on the pre-Phase-5
  // tree, of `task compare` simply not existing as a command yet).
  seedSession(root, cwd);
  const {code, stdout, stderr} = await run(['task', 'compare', 'ghost-session', 'a', 'b'], bounceEnv(root));
  assert.equal(code, 1);
  assert.match(stderr, /ghost-session/);
  assert.equal(stdout, '');
});
