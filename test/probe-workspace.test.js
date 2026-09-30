import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {loadAgents, agentStore, serializeAgent} from '../src/agents.js';
import {validateOrchestration} from '../src/profiles.js';
import {createAttemptWorkspace} from '../src/workspace-artifacts.js';

const waitFor = async (predicate, timeout = 2000) => { const until = Date.now() + timeout; for (;;) { const value = predicate(); if (value) return value; if (Date.now() >= until) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
import {fakeAdapter} from './helpers/fake-adapter.js';

test('analysts default to commands and keep explicitly read-only custom profiles', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-probe-default-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.equal(loadAgents(root).get('analyst').policy,'probe');
 const settings={operation:'orchestrator',mode:'yolo',order:['claude','codex'],profiles:{main:{adapter:'codex'},inspect:{adapter:'codex',role:'analyst'},verify:{adapter:'codex',role:'verifier'}}};
 const view=validateOrchestration(settings);
 assert.equal(view.profiles.inspect.policy,'probe');assert.equal(view.profiles.verify.policy,'probe');
 const derived=validateOrchestration({...settings,profiles:{main:{adapter:'codex'}}},undefined,{roles:loadAgents(root)});
 assert.equal(derived.profiles.analyst.adapter,'codex');assert.equal(derived.profiles.analyst.policy,'probe');
 fs.mkdirSync(agentStore(root),{recursive:true});
 fs.writeFileSync(path.join(agentStore(root),'analyst.md'),serializeAgent({name:'analyst',description:'Source only',policy:'read-only',prompt:'Read only'}));
 assert.equal(loadAgents(root).get('analyst').policy,'read-only');
});

test('command-capable analysts and review gates write only disposable copies and never integrate their outputs', {timeout:4000}, async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-probe-copy-'));
 const cwd=path.join(root,'project');fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'source.js'),'original');
 const session=new Session(cwd,{root});const seen=[];
 const adapter=fakeAdapter(({cwd:work,profile,peer})=>{
  assert.notEqual(work,cwd);assert.equal(profile.probeSource,fs.realpathSync(cwd));
  assert.equal(fs.readFileSync(path.join(work,'source.js'),'utf8'),'original');
  fs.writeFileSync(path.join(work,'source.js'),'scratch change');fs.writeFileSync(path.join(work,'cache.txt'),'check output');seen.push(work);
  return [{kind:'result',status:'completed',text:peer.startsWith('review:')?'{"verdict":"accept"}':'verified'}];
 });
 const scheduler=createScheduler({session,adapters:{worker:adapter},profiles:{analyst:{adapter:'worker',policy:'probe'},reviewer:{adapter:'worker',policy:'probe'}},watchdog:{interval:null}});
 t.after(()=>{scheduler.close();fs.rmSync(root,{recursive:true,force:true});});
 const done=new Promise(resolve=>{const off=session.subscribe(row=>{if(['task.accepted','task.failed','task.blocked'].includes(row.kind)){off();resolve(row);}});});
 scheduler.submit({task:'audit',profile:'analyst',orders:'Run checks',requires:['exec'],review:{completion:'reviewer'}});
 const result=await done;assert.equal(result.kind,'task.accepted',result.text);
 assert.equal(seen.length,2);assert.notEqual(seen[0],seen[1]);
 assert.equal(fs.readFileSync(path.join(cwd,'source.js'),'utf8'),'original');assert.equal(fs.existsSync(path.join(cwd,'cache.txt')),false);
 assert.equal(session.events.some(e=>['task.artifact','task.integrated'].includes(e.kind)),false);
});

test('automatic AI selection cannot remove a probe role command capability', {timeout:3000}, async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-probe-routing-'));
 const session=new Session(root,{root});
 const worker=fakeAdapter(()=>[{kind:'result',status:'completed',text:'checked'}]);
 const unsupported=fakeAdapter(()=>{throw new Error('unsupported backend launched');});
 unsupported.capabilities=()=>({executionPolicies:['read-only','yolo']});
 const scheduler=createScheduler({session,adapters:{opencode:worker,claude:unsupported},profiles:{analyst:{auto:true,adapter:'opencode',role:'analyst',policy:'probe',agent:{name:'analyst'}},cloud:{adapter:'claude',policy:'write'}},jev:{routeAI:async()=>({ai:'cloud',asked:true})},watchdog:{interval:null}});
 t.after(()=>{scheduler.close();fs.rmSync(root,{recursive:true,force:true});});
 const done=new Promise(resolve=>{const off=session.subscribe(row=>{if(['task.completed','task.failed','task.blocked'].includes(row.kind)){off();resolve(row);}});});
 scheduler.submit({task:'audit',profile:'analyst',orders:'Check',requires:['exec']});
 const result=await done;assert.equal(result.kind,'task.completed',result.text);assert.equal(worker.calls.launch,1);assert.equal(unsupported.calls.launch,0);
});

for (const wasDisposable of [true, false]) test(`restart rejects an incompatible workspace purpose (${wasDisposable})`, {timeout:3000}, async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-probe-purpose-'));const cwd=path.join(root,'project');fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'file'),'original');
 const session=new Session(cwd,{root});
 const ws=createAttemptWorkspace({cwd,dir:path.join(root,'attempt'),owns:['**'],attemptId:'old',disposable:wasDisposable});
 session.append({kind:'task.submitted',task:'audit',profile:'worker',orders:'Check',jobId:'job'});
 session.append({kind:'task.workspace',task:'audit',attempt:1,cwd:ws.cwd,metadata:path.join(ws.cwd,'.attempt-workspace.json')});
 const adapter=fakeAdapter(()=>[{kind:'result',status:'completed',text:'wrong'}]);
 const scheduler=createScheduler({session,adapters:{worker:adapter},profiles:{worker:{adapter:'worker',policy:wasDisposable?'write':'probe'}},watchdog:{interval:null}});
 t.after(()=>{scheduler.close();fs.rmSync(root,{recursive:true,force:true});});
 const done=new Promise(resolve=>{const off=session.subscribe(row=>{if(['task.failed','task.completed'].includes(row.kind)){off();resolve(row);}});});
 await scheduler.reconcile();const result=await done;
 assert.equal(result.kind,'task.failed');assert.match(result.text,/workspace policy changed/);assert.equal(adapter.calls.launch,0);
 assert.equal(fs.readFileSync(path.join(cwd,'file'),'utf8'),'original');
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

// Observed live (2026-09-25, 159f4746 task 921f9fe0): ACE's builder agent file says "Project: Ace … at
// /Users/…/code/ace". OpenCode gets the agent text as its system prompt, apart from the orders, so the
// path was never rewritten: the local worker wrote to the real checkout, the fence refused, and it spent
// its turn on workarounds. The agent text points into the working copy too.
test('an isolated OpenCode worker\'s agent prompt points into its working copy, not the real checkout', {timeout: 4000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agent-prompt-'));
  const cwd = path.join(root, 'project'); fs.mkdirSync(path.join(cwd, 'src'), {recursive: true}); fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x');
  const session = new Session(cwd, {root}); const real = fs.realpathSync(cwd); const seen = [];
  const adapter = fakeAdapter(({cwd: work, profile}) => { seen.push({work, profile}); return [{kind: 'result', status: 'completed', text: 'done'}]; });
  const agent = {name: 'builder', prompt: `You are a builder. Project: Ace at ${real}. Tests write under ${real}/tests.`};
  const scheduler = createScheduler({session, adapters: {opencode: adapter}, profiles: {builder: {adapter: 'opencode', policy: 'write', agent}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  scheduler.submit({task: 'edit', profile: 'builder', owns: ['src/a.ts'], requires: ['read', 'exec', 'write'], orders: 'Edit src/a.ts.'});
  await waitFor(() => seen.length === 1);
  const [{work, profile}] = seen;
  assert.equal(profile.agent.prompt, `You are a builder. Project: Ace at ${work}. Tests write under ${work}/tests.`);
  assert.equal(agent.prompt.includes(real), true, 'the shared agent definition itself is not mutated');
});

// Found on the real path (benchmark, 2026-09-28): a local reviewer ended without an answer, the
// orchestrator retried the review on a cloud profile with retryOf, and the retry was refused before it
// started: "workspace policy changed; submit a new scoped task". The reviewer's copy was a throwaway
// one and the new profile writes; a retry on another AI gets a copy of its own instead of a refusal.
test('a retry on a profile of another kind gets a working copy of its own, instead of being refused for its predecessor\'s', {timeout: 5000}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-probe-retry-')));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'file'), 'original');
  const session = new Session(cwd, {root: path.join(root, 'home')});
  const local = fakeAdapter(() => [{kind: 'result', status: 'failed', recoverable: true, text: 'opencode finished without an answer'}]);
  const cloud = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'reviewed: no finding'}]);
  const scheduler = createScheduler({session, adapters: {local, cloud}, watchdog: {interval: null},
    profiles: {reviewer: {adapter: 'local', role: 'reviewer', policy: 'probe', fallback: []}, cloud: {adapter: 'cloud', role: 'builder', policy: 'write', fallback: []}}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });

  const first = scheduler.submit({parent: null, profile: 'reviewer', orders: 'Review file', requires: ['read'], deadline: null});
  await waitFor(() => scheduler.tasks()[first.task]?.state === 'failed');
  const retry = scheduler.submit({parent: null, profile: 'cloud', orders: 'Review file', requires: ['read'], deadline: null, retryOf: first.task});
  await waitFor(() => ['completed', 'accepted', 'failed'].includes(scheduler.tasks()[retry.task]?.state));

  assert.equal(scheduler.tasks()[retry.task].state, 'completed', session.events.findLast(e => e.task === retry.task && e.kind === 'task.failed')?.text);
  assert.equal(cloud.calls.launch, 1);
  const copies = session.events.filter(e => e.kind === 'task.workspace');
  assert.deepEqual(copies.map(row => [row.task, row.purpose]), [[first.task, 'probe'], [retry.task, 'publish']]);
  assert.notEqual(copies[0].cwd, copies[1].cwd);
  assert.equal(fs.readFileSync(path.join(cwd, 'file'), 'utf8'), 'original');
});
