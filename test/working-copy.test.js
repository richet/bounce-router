import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {loadAgents, agentStore, serializeAgent} from '../src/agents.js';
import {validateOrchestration} from '../src/profiles.js';

const waitFor = async (predicate, timeout = 2000) => { const until = Date.now() + timeout; for (;;) { const value = predicate(); if (value) return value; if (Date.now() >= until) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
import {fakeAdapter} from './helpers/fake-adapter.js';

test('analysts write by default, like every role but critic, and an explicitly read-only custom one stays read-only', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-analyst-default-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.equal(loadAgents(root).get('analyst').policy,'write');
 const settings={operation:'orchestrator',mode:'yolo',order:['claude','codex'],profiles:{main:{adapter:'codex'},inspect:{adapter:'codex',role:'analyst'},verify:{adapter:'codex',role:'verifier'}}};
 const view=validateOrchestration(settings);
 assert.equal(view.profiles.inspect.policy,'write');assert.equal(view.profiles.verify.policy,'write');
 fs.mkdirSync(agentStore(root),{recursive:true});
 fs.writeFileSync(path.join(agentStore(root),'analyst.md'),serializeAgent({name:'analyst',description:'Source only',policy:'read-only',prompt:'Read only'}));
 assert.equal(loadAgents(root).get('analyst').policy,'read-only');
});

// Observed live (2026-09-25, e9353126 task 87a72495): orders named the real checkout's absolute path, the
// isolated write worker appended there with a heredoc, its own copy stayed unchanged, and review saw an
// empty diff. A write worker's orders point into its working copy, and it is fenced off the checkout.
test('an isolated write worker is sent into its working copy, unfenced like any Claude or Codex worker', {timeout: 4000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-write-fence-'));
  const cwd = path.join(root, 'project'); fs.mkdirSync(path.join(cwd, 'docs'), {recursive: true}); fs.writeFileSync(path.join(cwd, 'docs', 'PROGRESS.md'), 'original');
  const session = new Session(cwd, {root}); const real = fs.realpathSync(cwd); const seen = [];
  const adapter = fakeAdapter(({cwd: work, profile, orders}) => { seen.push({work, profile, orders}); return [{kind: 'result', status: 'completed', text: 'done'}]; });
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {builder: {adapter: 'worker', policy: 'write'}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  scheduler.submit({task: 'edit', profile: 'builder', owns: ['docs/PROGRESS.md'], requires: ['read', 'exec', 'write'],
    orders: `Append a section to ${real}/docs/PROGRESS.md and show the tail of ${cwd}/docs/PROGRESS.md.`});
  await waitFor(() => seen.length === 1);
  const [{work, profile, orders}] = seen;
  assert.notEqual(work, cwd);
  // User, 2026-09-27: local write workers get the same freedom as Claude and Codex ones — no OS fence.
  assert.equal(profile.writeFence, undefined);
  assert.match(orders, new RegExp(`^Append a section to ${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/docs/PROGRESS\\.md and show the tail of ${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/docs/PROGRESS\\.md\\.`));
  assert.equal(orders.includes(`${real}/docs`), false);
  assert.match(orders, /Your working copy is .+: it is a copy of the project, and only changes made there are your work: bounce integrates them into the original checkout .+ after review, so edit the copy, never the original\./);
});

// Observed live (2026-09-25, 159f4746 task 921f9fe0): a builder agent file said "Project: Shop … at
// /Users/…/code/shop". OpenCode gets the agent text as its system prompt, apart from the orders, so the
// path was never rewritten: the local worker wrote to the real checkout, the fence refused, and it spent
// its turn on workarounds. The agent text points into the working copy too.
test('an isolated OpenCode worker\'s agent prompt points into its working copy, not the real checkout', {timeout: 4000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agent-prompt-'));
  const cwd = path.join(root, 'project'); fs.mkdirSync(path.join(cwd, 'src'), {recursive: true}); fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x');
  const session = new Session(cwd, {root}); const real = fs.realpathSync(cwd); const seen = [];
  const adapter = fakeAdapter(({cwd: work, profile}) => { seen.push({work, profile}); return [{kind: 'result', status: 'completed', text: 'done'}]; });
  const agent = {name: 'builder', prompt: `You are a builder. Project: Shop at ${real}. Tests write under ${real}/tests.`};
  const scheduler = createScheduler({session, adapters: {opencode: adapter}, profiles: {builder: {adapter: 'opencode', policy: 'write', agent}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  scheduler.submit({task: 'edit', profile: 'builder', owns: ['src/a.ts'], requires: ['read', 'exec', 'write'], orders: 'Edit src/a.ts.'});
  await waitFor(() => seen.length === 1);
  const [{work, profile}] = seen;
  assert.equal(profile.agent.prompt, `You are a builder. Project: Shop at ${work}. Tests write under ${work}/tests.`);
  assert.equal(agent.prompt.includes(real), true, 'the shared agent definition itself is not mutated');
});
