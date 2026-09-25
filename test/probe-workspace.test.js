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
test('an isolated write worker is sent into its working copy and fenced off the real checkout', {timeout: 4000}, async t => {
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
  assert.equal(profile.writeFence, real);
  assert.match(orders, new RegExp(`^Append a section to ${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/docs/PROGRESS\\.md and show the tail of ${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/docs/PROGRESS\\.md\\.`));
  assert.equal(orders.includes(`${real}/docs`), false);
  assert.match(orders, /Your working copy is .+: it is a copy of the project, and only changes made there are your work\. Writes to the original checkout .+ are refused\./);
});
