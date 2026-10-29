// Skills for every provider: a project's .bounce/skills is the source, one layer in use whole (the project's, else the
// user's own, never bounce's bundled ones), and a model reaches a skill by reading its file from an index bounce puts
// where it already writes for that model. Local workers keep OpenCode's own skill tool off.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {skillsInUse, skillsBlock} from '../src/skills.js';
import {createAttemptWorkspace, captureArtifact} from '../src/workspace-artifacts.js';
import {NEVER_TOOLS} from '../src/adapters/opencode-common.js';

const skill = (dir, name, description, body = 'Do it this way.') => {
  fs.mkdirSync(path.join(dir, name), {recursive: true});
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
};
function dirs(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-skills-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'home'), cwd = path.join(base, 'project');
  fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  fs.writeFileSync(path.join(cwd, 'src', 'x.js'), 'export const state = "old";\n');
  return {base, root, cwd, user: (...args) => skill(path.join(root, 'skills'), ...args), project: (...args) => skill(path.join(cwd, '.bounce', 'skills'), ...args)};
}
const names = inUse => inUse.skills.map(s => s.name);

test('the skills in use are the project\'s when it has any, else the user\'s own; never summed, never bounce\'s bundled ones', t => {
  const d = dirs(t);
  assert.deepEqual([skillsInUse(d.root, d.cwd).source, names(skillsInUse(d.root, d.cwd))], [null, []]);
  d.user('commit-style', 'How commits are written here.');
  skill(path.join(d.root, 'skills'), 'agent-orchestrator', 'bounce\'s own.');
  fs.writeFileSync(path.join(d.root, 'skills', 'agent-orchestrator', '.bounce-skill.json'), JSON.stringify({skill: 'agent-orchestrator', hash: 'x', bundled: true}));
  assert.deepEqual([skillsInUse(d.root, d.cwd).source, names(skillsInUse(d.root, d.cwd))], ['user', ['commit-style']]);
  d.project('db-migrations', 'How to write a migration in this repo.');
  assert.deepEqual([skillsInUse(d.root, d.cwd).source, names(skillsInUse(d.root, d.cwd))], ['project', ['db-migrations']], 'the user\'s skill does not join a project that has its own');
  assert.deepEqual(names(skillsInUse(d.root, path.dirname(d.root))), ['commit-style'], 'from ~, ~/.bounce is the user\'s layer');
});

test('the index names each skill, says when to read it, and points at its file', t => {
  const d = dirs(t);
  d.project('db-migrations', 'How to write a migration in this repo.');
  const {skills} = skillsInUse(d.root, d.cwd);
  assert.equal(skillsBlock(skills, s => `/x/${s.name}/SKILL.md`),
    'Skills for this project: when the task matches one, read its file first and follow it.\n- db-migrations — How to write a migration in this repo. — /x/db-migrations/SKILL.md');
  assert.equal(skillsBlock([], () => ''), '', 'no skills, no lines');
});

test('a worker\'s copy carries the skills in use and each vendor\'s native copy, and none of it is ever integrated back', t => {
  const d = dirs(t);
  d.project('db-migrations', 'How to write a migration in this repo.');
  const {skills} = skillsInUse(d.root, d.cwd);
  const ws = createAttemptWorkspace({cwd: d.cwd, dir: path.join(d.base, 'w'), owns: ['**'], attemptId: 'a1', skills});
  for (const rel of ['.bounce/skills', '.claude/skills', '.codex/skills', '.agents/skills']) {
    assert.equal(fs.existsSync(path.join(ws.cwd, rel, 'db-migrations', 'SKILL.md')), true, rel);
  }
  assert.equal(Object.keys(ws.baseline).some(file => file.includes('skills/')), false, 'the generated copies are outside the manifest');
  fs.appendFileSync(path.join(ws.cwd, '.claude', 'skills', 'db-migrations', 'SKILL.md'), 'edited by a worker\n');
  fs.writeFileSync(path.join(ws.cwd, 'src', 'x.js'), 'export const state = "new";\n');
  const artifact = captureArtifact(ws);
  assert.deepEqual(artifact.changes.map(change => change.path), ['src/x.js']);
  assert.equal(fs.existsSync(path.join(d.cwd, '.claude')), false, 'the real tree gets no vendor folders');
});

test('a native skill the project already keeps for a vendor is left as the project has it', t => {
  const d = dirs(t);
  d.project('db-migrations', 'How to write a migration in this repo.');
  skill(path.join(d.cwd, '.claude', 'skills'), 'db-migrations', 'The Claude-specific version.');
  const ws = createAttemptWorkspace({cwd: d.cwd, dir: path.join(d.base, 'w'), owns: ['**'], attemptId: 'a2', skills: skillsInUse(d.root, d.cwd).skills});
  assert.match(fs.readFileSync(path.join(ws.cwd, '.claude', 'skills', 'db-migrations', 'SKILL.md'), 'utf8'), /Claude-specific/);
});

test('a worker is handed the skills index with its agent prompt, pointing into its own copy', async t => {
  const d = dirs(t);
  d.project('db-migrations', 'How to write a migration in this repo.');
  let launched = null;
  const session = new Session(d.cwd, {root: d.root});
  const adapters = {worker: {...fakeAdapter(args => { launched = args; return [{kind: 'result', status: 'completed', text: 'done'}]; }), capabilities: () => ({commands: true})}};
  const profiles = {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write', agent: {name: 'builder', description: 'builds', policy: 'write', prompt: 'You are a builder.'}}};
  const scheduler = createScheduler({session, adapters, profiles, gitHead: () => null});
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'Add a migration', deadline: null});
  const start = Date.now();
  while (!['accepted', 'completed', 'blocked', 'failed'].includes(scheduler.tasks()[task]?.state) && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 5));
  const file = path.join(launched.cwd, '.bounce', 'skills', 'db-migrations', 'SKILL.md');
  assert.equal(launched.profile.agent.prompt.includes(`- db-migrations — How to write a migration in this repo. — ${file}`), true, launched.profile.agent.prompt);
  assert.equal(fs.existsSync(file), true, 'the file the index names is there for the worker to read');
  scheduler.close();
});

test('a local worker still gets no OpenCode skill tool: it reads skills as files', () => {
  assert.equal(NEVER_TOOLS.includes('skill'), true);
});

test('the orchestrator\'s orders list the skills in use by their real path; a project without skills adds nothing', async t => {
  const {ordersSkills} = await import('../src/reload.js');
  const d = dirs(t);
  assert.deepEqual(ordersSkills(d.root, d.cwd), []);
  d.project('db-migrations', 'How to write a migration in this repo.');
  const lines = ordersSkills(d.root, d.cwd);
  assert.equal(lines.join('\n').includes(`- db-migrations — How to write a migration in this repo. — ${path.join(d.cwd, '.bounce', 'skills', 'db-migrations', 'SKILL.md')}`), true, lines.join('\n'));
});

test('a classic first turn and a handoff name the skills in use by their real path; with none, the first turn is the request and the workspace', async t => {
  const {handoff} = await import('../src/core.js');
  const d = dirs(t);
  const session = new Session(d.cwd, {root: d.root});
  assert.equal(handoff(session, 'hi'), `hi\n\nWorkspace: ${d.cwd}`);
  d.project('db-migrations', 'How to write a migration in this repo.');
  const line = `- db-migrations — How to write a migration in this repo. — ${path.join(d.cwd, '.bounce', 'skills', 'db-migrations', 'SKILL.md')}`;
  assert.equal(handoff(session, 'hi').includes(line), true);
  assert.equal(handoff(session, 'hi', 48000, {orchestrator: true}).includes(line), false, 'the orchestrator has them in its orders');
});

test('skills list says which skills the models get: the project\'s, else yours', async t => {
  const {skillsCommand} = await import('../src/skills.js');
  const d = dirs(t);
  d.user('commit-style', 'How commits are written here.');
  const list = () => skillsCommand(['list'], {root: d.root, cwd: d.cwd, scope: 'user'}).text.split('\n')[0];
  assert.equal(list(), `Models get: yours (${path.join(d.root, 'skills')}): commit-style`);
  d.project('db-migrations', 'How to write a migration in this repo.');
  assert.equal(list(), `Models get: this project's (${path.join(d.cwd, '.bounce', 'skills')}): db-migrations`);
});
