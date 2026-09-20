import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runLocalSetup} from '../src/local-wizard.js';
import {agentMetadata} from '../src/agents.js';

// Setup is the one local-specific thing bounce does: say which model plays which agent. The bridge
// check runs a real turn through a real `opencode`; here it is doubled, and exercised for real in
// test/local-wizard-cli.test.js.
const okBridge = async () => ({binary: '/fake/opencode', config: {ready: true}, worker: {ready: true}});
const settings = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', order: ['claude', 'codex'], models: {codex: 'gpt-5.6-terra'}, profiles: {main: {adapter: 'claude'}}};
const model = (id, extra = {}) => ({id, ref: `lmstudio/${id}`, label: id, ready: true, type: 'llm', tools: true, instances: [{id, context: 8192}], capabilitySource: 'server', ...extra});
const catalogOf = models => [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models}];
const three = catalogOf([model('small'), model('coder', {instances: [{id: 'coder-next', context: 65536}]}), model('big', {instances: [{id: 'big', context: 262144}]}),
  model('on-disk', {ready: false, instances: [], context: 131072}), model('no-tools', {tools: false}), {id: 'embed', ref: 'lmstudio/embed', type: 'embedding', ready: true, tools: null, instances: []}]);
const roles = () => new Map([
  ['builder', {name: 'builder', policy: 'write', description: 'Implements.', prompt: 'Build.', source: 'skill', maxSteps: 60}],
  ['reviewer', {name: 'reviewer', policy: 'read-only', description: 'Reviews.', prompt: 'Review.', source: 'skill', models: ['codex/gpt-5.6-terra']}],
  ['main', {name: 'main', policy: 'write', description: 'never offered: it is the orchestrator', prompt: 'x', source: 'user'}],
  ['broken', {name: 'broken', error: 'frontmatter needs a description'}],
]);
function fixture(t, answers, over = {}) {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-agents-'));
  t.after(() => fs.rmSync(agentsDir, {recursive: true, force: true}));
  let saved; const output = [], questions = [];
  const options = {settings, agentsDir, roles: roles(), bridge: okBridge, discover: async () => three,
    ask: async question => { questions.push(question); return answers.shift() ?? null; }, write: text => output.push(text), save: async next => { saved = next; }, ...over};
  return {options, agentsDir, output, questions, saved: () => saved, read: name => agentMetadata(fs.readFileSync(path.join(agentsDir, `${name}.md`), 'utf8'))};
}

test('next-next-next: Enter accepts a suggested model per agent, and the agent file keeps its other AIs as fallbacks', async t => {
  const f = fixture(t, ['', '', 'y']);
  const result = await runLocalSetup(f.options);
  assert.deepEqual(result, {saved: true, profiles: [], agents: ['builder', 'reviewer']});
  const choices = '[1] small (8k) · [2] coder-next (64k) · [3] big (256k)';
  assert.deepEqual(f.questions, [
    'builder (write) → [1] small · [2] coder-next · [3] big · list · skip (Enter = 2): ',
    'reviewer (read-only) → [1] small · [2] coder-next · [3] big · list · skip (Enter = 3): ',
    'Save this configuration? [y/N] ']);
  // The TUI's setup pane shows about ten rows: loaded models lead, fit on a line, and are repeated in
  // every question; downloaded ones stay out of the way until asked for.
  assert.equal(f.output[2], `Loaded: ${choices}`);
  assert.equal(f.output[3], '1 more is downloaded and would load on first use — answer "list" to see it.');
  assert.doesNotMatch(f.output.join('\n'), /on-disk|no-tools|embed/, 'not printed unless asked; a model that cannot call tools, or is not an LLM, is never offered');
  assert.equal(f.output.findIndex(line => line.startsWith('Agents (')), 4, 'five short lines before the first question — it fits the pane');
  assert.equal(f.output.includes('builder → coder-next · then claude/default, codex/gpt-5.6-terra'), true);
  const builder = f.read('builder');
  assert.deepEqual(builder.models, ['lmstudio/coder-next', 'claude/default', 'codex/gpt-5.6-terra'], 'the implicit providers stay behind the pick');
  assert.deepEqual([builder.policy, builder.maxSteps, builder.prompt, builder.writePaths], ['write', 60, 'Build.', undefined]);
  assert.deepEqual(f.read('reviewer').models, ['lmstudio/big', 'codex/gpt-5.6-terra', 'claude/default'], 'named models keep their order; only missing providers are added');
  assert.match(f.output.join('\n'), /A local write agent edits your project directly and may run commands, exactly like a cloud worker in yolo mode\./);
  assert.equal(f.questions.some(q => /Writable paths|commands|workspace|research|Priority/i.test(q)), false);
  assert.deepEqual(f.saved().profiles, {main: {adapter: 'claude'}}, 'no profile is created: the roster is the agent files');
});

test('a number or an id picks another model, skip leaves an agent alone, and skipping everything saves nothing', async t => {
  const f = fixture(t, ['skip', 'small', 'y']);
  assert.deepEqual((await runLocalSetup(f.options)).agents, ['reviewer']);
  assert.deepEqual(f.read('reviewer').models.slice(0, 1), ['lmstudio/small']);
  assert.equal(fs.existsSync(path.join(f.agentsDir, 'builder.md')), false);
  const none = fixture(t, ['skip', 'skip']);
  assert.deepEqual(await runLocalSetup(none.options), {saved: false});
  assert.match(none.output.join('\n'), /No agent changed\. Nothing saved\./);
  assert.equal(none.saved(), undefined);
  const typo = fixture(t, ['9', 'skip']);
  assert.deepEqual(await runLocalSetup(typo.options), {saved: false});
  assert.match(typo.output.join('\n'), /No model 9; leaving builder as is\./);
});

test('loaded-only never offers a model that would have to be loaded; with nothing usable setup says what to do', async t => {
  const f = fixture(t, ['', 'skip', 'n'], {loadedOnly: true});
  await runLocalSetup(f.options);
  assert.match(f.questions[0], /→ \[1\] small · \[2\] coder-next · \[3\] big · skip \(Enter = 2\): $/, 'no `list`: nothing else may be offered');
  const empty = fixture(t, [], {discover: async () => catalogOf([model('no-tools', {tools: false})])});
  assert.deepEqual(await runLocalSetup(empty.options), {saved: false});
  assert.match(empty.output.join('\n'), /No tool-capable model is loaded or downloaded in LM Studio/);
});

// Observed live (2026-09-20): analyst had been on the 4B; picking the 30B produced
// `models: [30B, 4B, claude]`, the 30B looped, and the 4B — the first fallback — "completed" the scout
// with a wrong answer.
test('picking a local model replaces the agent\'s other local models; cloud AIs stay behind it', async t => {
  const f = fixture(t, ['skip', '3', 'y']);
  f.options.roles.set('reviewer', {...f.options.roles.get('reviewer'), models: ['lmstudio/small', 'codex/gpt-5.6-terra', 'lmstudio/old-one']});
  await runLocalSetup(f.options);
  assert.deepEqual(f.read('reviewer').models, ['lmstudio/big', 'codex/gpt-5.6-terra', 'claude/default']);
  assert.match(f.questions[1], /^reviewer \(read-only\) · now lmstudio\/small → /);
});

test('a long model name is trimmed inside the question so it never outgrows the pane', async t => {
  const f = fixture(t, ['skip', 'skip'], {discover: async () => catalogOf([model('qwen3-coder-30b-a3b-instruct-mlx@4bit')])});
  await runLocalSetup(f.options);
  assert.equal(f.questions[0], 'builder (write) → [1] qwen3-coder-30b-a3b-instr… · skip (Enter = 1): ');
  assert.equal(f.output[2], 'Loaded: [1] qwen3-coder-30b-a3b-instruct-mlx@4bit (8k)', 'the full name is on the line above');
});

test('`list` shows the downloaded models compactly and any of them can be picked by number; with nothing loaded they lead instead', async t => {
  const f = fixture(t, ['list', '4', 'skip', 'y']);
  assert.deepEqual((await runLocalSetup(f.options)).agents, ['builder']);
  assert.equal(f.output.includes('[4] on-disk (128k)'), true);
  assert.deepEqual(f.read('builder').models.slice(0, 1), ['lmstudio/on-disk']);
  assert.equal(f.output.includes('builder → on-disk (loads on first use) · then claude/default, codex/gpt-5.6-terra'), true);
  assert.equal(f.questions.filter(q => q.startsWith('builder (write)')).length, 2, 'the question is asked again after the list');
  const cold = fixture(t, ['', 'skip', 'n'], {discover: async () => catalogOf([model('a', {ready: false, instances: [], context: 8192}), model('b-coder', {ready: false, instances: [], context: 32768})])});
  await runLocalSetup(cold.options);
  assert.equal(cold.output[2], 'Nothing is loaded; downloaded (load on first use): [1] a (8k) · [2] b-coder (32k)');
  assert.match(cold.questions[0], /skip \(Enter = 2\): $/);
});

test('nothing is written without consent, on cancel, on EOF, or when the model vanished or the bridge is down', async t => {
  for (const answers of [['', '', 'n'], ['cancel'], []]) {
    const f = fixture(t, answers);
    assert.deepEqual(await runLocalSetup(f.options), {saved: false});
    assert.deepEqual(fs.readdirSync(f.agentsDir), []);
    assert.equal(f.saved(), undefined);
  }
  let reads = 0;
  const gone = fixture(t, ['', 'skip', 'y'], {discover: async () => ++reads === 1 ? three : catalogOf([model('small')])});
  await assert.rejects(runLocalSetup(gone.options), /Model coder-next is no longer available; rerun setup\. Nothing saved\./);
  const down = fixture(t, ['', 'skip', 'y'], {bridge: async () => ({binary: 'opencode', config: {ready: true}, worker: {ready: false, reason: 'opencode is not installed or not on PATH (opencode)'}})});
  await assert.rejects(runLocalSetup(down.options), /OpenCode bridge not ready: opencode is not installed or not on PATH \(opencode\)\. Nothing saved\./);
  for (const f of [gone, down]) { assert.deepEqual(fs.readdirSync(f.agentsDir), []); assert.equal(f.saved(), undefined); }
});

test('a write agent in a plan configuration asks for yolo first; a classic configuration asks to enable orchestration', async t => {
  const plan = fixture(t, ['', 'n'], {settings: {...settings, mode: 'plan'}});
  assert.deepEqual(await runLocalSetup(plan.options), {saved: false});
  assert.equal(plan.questions[1], 'Enable yolo for future sessions? [y/N] ');
  const classic = fixture(t, ['y', 'skip', '', 'y'], {settings: {order: ['claude'], models: {}, mode: 'yolo'}});
  const result = await runLocalSetup(classic.options);
  assert.equal(classic.questions[0], 'Enable orchestrator mode for future sessions? [y/N] ');
  assert.deepEqual(result.agents, ['reviewer']);
  assert.equal(classic.saved().operation, 'orchestrator');
  assert.equal(classic.saved().orchestrator, 'main');
});
