// Agent profiles and model bindings (docs/plans/agent-bindings.md): one team and one bindings file in use, the most
// specific that exists, whole; aliases resolved through the machine's models.yaml; an alias's settings travel with its
// backend and nothing else is sent.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {rolesFor} from '../src/agents.js';
import {validateOrchestration} from '../src/profiles.js';

const agent = (name, extra = '') => `---\nname: ${name}\ndescription: The ${name}.\npolicy: write\n${extra}---\nYou are the ${name}.\n`;
function dirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-bind-root-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-bind-cwd-'));
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); };
  return {root, cwd, user: (name, text) => write(path.join(root, 'agents', `${name}.md`), text), project: (name, text) => write(path.join(cwd, '.bounce', 'agents', `${name}.md`), text),
    userFile: (name, text) => write(path.join(root, name), text), projectFile: (name, text) => write(path.join(cwd, '.bounce', name), text)};
}
const names = roles => [...roles.keys()].sort();

test('the team is the most specific layer that has agents, whole: never summed with the others', t => {
  const d = dirs(t);
  assert.equal(names(rolesFor(d.root, {cwd: d.cwd})).includes('debugger'), true, 'nothing anywhere: the shipped team');
  d.user('scout', agent('scout'));
  assert.deepEqual(names(rolesFor(d.root, {cwd: d.cwd})), ['scout'], 'a user team replaces the shipped one');
  d.project('builder', agent('builder'));
  d.project('reviewer', agent('reviewer'));
  assert.deepEqual(names(rolesFor(d.root, {cwd: d.cwd})), ['builder', 'reviewer'], 'a project team replaces the user\'s');
  assert.equal(rolesFor(d.root, {cwd: d.cwd}).get('builder').source, 'project');
});

test('one bindings file is in use, the project\'s over the user\'s, whole; a project without one uses the user\'s', t => {
  const d = dirs(t);
  d.project('builder', agent('builder'));
  d.project('reviewer', agent('reviewer'));
  d.userFile('models.yaml', 'sonnet: claude/sonnet\nqwen: lmstudio/qwen3.8-27b-gsq-rco\n');
  d.userFile('bindings.yml', 'agents:\n  builder: [auto, qwen]\n  reviewer: [sonnet]\n');
  let roles = rolesFor(d.root, {cwd: d.cwd});
  assert.deepEqual(roles.get('builder').models, ['auto', 'lmstudio/qwen3.8-27b-gsq-rco']);
  assert.deepEqual(roles.get('builder').binding, {source: 'user', file: path.join(d.root, 'bindings.yml'), from: 'builder', skipped: []});
  d.projectFile('bindings.yml', 'agents:\n  "*": [auto, sonnet]\n');
  roles = rolesFor(d.root, {cwd: d.cwd});
  assert.deepEqual(roles.get('builder').models, ['auto', 'claude/sonnet'], 'the user\'s builder entry is not merged in');
  assert.deepEqual(roles.get('reviewer').models, ['auto', 'claude/sonnet']);
  assert.equal(roles.get('reviewer').binding.from, '*');
  assert.equal(roles.get('reviewer').binding.source, 'project');
});

test('an alias resolves through models.yaml, with its settings; a model ref and a bare provider are taken as they are', t => {
  const d = dirs(t);
  d.user('reviewer', agent('reviewer'));
  d.userFile('models.yaml', 'qwen_reader:\n  model: lmstudio/qwen3.8-27b-gsq-rco\n  temperature: 1.0\n  thinking: off\n');
  d.userFile('bindings.yml', 'agents:\n  reviewer: [auto, qwen_reader, codex, claude/haiku]\n');
  const reviewer = rolesFor(d.root, {cwd: d.cwd}).get('reviewer');
  assert.deepEqual(reviewer.models, ['auto', 'lmstudio/qwen3.8-27b-gsq-rco', 'codex/default', 'claude/haiku']);
  assert.deepEqual(reviewer.chainSettings, [{temperature: 1, thinking: 'off'}, null, null]);
});

test('an alias this machine does not define is skipped with its reason, and the rest of the chain stands', t => {
  const d = dirs(t);
  d.user('builder', agent('builder'));
  d.userFile('bindings.yml', 'agents:\n  builder: [auto, qwen_coder, claude/sonnet]\n');
  const builder = rolesFor(d.root, {cwd: d.cwd}).get('builder');
  assert.deepEqual(builder.models, ['auto', 'claude/sonnet']);
  assert.deepEqual(builder.binding.skipped, [{entry: 'qwen_coder', reason: 'bindings ask for qwen_coder; models.yaml does not define it'}]);
});

test('a profile\'s own models: is played when the bindings do not name the agent, before the file\'s "*"', t => {
  const d = dirs(t);
  d.user('scout', agent('scout', 'models: [auto, claude/haiku]\n'));
  d.user('builder', agent('builder'));
  d.userFile('bindings.yml', 'agents:\n  "*": [auto, codex]\n');
  const roles = rolesFor(d.root, {cwd: d.cwd});
  assert.deepEqual(roles.get('scout').models, ['auto', 'claude/haiku']);
  assert.equal(roles.get('scout').binding.source, 'profile', 'legacy: said so in the listing');
  assert.deepEqual(roles.get('builder').models, ['auto', 'codex/default']);
});

test('a broken bindings or models file makes every agent invalid with the reason, never a silent fallback', t => {
  const d = dirs(t);
  d.user('builder', agent('builder'));
  d.userFile('bindings.yml', 'agents:\n  builder: [qwen, auto]\n');
  assert.match(rolesFor(d.root, {cwd: d.cwd}).get('builder').error, /bindings\.yml: builder: auto goes first/);
  d.userFile('bindings.yml', 'agents:\n  builder: [auto]\nextra: 1\n');
  assert.match(rolesFor(d.root, {cwd: d.cwd}).get('builder').error, /bindings\.yml: unknown key extra/);
  d.userFile('bindings.yml', 'agents:\n  builder: [auto, qwen]\n');
  d.userFile('models.yaml', 'qwen:\n  model: lmstudio/qwen\n  temperature: 9\n');
  assert.match(rolesFor(d.root, {cwd: d.cwd}).get('builder').error, /models\.yaml: qwen: temperature must be a number from 0 to 2/);
  d.userFile('models.yaml', 'auto: claude/sonnet\n');
  assert.match(rolesFor(d.root, {cwd: d.cwd}).get('builder').error, /models\.yaml: auto is reserved/);
});

// Option D: bounce sends no sampling of its own. Only an alias's settings reach the local backend that plays it.
test('a local backend carries its alias\'s settings, and none when the alias has none', t => {
  const d = dirs(t);
  d.user('reviewer', agent('reviewer', 'temperature: 0.6\n'));
  d.user('scout', agent('scout'));
  d.userFile('models.yaml', 'qwen: lmstudio/qwen3.8-27b-gsq-rco\nqwen_explore:\n  model: lmstudio/qwen3.8-27b-gsq-rco\n  temperature: 1.0\n');
  d.userFile('bindings.yml', 'agents:\n  reviewer: [qwen_explore, qwen]\n  scout: [qwen]\n');
  const settings = {operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude'], models: {}, local: {enabled: true},
    profiles: {main: {adapter: 'claude', model: 'opus'}}};
  const {profiles} = validateOrchestration(settings, undefined, {roles: rolesFor(d.root, {cwd: d.cwd})});
  assert.deepEqual(profiles.reviewer.localOptions.sampling, {temperature: 1}, 'the alias\'s, not the profile\'s 0.6');
  assert.equal(profiles['reviewer~2'].localOptions.sampling, undefined, 'qwen has no settings: none sent');
  assert.equal(profiles.scout.localOptions.sampling, undefined);
});

// The views say which team and which bindings are in use, where each chain came from, and what cannot run here.
test('agents list names the team, bindings and models files in use, each chain\'s source, and what is skipped', async t => {
  const {agentsCommand} = await import('../src/agents.js');
  const d = dirs(t);
  d.project('builder', agent('builder'));
  d.project('scout', agent('scout', 'models: [claude/haiku]\n'));
  d.userFile('models.yaml', 'sonnet: claude/sonnet\n');
  d.projectFile('bindings.yml', 'agents:\n  builder: [auto, sonnet, qwen_coder]\n');
  const settings = {operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude'], models: {}, profiles: {main: {adapter: 'claude', model: 'opus'}}};
  const lines = agentsCommand(['list'], {root: d.root, cwd: d.cwd, settings, scope: 'project'}).text.split('\n');
  assert.deepEqual(lines.slice(0, 3), [
    `Team: this project's (${path.join(d.cwd, '.bounce', 'agents')})`,
    `Bindings: this project's (${path.join(d.cwd, '.bounce', 'bindings.yml')})`,
    `Models: ${path.join(d.root, 'models.yaml')}`]);
  assert.equal(lines.includes('  builder · write · project · auto (Jev), claude/sonnet · bindings: builder'), true, lines.join('\n'));
  assert.equal(lines.includes('      skipped bindings ask for qwen_coder; models.yaml does not define it'), true);
  assert.equal(lines.includes('  scout · write · project · claude/haiku · models: in the profile (bounce local setup moves it)'), true);
});

test('bounce local marks a local model the chain names that LM Studio does not have', async () => {
  const {gatherLocalStatus} = await import('../src/local-setup-view.js');
  const roles = new Map([['builder', {name: 'builder', description: 'B.', policy: 'write', prompt: 'b', source: 'project', models: ['lmstudio/qwen3.6-35b-a3b-mlx', 'claude/default']}]]);
  const catalogs = [{endpoint: 'lmstudio', models: [{id: 'qwen3.8-27b-gsq-rco', ref: 'lmstudio/qwen3.8-27b-gsq-rco', ready: true, tools: true, context: 8192, instances: [{id: 'q', context: 8192}]}]}];
  const status = await gatherLocalStatus({settings: {operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude'], models: {}, local: {enabled: true}, profiles: {main: {adapter: 'claude'}}}, discover: async () => catalogs, roles});
  assert.deepEqual(status.roles[0].skipped, ['lmstudio/qwen3.6-35b-a3b-mlx: LM Studio here does not have this model; the chain falls to the next AI']);
});

test('the shipped team\'s own models: [auto] is its default, not an old file to move', t => {
  const d = dirs(t);
  const builder = rolesFor(d.root, {cwd: d.cwd}).get('builder');
  assert.deepEqual([builder.source, builder.models, builder.binding], ['skill', ['auto'], undefined]);
});

// Found 2026-10-24 running setup from ~: the project's .bounce there is ~/.bounce itself, and it was called "this project's".
test('a project directory that is the user\'s own ~/.bounce is the user\'s layer, not a project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-home-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, '.bounce');
  fs.mkdirSync(path.join(home, 'agents'), {recursive: true});
  fs.writeFileSync(path.join(home, 'agents', 'scout.md'), agent('scout'));
  fs.writeFileSync(path.join(home, 'bindings.yml'), 'agents:\n  scout: [claude/haiku]\n');
  const scout = rolesFor(home, {cwd: root}).get('scout');
  assert.deepEqual([scout.source, scout.binding.source], ['user', 'user']);
});
