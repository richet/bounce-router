import './helpers/env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {runLocalSetup} from '../src/local-wizard.js';
import {agentMetadata, rolesFor} from '../src/agents.js';

// Setup writes what a machine needs to play its team (docs/plans/agent-bindings.md): models.yaml, this machine's models
// by alias, and bindings.yml, who plays each agent; it moves the old agent files' models: and sampling into them. The
// bridge check runs a real turn through a real `opencode`; here it is doubled (test/local-wizard-cli.test.js runs it).
const okBridge = async () => ({binary: '/fake/opencode', config: {ready: true}, worker: {ready: true}});
const settings = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', order: ['claude', 'codex'], models: {}, local: {enabled: true}, profiles: {main: {adapter: 'claude'}}};
const model = (id, extra = {}) => ({id, ref: `lmstudio/${id}`, ready: true, type: 'llm', tools: true, context: 8192, instances: [{id, context: 8192}], ...extra});
const catalog = [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [model('qwen3.8-27b-gsq-rco', {context: 262144}), model('coder-30b', {context: 65536}),
  {id: 'embed', type: 'embedding', ready: true, tools: null, instances: []}]}];
const profile = (name, extra = '') => `---\nname: ${name}\ndescription: The ${name}.\npolicy: write\n${extra}---\nYou are the ${name}.\n`;

function fixture(t, answers, {bridge = okBridge} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-root-')), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-cwd-'));
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); };
  const output = [], questions = [];
  let saved;
  const run = () => runLocalSetup({settings, root, cwd, roles: rolesFor(root, {cwd}), bridge, discover: async () => catalog,
    ask: async question => { questions.push(question); return answers.shift() ?? null; }, write: text => output.push(text), save: async next => { saved = next; }});
  const yaml = file => YAML.parse(fs.readFileSync(file, 'utf8'));
  return {root, cwd, put, run, output, questions, saved: () => saved, yaml,
    user: (name, text) => put(path.join(root, 'agents', `${name}.md`), text), agent: name => agentMetadata(fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8'))};
}

test('the move from the old files: each models: becomes a binding, a local id an alias, differing sampling a variant', async t => {
  const f = fixture(t, ['n', 'n', 'y']); // no to copying the shipped analyst and debugger, yes to saving
  f.user('builder', profile('builder', 'models: [auto, claude/sonnet, lmstudio/qwen3.8-27b-gsq-rco]\ntemperature: 0.6\n'));
  f.user('reviewer', profile('reviewer', 'models: [auto, lmstudio/qwen3.8-27b-gsq-rco, codex/default]\ntemperature: 1\n'));
  f.user('scout', profile('scout', 'models: [lmstudio/qwen3.8-27b-gsq-rco]\n'));
  const result = await f.run();
  assert.equal(result.saved, true, f.output.join('\n'));
  assert.deepEqual(f.yaml(path.join(f.root, 'models.yaml')), {
    'qwen3.8': 'lmstudio/qwen3.8-27b-gsq-rco',
    'qwen3.8_builder': {model: 'lmstudio/qwen3.8-27b-gsq-rco', temperature: 0.6},
    'qwen3.8_reviewer': {model: 'lmstudio/qwen3.8-27b-gsq-rco', temperature: 1}});
  assert.deepEqual(f.yaml(path.join(f.root, 'bindings.yml')).agents, {
    builder: ['auto', 'claude/sonnet', 'qwen3.8_builder'], reviewer: ['auto', 'qwen3.8_reviewer', 'codex/default'], scout: ['qwen3.8']});
  assert.equal(Object.hasOwn(f.agent('builder'), 'models'), false, 'the profile loses models:');
  assert.equal(Object.hasOwn(f.agent('builder'), 'sampling'), false, 'and its sampling');
  assert.equal(f.agent('builder').prompt, 'You are the builder.');
  // Read back, the team plays as before, now from the files.
  const builder = rolesFor(f.root, {cwd: f.cwd}).get('builder');
  assert.deepEqual([builder.models, builder.chainSettings, builder.binding.source], [['auto', 'claude/sonnet', 'lmstudio/qwen3.8-27b-gsq-rco'], [null, {temperature: 0.6}], 'user']);
});

test('sampling that is the same for every agent on a model is the model\'s own: dropped from the files, and printed', async t => {
  const f = fixture(t, ['n', 'n', 'y']);
  f.user('builder', profile('builder', 'models: [lmstudio/qwen3.8-27b-gsq-rco]\ntopK: 20\n'));
  f.user('reviewer', profile('reviewer', 'models: [lmstudio/qwen3.8-27b-gsq-rco]\ntopK: 20\n'));
  f.user('scout', profile('scout'));
  await f.run();
  assert.deepEqual(f.yaml(path.join(f.root, 'models.yaml')), {'qwen3.8': 'lmstudio/qwen3.8-27b-gsq-rco'});
  assert.equal(f.output.includes('Dropped from builder, the model\'s own settings (set them on the model in LM Studio if they matter): topK 20'), true, f.output.join('\n'));
});

test('an alias the bindings ask for and this machine lacks is pointed at one of its models; Enter takes the suggestion', async t => {
  const f = fixture(t, ['', '1', 'n', 'n', 'n', 'y']); // qwen_coder: Enter (the coder model); qwen_reader: 1; no copies; save
  f.user('builder', profile('builder'));
  f.put(path.join(f.root, 'bindings.yml'), 'agents:\n  builder: [auto, qwen_coder]\n  "*": [qwen_reader]\n');
  await f.run();
  assert.match(f.questions[0], /^The bindings ask for qwen_coder → which model here\? number, id or skip \(Enter = 2\): $/, 'a coder alias suggests the coder model');
  assert.deepEqual(f.yaml(path.join(f.root, 'models.yaml')), {qwen_coder: 'lmstudio/coder-30b', qwen_reader: 'lmstudio/qwen3.8-27b-gsq-rco'});
  assert.equal(fs.readFileSync(path.join(f.root, 'bindings.yml'), 'utf8'), 'agents:\n  builder: [auto, qwen_coder]\n  "*": [qwen_reader]\n', 'the bindings are not touched');
});

test('a first setup on the shipped team writes the starting bindings and names the largest local model', async t => {
  const f = fixture(t, ['y']);
  // Found 2026-10-24: setup took the shipped team's `models: [auto]` for an old file and rewrote the repo's own skill.
  const team = path.join(import.meta.dirname, '..', 'skills', 'agent-orchestrator', 'team');
  const before = fs.readdirSync(team).map(name => fs.readFileSync(path.join(team, name), 'utf8'));
  await f.run();
  assert.deepEqual(fs.readdirSync(team).map(name => fs.readFileSync(path.join(team, name), 'utf8')), before, 'the shipped team is never written');
  assert.deepEqual(f.yaml(path.join(f.root, 'models.yaml')), {'qwen3.8': 'lmstudio/qwen3.8-27b-gsq-rco'});
  assert.deepEqual(f.yaml(path.join(f.root, 'bindings.yml')), {agents: {'*': ['auto', 'qwen3.8', 'claude/sonnet', 'codex']}});
  assert.equal(f.questions.some(question => /Copy bounce's/.test(question)), false, 'the shipped team lacks nothing');
});

test('agents bounce ships that the team lacks are offered one by one and copied only when asked (option A)', async t => {
  const f = fixture(t, ['n', 'y', 'n', 'y']); // analyst no, debugger yes, reviewer no; save
  f.user('builder', profile('builder', 'models: [claude/sonnet]\n'));
  await f.run();
  const offered = f.questions.filter(question => /^Your team has no /.test(question)).map(question => /no (\w+)/.exec(question)[1]);
  assert.deepEqual(offered, ['analyst', 'debugger', 'reviewer', 'scout'].filter(name => fs.existsSync(path.join(import.meta.dirname, '..', 'skills', 'agent-orchestrator', 'team', `${name}.md`))));
  assert.equal(fs.existsSync(path.join(f.root, 'agents', 'debugger.md')), true, 'the one asked for');
  assert.equal(fs.existsSync(path.join(f.root, 'agents', 'analyst.md')), false);
});

test('nothing is written on no, on cancel, on EOF, or when the bridge is down', async t => {
  for (const [answers, bridge] of [[['n', 'n', 'n']], [['cancel']], [[]], [['n', 'n', 'y'], async () => ({config: {ready: true}, worker: {ready: false, reason: 'no opencode'}})]]) {
    const f = fixture(t, answers, bridge ? {bridge} : {});
    f.user('builder', profile('builder', 'models: [lmstudio/qwen3.8-27b-gsq-rco]\n'));
    await f.run().catch(error => assert.match(error.message, /OpenCode bridge not ready: no opencode\. Nothing saved\./));
    assert.equal(fs.existsSync(path.join(f.root, 'models.yaml')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'bindings.yml')), false);
    assert.deepEqual(f.agent('builder').models, ['lmstudio/qwen3.8-27b-gsq-rco'], 'the profile is as it was');
  }
});

test('a project\'s team is moved into the project\'s bindings.yml; its aliases go to this machine\'s models.yaml', async t => {
  const f = fixture(t, ['n', 'n', 'n', 'y']); // no copies of analyst, debugger, reviewer; save
  f.put(path.join(f.cwd, '.bounce', 'agents', 'builder.md'), profile('builder', 'models: [lmstudio/coder-30b, claude/default]\n'));
  await f.run();
  assert.deepEqual(f.yaml(path.join(f.cwd, '.bounce', 'bindings.yml')).agents, {builder: ['coder', 'claude/default']});
  assert.deepEqual(f.yaml(path.join(f.root, 'models.yaml')), {coder: 'lmstudio/coder-30b'});
  assert.equal(fs.existsSync(path.join(f.root, 'bindings.yml')), false, 'the user\'s bindings are not the project\'s');
});

test('a model gone from LM Studio between the question and the consent saves nothing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-root-')), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-cwd-'));
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  let asked = 0;
  const discover = async () => (asked++ ? [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: []}] : catalog);
  await assert.rejects(runLocalSetup({settings, root, cwd, roles: rolesFor(root, {cwd}), bridge: okBridge, discover, ask: async () => 'y', write: () => {}, save: async () => {}}),
    {message: 'Model lmstudio/qwen3.8-27b-gsq-rco is no longer available; rerun setup. Nothing saved.'});
  assert.equal(fs.existsSync(path.join(root, 'models.yaml')), false);
});

// Found 2026-10-24 live: its analyst and reviewer say `policy: probe`, which this bounce refuses, and setup offered to
// copy bounce's analyst and reviewer over them; and it pointed this machine's alias at the Mac's MLX model, absent here.
test('an invalid agent is still the team\'s: never offered a copy over it, and named as not moved', async t => {
  const f = fixture(t, ['n', 'n', 'y']); // debugger no, scout no; save
  f.put(path.join(f.cwd, '.bounce', 'agents', 'analyst.md'), profile('analyst', 'models: [claude/default]\n').replace('policy: write', 'policy: probe'));
  f.put(path.join(f.cwd, '.bounce', 'agents', 'builder.md'), profile('builder', 'models: [claude/default]\n'));
  await f.run();
  const offered = f.questions.filter(question => /^Your team has no /.test(question)).map(question => /no (\w+)/.exec(question)[1]);
  assert.equal(offered.includes('analyst'), false, offered.join(' '));
  assert.equal(f.output.some(line => /^analyst: INVALID \(policy must be read-only or write\); not moved$/.test(line)), true, f.output.join('\n'));
  assert.deepEqual(f.yaml(path.join(f.cwd, '.bounce', 'bindings.yml')).agents, {builder: ['claude/default']});
});

test('a local model the old files name and this machine lacks keeps its alias, pointed at a model here when asked', async t => {
  const f = fixture(t, ['2', 'n', 'n', 'n', 'y']); // the MLX model → coder-30b; no copies; save
  f.put(path.join(f.cwd, '.bounce', 'agents', 'builder.md'), profile('builder', 'models: [lmstudio/qwen3.6-35b-a3b-mlx, claude/default]\n'));
  await f.run();
  assert.match(f.questions[0], /^The old files name lmstudio\/qwen3\.6-35b-a3b-mlx, which LM Studio here does not have → which model here plays qwen3\.6\? number, id or skip \(Enter = 1\): $/);
  assert.deepEqual(f.yaml(path.join(f.cwd, '.bounce', 'bindings.yml')).agents, {builder: ['qwen3.6', 'claude/default']}, 'the bindings keep the portable alias');
  assert.deepEqual(f.yaml(path.join(f.root, 'models.yaml')), {'qwen3.6': 'lmstudio/coder-30b'});
});

test('skipping a model this machine lacks leaves its alias undefined here, and asks once', async t => {
  const f = fixture(t, ['skip', 'n', 'n', 'n', 'y']);
  f.put(path.join(f.cwd, '.bounce', 'agents', 'builder.md'), profile('builder', 'models: [lmstudio/qwen3.6-35b-a3b-mlx, claude/default]\n'));
  await f.run();
  assert.equal(f.questions.filter(question => /qwen3\.6/.test(question)).length, 1, f.questions.join('\n'));
  assert.equal(fs.existsSync(path.join(f.root, 'models.yaml')), false);
  assert.deepEqual(f.yaml(path.join(f.cwd, '.bounce', 'bindings.yml')).agents, {builder: ['qwen3.6', 'claude/default']});
});

// 2026-10-24: setup writes models.yaml and bindings.yml, which do not depend on the mode; it leaves the default alone.
test('setup on a classic configuration never asks to switch modes and leaves the mode as it was', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-root-')), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-cwd-'));
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const questions = []; let saved;
  const classic = {mode: 'yolo', order: ['claude', 'codex'], models: {}, local: {}};
  const result = await runLocalSetup({settings: classic, root, cwd, roles: rolesFor(root, {cwd}), bridge: okBridge, discover: async () => catalog,
    ask: async question => { questions.push(question); return 'y'; }, write: () => {}, save: async next => { saved = next; }});
  assert.equal(result.saved, true);
  assert.deepEqual(questions, ['Save this? [y/N] ']);
  assert.equal(Object.hasOwn(saved, 'operation'), false);
  assert.equal(fs.existsSync(path.join(root, 'bindings.yml')), true);
});

test('a shipped agent copied into a team comes without models: or sampling: the bindings say who plays it', async t => {
  const f = fixture(t, ['y', 'n', 'n', 'y']); // analyst yes; save
  f.user('builder', profile('builder', 'models: [claude/sonnet]\n'));
  await f.run();
  assert.equal(Object.hasOwn(f.agent('analyst'), 'models'), false);
  assert.equal(rolesFor(f.root, {cwd: f.cwd}).get('analyst').binding?.source === 'profile', false);
});

// Found live 2026-10-24: once ~/.bounce/bindings.yml named every agent, a project team with no bindings of its own
// played the user's chains, and setup saw nothing to move: the project's own models: were hidden behind the user's file.
test('a project team\'s own models: move into the project\'s bindings even when the user\'s bindings name its agents', async t => {
  const f = fixture(t, ['n', 'n', 'n', 'y']);
  f.put(path.join(f.root, 'bindings.yml'), 'agents:\n  builder: [claude/sonnet]\n');
  f.put(path.join(f.cwd, '.bounce', 'agents', 'builder.md'), profile('builder', 'models: [auto, lmstudio/coder-30b, claude/default]\n'));
  await f.run();
  assert.deepEqual(f.yaml(path.join(f.cwd, '.bounce', 'bindings.yml')).agents, {builder: ['auto', 'coder', 'claude/default']}, f.output.join('\n'));
  assert.deepEqual(rolesFor(f.root, {cwd: f.cwd}).get('builder').models, ['auto', 'lmstudio/coder-30b', 'claude/default'], 'the project plays its own chain again');
});

test('a variant alias this machine already has is reused when it is the same, and never overwritten when it differs', async t => {
  const f = fixture(t, ['n', 'n', 'y']); // no to analyst and debugger; save
  f.put(path.join(f.root, 'models.yaml'), 'qwen3.8: lmstudio/qwen3.8-27b-gsq-rco\nqwen3.8_builder:\n  model: lmstudio/qwen3.8-27b-gsq-rco\n  temperature: 0.6\nqwen3.8_reviewer:\n  model: lmstudio/qwen3.8-27b-gsq-rco\n  temperature: 1\n');
  f.put(path.join(f.cwd, '.bounce', 'agents', 'builder.md'), profile('builder', 'models: [lmstudio/qwen3.8-27b-gsq-rco]\ntemperature: 0.6\n'));
  f.put(path.join(f.cwd, '.bounce', 'agents', 'reviewer.md'), profile('reviewer', 'models: [lmstudio/qwen3.8-27b-gsq-rco]\ntemperature: 0.2\n'));
  await f.run();
  const models = f.yaml(path.join(f.root, 'models.yaml'));
  assert.deepEqual(models['qwen3.8_reviewer'], {model: 'lmstudio/qwen3.8-27b-gsq-rco', temperature: 1}, 'the user\'s alias is untouched');
  assert.deepEqual(models['qwen3.8_reviewer_2'], {model: 'lmstudio/qwen3.8-27b-gsq-rco', temperature: 0.2});
  assert.deepEqual(f.yaml(path.join(f.cwd, '.bounce', 'bindings.yml')).agents, {builder: ['qwen3.8_builder'], reviewer: ['qwen3.8_reviewer_2']});
});

test('a shipped agent copied in keeps bounce\'s chain as its binding when the bindings have no "*"', async t => {
  const f = fixture(t, ['y', 'n', 'n', 'y']); // analyst yes; save
  f.user('builder', profile('builder', 'models: [claude/sonnet]\n'));
  await f.run();
  assert.deepEqual(f.yaml(path.join(f.root, 'bindings.yml')).agents.analyst, ['auto']);
  assert.deepEqual(rolesFor(f.root, {cwd: f.cwd}).get('analyst').models, ['auto']);
});
