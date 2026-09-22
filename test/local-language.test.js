// `/local` speaks the language `/jev` does — bare is status, `on|off` is the switch — and Jev's
// status says what it will do with the team: which jobs it can route to, which of them hand their
// AI to it, and where local models stand. (Found live: `jev on` said nothing about local models,
// because every agent file pinned its own AIs and Jev therefore never considers one.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateOrchestration} from '../src/profiles.js';
import {agentMetadata, handAIsToJev, rolesFor} from '../src/agents.js';
import {switchLocal} from '../src/local-models.js';
import {jevCommand} from '../src/jev-command.js';

const agentFile = (name, policy, models) => `---\nname: ${name}\ndescription: The ${name}.\npolicy: ${policy}\nmodels: [${models}]\n---\nYou are the ${name}.\n`;
const tmp = t => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-local-lang-'))); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return root; };

test('with local models off, an agent\'s local AIs are skipped with the way back, and the job runs on the rest of its list', () => {
  const roles = new Map([['analyst', {...agentMetadata(agentFile('analyst', 'read-only', 'lmstudio/coder-30b, claude/sonnet')), source: 'user', file: '/x'}]]);
  const settings = {operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude'], models: {}, profiles: {main: {adapter: 'claude'}}};
  const on = validateOrchestration(settings, undefined, {roles});
  assert.deepEqual([on.profiles.analyst.adapter, on.profiles['analyst~2'].adapter], ['opencode', 'claude']);
  const off = validateOrchestration({...settings, local: {enabled: false}}, undefined, {roles});
  assert.deepEqual([off.profiles.analyst.adapter, off.profiles.analyst.model, Object.hasOwn(off.profiles, 'analyst~2')], ['claude', 'sonnet', false]);
  assert.deepEqual(off.skipped, [{agent: 'analyst', ref: 'lmstudio/coder-30b', reason: 'local models are off (/local on)'}]);
});

test('switchLocal: on is the default and is written as the absence of the flag; off is written; both say what changes', () => {
  const settings = {local: {enabled: false, endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234'}}}};
  assert.equal(switchLocal(settings, true), 'Local models: on · agents may run on the models LM Studio serves');
  assert.deepEqual(settings.local, {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234'}}});
  assert.equal(switchLocal(settings, false), 'Local models: off · agents skip their local AIs and run on the rest of their list');
  assert.equal(settings.local.enabled, false);
  const bare = {};
  switchLocal(bare, false);
  assert.deepEqual(bare, {local: {enabled: false}});
});

test('`bounce local on|off` saves the switch and answers like `bounce jev on|off`; anything else names the grammar', t => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({order: ['claude'], mode: 'yolo', models: {}, executables: {}}));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, 'local', ...args], {env: {...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1'}, encoding: 'utf8', timeout: 15000});
  assert.equal(run('off').stdout.trim(), 'Local models: off · agents skip their local AIs and run on the rest of their list · saved; applies to the next session (/local on|off applies it to a running one)');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).local.enabled, false);
  assert.equal(run('on').stdout.trim().split('\n')[0], 'Local models: on · agents may run on the models LM Studio serves · saved; applies to the next session (/local on|off applies it to a running one)');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).local ?? {}, 'enabled'), false);
  assert.match(run('sideways').stderr, /Use bounce local \[--verify\], bounce local on\|off, or bounce local setup/);
});

test('Jev\'s status names the team: the jobs it can route to, who hands it the AI, and where local models stand', async t => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'agents'));
  for (const name of ['builder', 'integrator', 'reviewer']) fs.writeFileSync(path.join(root, 'agents', `${name}.md`), agentFile(name, name === 'reviewer' ? 'read-only' : 'write', 'claude/sonnet'));
  fs.writeFileSync(path.join(root, 'agents', 'analyst.md'), agentFile('analyst', 'read-only', 'lmstudio/coder-30b, claude/default'));
  const settings = {operation: 'orchestrator', order: ['claude'], mode: 'yolo', models: {}, profiles: {main: {adapter: 'claude'}}, jev: {enabled: true}};
  const run = (line, cwd = root) => jevCommand(line.split(/\s+/).filter(Boolean), {root, cwd, settings, save: () => {}, env: {}, discover: async () => []});
  const pinned = (await run('')).text.split('\n');
  assert.equal(pinned.length, 3);
  assert.equal(pinned[1], '  jobs auto can route to: analyst → lmstudio/coder-30b (via opencode) · builder → claude/sonnet · integrator → claude/sonnet · reviewer → claude/sonnet');
  assert.equal(pinned[2], '  AI picked by Jev: none — every agent names its own AIs, so Jev never picks one, local or cloud. `models: [auto, …]` hands it the choice (/local on does that for every agent).');

  fs.writeFileSync(path.join(root, 'agents', 'analyst.md'), agentFile('analyst', 'read-only', 'auto, claude/default'));
  const handed = (await run('')).text.split('\n');
  assert.equal(handed[1], '  jobs auto can route to: analyst → auto (Jev) · builder → claude/sonnet · integrator → claude/sonnet · reviewer → claude/sonnet');
  assert.equal(handed[2], '  AI picked by Jev: analyst · by the tier the orders need: a local model of that tier first, else a cloud AI (/local off for cloud only)');
  settings.local = {enabled: false};
  assert.equal((await run('')).text.split('\n')[2], '  AI picked by Jev: analyst · cloud AIs only: local models are off (/local on)');

  // off, or routing off, the status is the one line it was
  settings.jev = {enabled: true, routing: false};
  assert.equal((await run('')).text.includes('\n'), false);
});

test('/local on hands every pinned agent\'s AI to Jev: auto goes first, the models a person chose stay behind it, and nothing else in the file changes', t => {
  const root = tmp(t), cwd = tmp(t);
  fs.mkdirSync(path.join(root, 'agents')); fs.mkdirSync(path.join(cwd, '.bounce', 'agents'), {recursive: true});
  fs.writeFileSync(path.join(root, 'agents', 'analyst.md'), agentFile('analyst', 'read-only', 'lmstudio/coder-30b, claude/default'));
  fs.writeFileSync(path.join(root, 'agents', 'reviewer.md'), agentFile('reviewer', 'read-only', 'auto, claude/sonnet'));
  fs.writeFileSync(path.join(cwd, '.bounce', 'agents', 'porter.md'), agentFile('porter', 'write', 'codex/gpt-5.6-terra'));
  fs.writeFileSync(path.join(root, 'agents', 'main.md'), agentFile('main', 'write', 'claude/opus'));
  assert.deepEqual(handAIsToJev(rolesFor(root, {cwd}), {orchestrator: 'main'}), ['analyst', 'porter']);
  const after = rolesFor(root, {cwd});
  assert.deepEqual(after.get('analyst').models, ['auto', 'lmstudio/coder-30b', 'claude/default']);
  assert.deepEqual(after.get('porter').models, ['auto', 'codex/gpt-5.6-terra']);
  assert.deepEqual([after.get('analyst').prompt, after.get('analyst').policy, after.get('analyst').description], ['You are the analyst.', 'read-only', 'The analyst.']);
  assert.deepEqual(after.get('reviewer').models, ['auto', 'claude/sonnet'], 'already handed over: untouched');
  assert.deepEqual(after.get('main').models, ['claude/opus'], 'the orchestrator is configured, never routed');
  assert.deepEqual(after.get('builder').source, 'skill', 'a shipped agent is never written to');
  assert.deepEqual(handAIsToJev(after, {orchestrator: 'main'}), [], 'a second /local on changes nothing');
});
