import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {agentMetadata, serializeAgent, writeAgent, loadAgents, readOnlyRoles, rolesFor, agentStore, projectAgentStore, installedSkillAgents} from '../src/agents.js';
import {validateOrchestration, playedBy} from '../src/profiles.js';

// An agent is the job: one markdown file, frontmatter for what bounce routes on, body as the worker's
// system prompt, `models:` for the AIs that may play it in fallback order. The orchestration skill
// ships the defaults; a fresh install has a working team with no file on disk.

const root = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agents-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; };
const orchestration = (profiles = {}, extra = {}) => ({operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', order: ['claude', 'codex', 'muse'],
  models: {claude: 'sonnet', codex: 'gpt-5.6-terra'}, profiles: {main: {adapter: 'claude'}, ...profiles}, ...extra});

test('agentMetadata: the final format — flat frontmatter, [a, b] lists, provider/model refs, body as prompt', () => {
  const meta = agentMetadata(`---
name: coder
description: Implements owned modules.
policy: write
maxSteps: 60
readPaths: [.]
writePaths: [src, test]
commands: [npm test]
models: [codex/gpt-5.6-terra, claude/sonnet, lmstudio/qwen3-coder-next-mlx]
---
You are a builder.
Own only your paths.
`);
  assert.deepEqual(meta, {name: 'coder', description: 'Implements owned modules.', policy: 'write', maxSteps: 60,
    readPaths: ['.'], writePaths: ['src', 'test'], commands: ['npm test'],
    models: ['codex/gpt-5.6-terra', 'claude/sonnet', 'lmstudio/qwen3-coder-next-mlx'], prompt: 'You are a builder.\nOwn only your paths.'});
  assert.equal(agentMetadata('---\nname: scout\ndescription: d\n---\nbody').policy, 'write', 'write is the default: read-only is opted into');
  assert.throws(() => agentMetadata('---\nname: x\ndescription: d\nmodels: [opencode/foo]\n---\n'), /got opencode\/foo/, 'a ref must be provider/model; a bare word is not a provider ref');
  assert.throws(() => agentMetadata('---\nname: x\ndescription: d\nmodels: [sonnet]\n---\n'), /provider\/model refs/);
  assert.throws(() => agentMetadata('---\nname: x\ndescription: d\nwritePaths: [../out]\n---\n'), /relative workspace paths/);
  assert.throws(() => agentMetadata('---\nname: orchestrator\ndescription: d\n---\n'), /reserved/);
  assert.throws(() => agentMetadata('---\nname: x\ndescription: d\npolicy: root\n---\n'), /policy must be read-only or write/);
  assert.throws(() => agentMetadata('---\nname: x\ndescription: d\npolicy: probe\n---\n'), /policy must be read-only or write/, 'probe is gone: an agent reads only, or writes');
  assert.throws(() => agentMetadata('---\nname: x\ndescription: d\nmaxSteps: 0\n---\n'), /between 1 and 500/);
});

// Sampling is the job's, sent with each request only when a local model plays it: four agents can
// share one loaded model and still each think (or not) and sample their own way.
test('agentMetadata: sampling keys are flat, validated, and only the declared ones are kept', () => {
  const meta = agentMetadata(`---
name: scout
description: Finds things fast.
policy: read-only
thinking: off
temperature: 0.7
topP: 0.8
topK: 20
minP: 0
presencePenalty: 1.5
frequencyPenalty: -0.5
repeatPenalty: 1.0
maxTokens: 2048
seed: 7
---
Scout.
`);
  assert.deepEqual(meta.sampling, {thinking: 'off', temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5,
    frequencyPenalty: -0.5, repeatPenalty: 1, maxTokens: 2048, seed: 7});
  assert.deepEqual(agentMetadata('---\nname: b\ndescription: d\nthinking: on\ntemperature: 0.6\n---\n').sampling, {thinking: 'on', temperature: 0.6});
  assert.equal(Object.hasOwn(agentMetadata('---\nname: b\ndescription: d\n---\n'), 'sampling'), false, 'nothing declared, nothing carried');
  for (const [line, message] of [
    ['thinking: maybe', /thinking must be on or off/], ['thinking: false', /thinking must be on or off/],
    ['temperature: 2.5', /temperature must be a number from 0 to 2/], ['temperature: hot', /temperature must be/], ['temperature:', /temperature must be/],
    ['topP: 0', /topP must be a number above 0, up to 1/], ['topP: 1.1', /topP must be/],
    ['topK: 2.5', /topK must be an integer from 0 to 1000/], ['topK: -1', /topK must be/],
    ['minP: 1.5', /minP must be a number from 0 to 1/],
    ['presencePenalty: 3', /presencePenalty must be a number from -2 to 2/], ['frequencyPenalty: -2.1', /frequencyPenalty must be/],
    ['repeatPenalty: 0', /repeatPenalty must be a number above 0, up to 2/],
    ['maxTokens: 0', /maxTokens must be an integer from 1 to 32000/], ['maxTokens: 32001', /maxTokens must be/], ['maxTokens: 1e3x', /maxTokens must be/],
    ['seed: -1', /seed must be a non-negative integer/],
  ]) assert.throws(() => agentMetadata(`---\nname: x\ndescription: d\n${line}\n---\n`), message, line);
  const round = agentMetadata(serializeAgent(meta));
  assert.deepEqual(round, meta, 'serializeAgent writes the sampling keys back flat');
});

test('sampling reaches a local backend of the job only; a cloud fallback and the cloud AI Jev picks never carry it', t => {
  const dir = root(t);
  fs.mkdirSync(agentStore(dir), {recursive: true});
  fs.writeFileSync(path.join(agentStore(dir), 'scout.md'), serializeAgent({name: 'scout', description: 'Finds.', policy: 'read-only',
    models: ['lmstudio/qwen', 'claude/sonnet'], sampling: {thinking: 'off', temperature: 0.7, maxTokens: 4096}, prompt: 'Scout.'}));
  fs.writeFileSync(path.join(agentStore(dir), 'plain.md'), serializeAgent({name: 'plain', description: 'Plain.', policy: 'read-only', models: ['lmstudio/qwen'], prompt: 'P.'}));
  const view = validateOrchestration(orchestration({}, {local: {enabled: true}}), undefined, {roles: loadAgents(dir)});
  const [local, cloud] = [view.profiles.scout, view.profiles['scout~2']];
  assert.equal(local.adapter, 'opencode');
  assert.deepEqual(local.localOptions, {maxOutputTokens: 4096, sampling: {thinking: 'off', temperature: 0.7, maxTokens: 4096}});
  assert.equal(cloud.adapter, 'claude');
  assert.equal(Object.hasOwn(cloud, 'localOptions'), false, 'a cloud model is the same job on a different brain: no sampling');
  assert.deepEqual(view.profiles.plain.localOptions, {maxOutputTokens: 2048}, 'an agent that declares nothing sends nothing');
  assert.deepEqual(playedBy(local, 'lmstudio/other', null, {endpoint: 'lmstudio', model: 'other'}).localOptions, local.localOptions, 'a local model Jev picks plays the job the same way');
  assert.equal(Object.hasOwn(playedBy(local, 'main', view.profiles.main), 'localOptions'), false);
});

test('serializeAgent round-trips through agentMetadata, and writeAgent refuses to clobber a hand-edited file', t => {
  const dir = path.join(root(t), 'agents');
  const agent = {name: 'coder', description: 'Implements.', policy: 'write', maxSteps: 60, writePaths: ['src'], models: ['claude/sonnet', 'lmstudio/auto'], prompt: 'Build things.'};
  assert.deepEqual(agentMetadata(serializeAgent(agent)), agent);

  const {file} = writeAgent(dir, agent, {authored: true});
  assert.equal(fs.readFileSync(file, 'utf8'), serializeAgent(agent));
  // Still what bounce wrote: a later authored write may replace it.
  writeAgent(dir, {...agent, description: 'Implements, revised.'}, {authored: true});
  assert.equal(agentMetadata(fs.readFileSync(file, 'utf8')).description, 'Implements, revised.');
  // The user edits it by hand: it is theirs now.
  fs.appendFileSync(file, '\nMy own rule.\n');
  assert.throws(() => writeAgent(dir, agent, {authored: true}), {code: 'AGENT_EDITED'});
  assert.match(fs.readFileSync(file, 'utf8'), /My own rule/);
  // A file bounce never authored is never overwritten either.
  fs.writeFileSync(path.join(dir, 'mine.md'), '---\nname: mine\ndescription: d\n---\nx\n');
  assert.throws(() => writeAgent(dir, {name: 'mine', description: 'e', prompt: 'y'}), {code: 'AGENT_EDITED'});
  assert.throws(() => writeAgent(dir, {name: 'bad', description: 'd', models: ['nope'], prompt: 'x'}), /provider\/model refs/, 'an invalid definition never lands');
});

test('the shipped agents come from the orchestration skill and are present with no file on disk', t => {
  const roles = loadAgents(root(t));
  assert.deepEqual([...roles.keys()].sort(), ['analyst', 'builder', 'debugger', 'reviewer']);
  assert.equal(roles.get('reviewer').source, 'skill');
  assert.deepEqual([...readOnlyRoles(roles)], [], 'every shipped agent writes: the reviewer and analyst run checks like a builder');
  assert.deepEqual(roles.get('builder').models, ['auto'], 'shipped agents name no AI: Jev picks one per task when it is on, else any signed-in AI plays them');
  assert.equal(roles.get('builder').policy, 'write');
});

// 2026-10-24: layers replace, they do not add up — the team is the most specific layer that has agents, whole.
test('the team is one layer, whole: the project\'s, else the user\'s, else the shipped one; a broken file is reported, not hidden', t => {
  const dir = root(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agents-cwd-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  fs.mkdirSync(installedSkillAgents(dir), {recursive: true});
  fs.writeFileSync(path.join(installedSkillAgents(dir), 'reviewer.md'), '---\nname: reviewer\ndescription: Adopted skill reviewer.\npolicy: read-only\n---\nA.\n');
  fs.mkdirSync(agentStore(dir), {recursive: true});
  fs.writeFileSync(path.join(agentStore(dir), 'reviewer.md'), '---\nname: reviewer\ndescription: My reviewer.\npolicy: read-only\n---\nM.\n');
  fs.mkdirSync(projectAgentStore(cwd), {recursive: true});
  fs.writeFileSync(path.join(projectAgentStore(cwd), 'reviewer.md'), '---\nname: reviewer\ndescription: Project reviewer.\npolicy: write\n---\nP.\n');
  fs.writeFileSync(path.join(projectAgentStore(cwd), 'pentester.md'), '---\nname: pentester\ndescription: Probes.\n---\nProbe.\n');
  fs.writeFileSync(path.join(projectAgentStore(cwd), 'broken.md'), 'no frontmatter\n');
  assert.deepEqual([...loadAgents(dir).keys()], ['reviewer'], 'the user\'s team, without the adopted skill\'s or the shipped agents');
  assert.equal(loadAgents(dir).get('reviewer').description, 'My reviewer.');
  const roles = rolesFor(dir, {cwd});
  assert.deepEqual([...roles.keys()].sort(), ['broken', 'pentester', 'reviewer'], 'the project\'s team alone');
  assert.equal(roles.get('reviewer').source, 'project');
  assert.equal(roles.get('reviewer').policy, 'write');
  assert.equal(roles.get('pentester').policy, 'write');
  assert.match(roles.get('broken').error, /frontmatter block/);
});

// ---------------------------------------------------------------- the derived profile table

test('agents become profiles: one hidden backend per models entry, chained as fallbacks, identical but for the AI', t => {
  const dir = root(t);
  fs.mkdirSync(agentStore(dir), {recursive: true});
  fs.writeFileSync(path.join(agentStore(dir), 'coder.md'), serializeAgent({name: 'coder', description: 'Implements.', policy: 'write', maxSteps: 60,
    writePaths: ['src'], commands: ['npm test'], models: ['codex/gpt-5.6-terra', 'claude/sonnet', 'lmstudio/qwen3-coder-next-mlx'], prompt: 'Build.'}));
  const view = validateOrchestration(orchestration(), undefined, {roles: loadAgents(dir)});
  const chain = ['coder', 'coder~2', 'coder~3'].map(name => view.profiles[name]);
  assert.deepEqual(chain.map(p => [p.adapter, p.model, p.fallback]), [
    ['codex', 'gpt-5.6-terra', ['coder~2']],
    ['claude', 'sonnet', ['coder~3']],
    ['opencode', 'qwen3-coder-next-mlx', []],
  ], 'a model ref names its provider; a local provider runs through opencode');
  for (const p of chain) {
    assert.equal(p.role, 'coder');
    assert.equal(p.policy, 'write');
    assert.deepEqual(p.agent, {name: 'coder', description: 'Implements.', policy: 'write', prompt: 'Build.', maxSteps: 60});
  }
  const local = view.profiles['coder~3'];
  assert.equal(Object.hasOwn(local, 'isolate'), false, 'a local worker runs in the project, never a copy');
  assert.deepEqual([local.backend, local.endpoint], ['lmstudio', 'lmstudio'], 'all a local backend adds is where its model lives');
  assert.equal(Object.hasOwn(local, 'writePaths') || Object.hasOwn(local, 'localOnly'), false, 'no scope to carry: it works in the project like any worker');
});

test('an agent that runs checks is played by every provider in order: none is skipped for being unable to sandbox', t => {
  const view = validateOrchestration(orchestration(), undefined, {roles: loadAgents(root(t))});
  const chain = ['reviewer', 'reviewer~2', 'reviewer~3', 'reviewer~4'].map(name => view.profiles[name]);
  assert.deepEqual(chain.map(p => [p.adapter, p.model, p.policy]), [['claude', 'sonnet', 'write'], ['codex', 'gpt-5.6-terra', 'write'], ['muse', '', 'write'], ['opencode', 'auto', 'write']]);
  assert.deepEqual(chain.map(p => p.fallback), [['reviewer~2'], ['reviewer~3'], ['reviewer~4'], []]);
  assert.deepEqual(view.skipped, []);
});

test('models naming providers this machine has no adapter for are skipped, and an unplayable agent is not offered', t => {
  const dir = root(t);
  fs.mkdirSync(agentStore(dir), {recursive: true});
  fs.writeFileSync(path.join(agentStore(dir), 'x.md'), serializeAgent({name: 'x', description: 'd', models: ['claude/sonnet', 'gemini/pro'], prompt: 'p'}));
  fs.writeFileSync(path.join(agentStore(dir), 'y.md'), serializeAgent({name: 'y', description: 'd', models: ['gemini/pro'], prompt: 'p'}));
  const view = validateOrchestration(orchestration(), undefined, {roles: loadAgents(dir)});
  assert.deepEqual(view.profiles.x.fallback, [], 'gemini has no adapter here, so the chain is just claude');
  assert.equal(view.profiles['x~2'], undefined);
  assert.equal(view.profiles.y, undefined, 'nobody here can play y');
});

test('provider/default in models means the provider\'s default model, exactly like an agent with no models', t => {
  const dir = root(t);
  fs.mkdirSync(agentStore(dir), {recursive: true});
  fs.writeFileSync(path.join(agentStore(dir), 'scout.md'), serializeAgent({name: 'scout', description: 'd', policy: 'read-only', models: ['lmstudio/small', 'claude/default'], prompt: 'p'}));
  const view = validateOrchestration(orchestration(), undefined, {roles: loadAgents(dir)});
  assert.deepEqual([view.profiles.scout.adapter, view.profiles.scout.model], ['opencode', 'small']);
  assert.deepEqual([view.profiles['scout~2'].adapter, view.profiles['scout~2'].model], ['claude', ''], 'the same empty model the no-models chain carries');
});

test('a config profile with an agent\'s name is a collision, and a label with no file keeps the code fallback', t => {
  const roles = loadAgents(root(t));
  assert.throws(() => validateOrchestration(orchestration({builder: {adapter: 'codex'}}), undefined, {roles}), /an agent file already defines builder/);
  const view = validateOrchestration(orchestration({old: {adapter: 'codex', role: 'critic'}}), undefined, {roles});
  assert.equal(view.profiles.old.policy, 'read-only', 'critic has no file, so the old code default still protects it');
  assert.equal(view.profiles.old.agent, undefined);
});

test('the orchestrator profile is never derived from an agent, and a plan session offers only read-only agents', t => {
  const dir = root(t);
  fs.mkdirSync(agentStore(dir), {recursive: true});
  fs.writeFileSync(path.join(agentStore(dir), 'main.md'), serializeAgent({name: 'main', description: 'd', prompt: 'p'}));
  const view = validateOrchestration(orchestration(), undefined, {roles: loadAgents(dir)});
  assert.equal(view.profiles.main.adapter, 'claude', 'the config orchestrator stays; main.md is ignored for it');
  assert.equal(view.profiles['main~2'], undefined);
  const planned = root(t);
  fs.mkdirSync(agentStore(planned), {recursive: true});
  fs.writeFileSync(path.join(agentStore(planned), 'scout.md'), serializeAgent({name: 'scout', description: 'Finds.', policy: 'read-only', models: ['claude/sonnet'], prompt: 'Scout.'}));
  fs.writeFileSync(path.join(agentStore(planned), 'builder.md'), serializeAgent({name: 'builder', description: 'Builds.', policy: 'write', models: ['claude/sonnet', 'codex/default'], prompt: 'Build.'}));
  const plan = validateOrchestration(orchestration({}, {mode: 'plan'}), undefined, {roles: loadAgents(planned)});
  assert.deepEqual([...new Set(Object.values(plan.profiles).filter(p => p.derived).map(p => p.role))], ['scout'], 'only a read-only agent is offered');
  assert.equal(plan.skipped.filter(item => item.agent === 'builder').length, 2, 'builder: one skip per backend it would have had');
  assert.equal(plan.skipped.find(item => item.agent === 'builder').reason, 'a plan session runs read-only agents only');
});

// ---------------------------------------------------------------- the bridge command: bounce agents

import {agentsCommand} from '../src/agents.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createBus} from '../src/bus.js';
import {Session} from '../src/core.js';

const coder = `---
name: coder
description: Implements owned modules in this repo.
policy: write
maxSteps: 40
writePaths: [src, test]
commands: [npm test]
models: [claude/sonnet, lmstudio/auto]
---
You build. Own only src and test.
`;

test('agents set validates the file against this machine, writes it in the chosen scope, and reports who plays it', t => {
  const dir = root(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agents-cwd-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const options = () => ({root: dir, cwd, settings: orchestration(), scope: 'project'});
  const set = agentsCommand(['set', 'coder'], {...options(), input: coder});
  assert.equal(set.report.file, path.join(projectAgentStore(cwd), 'coder.md'));
  assert.equal(fs.readFileSync(set.report.file, 'utf8'), serializeAgent(agentMetadata(coder)), 'written in canonical form');
  assert.deepEqual(set.report.backends, ['claude/sonnet', 'lmstudio/auto (via opencode)']);
  assert.deepEqual(set.report.skipped, []);
  assert.match(set.text, /^Defined coder \(project\) · write · claude\/sonnet, lmstudio\/auto \(via opencode\)$/m);
  assert.match(set.text, /newly started sessions/);
  // The name on the command line is the contract; a file that says otherwise is refused.
  assert.throws(() => agentsCommand(['set', 'other'], {...options(), input: coder}), /file defines coder, not other/);
  // A provider nobody here has is an error, not a silent skip: a typo must not land.
  assert.throws(() => agentsCommand(['set', 'x'], {...options(), input: '---\nname: x\ndescription: d\nmodels: [gemini/pro]\n---\np\n'}), /unknown provider gemini.*claude, codex, muse, lmstudio/);
  // An agent no AI on this machine can play right now is refused with the reasons.
  assert.throws(() => agentsCommand(['set', 'w'], {...options(), settings: orchestration({}, {mode: 'plan'}), input: '---\nname: w\ndescription: d\n---\np\n'}), /nobody can play w here: .*a plan session runs read-only agents only/);
  assert.throws(() => agentsCommand(['set', 'main'], {...options(), input: '---\nname: main\ndescription: d\n---\np\n'}), /orchestrator/);
  assert.equal(fs.existsSync(path.join(projectAgentStore(cwd), 'w.md')), false);
  // A write agent with no scope plays on a local model too.
  const local = agentsCommand(['set', 'lb'], {...options(), input: '---\nname: lb\ndescription: d\nmodels: [lmstudio/auto, codex/gpt-5.6-terra]\n---\np\n'});
  assert.deepEqual(local.report.backends, ['lmstudio/auto (via opencode)', 'codex/gpt-5.6-terra']);
  assert.deepEqual(local.report.skipped, []);
  // Rewriting what bounce wrote is fine; a hand-edited file needs --force.
  agentsCommand(['set', 'coder'], {...options(), input: coder.replace('You build.', 'You build carefully.')});
  fs.appendFileSync(set.report.file, '\nMine.\n');
  assert.throws(() => agentsCommand(['set', 'coder'], {...options(), input: coder}), {code: 'AGENT_EDITED'});
  assert.match(agentsCommand(['set', 'coder'], {...options(), input: coder, force: true}).text, /Defined coder/);
  // list and show read the team in use — the project's, whole: no shipped agent joins it.
  const list = agentsCommand(['list'], options());
  assert.match(list.text, /^  coder · write · project · claude\/sonnet, lmstudio\/auto \(via opencode\) · models: in the profile \(bounce local setup moves it\)$/m);
  assert.doesNotMatch(list.text, /reviewer/);
  assert.equal(agentsCommand(['show', 'coder'], options()).text, fs.readFileSync(set.report.file, 'utf8'));
  assert.throws(() => agentsCommand(['show', 'nope'], options()), /no agent named nope/);
  assert.throws(() => agentsCommand(['remove', 'reviewer'], options()), /no agent named reviewer/, 'not in the project\'s team');
  assert.match(agentsCommand(['remove', 'coder'], options()).text, /Removed coder/);
  assert.equal(fs.existsSync(set.report.file), false);
  assert.throws(() => agentsCommand(['bogus'], options()), /Use agents list/);
});

test('real CLI: agents set reads the file from stdin and, run by an orchestrator peer, journals agents.defined', async t => {
  const dir = root(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agents-cwd-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(orchestration({}, {skills: {scope: 'project', autoSync: false}})));
  const session = new Session(dir, {root: dir});
  const bus = await createBus({session, dir: session.dir});
  t.after(() => bus.close());
  const grant = bus.grant({peer: 'orchestrator', tasks: [], canSubmit: true});
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, ...args], {cwd, env: {...process.env, BOUNCE_HOME: dir, BOUNCE_NO_UPDATE_CHECK: '1', BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file}, timeout: 15000},
      (error, stdout, stderr) => error && error.code !== 1 ? reject(error) : resolve({code: error?.code ?? 0, stdout, stderr}));
    child.stdin.end(input ?? '');
  });
  // No `models:`: every signed-in provider in order plays it, then the default local endpoint.
  const set = await run(['agents', 'set', 'coder'], coder.replace(/^models:.*\n/m, ''));
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Defined coder \(project\) · write · claude\/sonnet, codex\/gpt-5.6-terra, muse, lmstudio\/auto \(via opencode\)$/m);
  assert.equal(fs.existsSync(path.join(projectAgentStore(cwd), 'coder.md')), true);
  const row = session.events.find(e => e.kind === 'agents.defined');
  assert.ok(row, `no agents.defined row journaled; stderr: ${set.stderr}`);
  assert.equal(row.from, 'orchestrator');
  assert.equal(row.name, 'coder');
  assert.equal(row.scope, 'project');
  assert.match(row.text, /Defined coder/);
  const bad = await run(['agents', 'set', 'coder'], 'no frontmatter');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /frontmatter block/);
  const list = await run(['agents']);
  assert.match(list.stdout, /^  coder · write · project · claude\/sonnet, codex\/gpt-5.6-terra, muse, lmstudio\/auto \(via opencode\)$/m);
});

test('with no team of its own, the shipped team is in use, and a shipped agent cannot be removed', t => {
  const dir = root(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agents-cwd-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  assert.throws(() => agentsCommand(['remove', 'reviewer'], {root: dir, cwd, settings: orchestration(), scope: 'user'}), /shipped with skill agent-orchestrator/);
});
