// Phase 5 (CONTRACT.md #5 bullets 3-4, #6 last paragraph): `bounce sessions` rows gain a
// `spend` field recomputed from the journal via reducers.spend, and `bounce task compare
// <session> <a> <b>` is the built-in A/B, both driven through the real `src/cli.js` as a
// user would run it (spawned, BOUNCE_HOME in a tmp root — same pattern as test/e2e.test.js).
//
// reducers.spend is builder-1's (src/reducers.js); until it lands these assertions are red —
// marked `// depends on builder-1: reducers.spend` — not weakened to pass early.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {starterProfiles, validateOrchestration} from '../src/profiles.js';
import {rolesFor} from '../src/agents.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmpRoot = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const bounceEnv = (root, extra = {}) => ({...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1', ...extra});

function run(args, env, {timeout = 10000, input = null} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe']});
    if (input !== null) child.stdin.end(input);
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

// `bounce jev …`: the headless twin of /jev over the saved config (src/jev-command.js).
test('bounce jev shows status, saves switches under config.jev, and keeps the key out of config.json', async t => {
  const root = tmpRoot('bounce-cli-jev-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeConfig(root);
  const env = bounceEnv(root);
  delete env.TYPESAFE_API_KEY;
  const status = await run(['jev'], env);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Jev \(TypeSafe\): disabled · no key · model jev-1\.13\.0 · review on · routing on · confidence 0\.8/);
  const on = await run(['jev', 'on'], env);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /enabled .* · saved; a running daemon reads it at its next decision/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).jev, {enabled: true, model: 'jev-1.13.0', review: true, routing: true, confidence: 0.8});
  const key = await run(['typesafe', 'key', 'sk-cli-secret-7777'], env);
  assert.equal(key.code, 0, key.stderr);
  assert.match(key.stdout, /TypeSafe key stored \(…7777\)/);
  assert.equal(key.stdout.includes('sk-cli-secret-7777'), false);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8').includes('sk-cli-secret-7777'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8')).typesafe, 'sk-cli-secret-7777');
  assert.equal(fs.statSync(path.join(root, 'secrets.json')).mode & 0o777, 0o600);
  const bad = await run(['jev', 'review', 'sometimes'], env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /Use \/jev review on\|off/);
});

// A config that runs the shipped roster (orchestrator, no `profiles` block) gains a worker via
// `bounce local profile --save`: the saved block holds only the new profile (the user's overlay)
// and the validated view is the shipped roster plus that profile.
// Headless `bounce quota` lists every vendor the config can spend on. With no `profiles`
// block the roster is the shipped one, whose codex builders must show up next to the
// orchestrator's own claude — the raw block would have hidden them.
test('bounce quota on an orchestrator config with no profiles block reports the shipped roster vendors', async t => {
  const root = tmpRoot('bounce-cli-quota-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const config = {operation: 'orchestrator', order: ['claude'], mode: 'yolo', models: {}, skills: {scope: 'user', autoSync: false},
    executables: {codex: '/nonexistent/test-codex', claude: '/nonexistent/test-claude'}};
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const roster = await run(['quota'], bounceEnv(root));
  assert.equal(roster.code, 0, roster.stderr);
  assert.deepEqual(roster.stdout.trim().split('\n').map(line => line.split(' · ')[0]), ['claude', 'codex']);
  // Dropping every codex builder from the overlay drops the vendor from the report.
  const codexNames = Object.entries(starterProfiles(config)).filter(([, p]) => p.adapter === 'codex').map(([name]) => name);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({...config, profiles: Object.fromEntries(codexNames.map(name => [name, null]))}));
  const dropped = await run(['quota'], bounceEnv(root));
  assert.equal(dropped.code, 0, dropped.stderr);
  assert.deepEqual(dropped.stdout.trim().split('\n').map(line => line.split(' · ')[0]), ['claude']);
});

test('bounce agents set on a config with no profiles block leaves the config alone; the validated view is the roster plus the agent', async t => {
  const root = tmpRoot('bounce-cli-roster-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const config = {operation: 'orchestrator', order: ['claude'], mode: 'yolo', models: {}, skills: {scope: 'user', autoSync: false}, executables: {}};
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const result = await run(['agents', 'set', 'researcher'], bounceEnv(root), {input: '---\nname: researcher\ndescription: Reads and reports.\npolicy: read-only\nmodels: [lmstudio/auto, claude/default]\n---\nResearch.\n'});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Defined researcher \(user\) · read-only · lmstudio\/auto \(via opencode\), claude$/m);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')), config, 'an agent is a file: the config gains no profiles block, never a copy of the roster');
  const orchestration = validateOrchestration(config, undefined, {roles: rolesFor(root)});
  assert.equal(orchestration.orchestrator, 'main');
  assert.deepEqual(Object.keys(orchestration.profiles).filter(name => !orchestration.profiles[name].derived), Object.keys(starterProfiles(config)));
  assert.deepEqual([orchestration.profiles.researcher.adapter, orchestration.profiles['researcher~2'].adapter], ['opencode', 'claude']);
  assert.equal(orchestration.profiles.build.adapter, 'codex');
});
