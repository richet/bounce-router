import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fakeOpencodeBin} from './helpers/fake-opencode-bin.js';
import http from 'node:http';
import {Session} from '../src/core.js';
import {hostSession} from '../src/remote.js';
import {createLocalActivation} from '../src/local-activation.js';
import {createScheduler} from '../src/scheduler.js';
import {starterProfiles, validateOrchestration} from '../src/profiles.js';
import {rolesFor, agentMetadata} from '../src/agents.js';

test('TUI setup loaded stays interactive during a held main turn, saves on consent, and Esc cancels only setup', {timeout:20000}, async t => {
  const bin=fakeOpencodeBin(t,{model:'loaded'});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-setup-tui-'));
  let response, slow=true, posts=0;
  const payload=JSON.stringify({models:[
    {key:'loaded-choice',type:'llm',capabilities:{trained_for_tool_use:true},loaded_instances:[{id:'loaded',config:{context_length:8192}}]},
    {key:'unloaded-choice',type:'llm',capabilities:{trained_for_tool_use:true},loaded_instances:[]},
  ]});
  const server=http.createServer((req,res)=>{if(req.method==='POST')posts++;if(slow)response=res;else{res.setHeader('content-type','application/json');res.end(payload);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const settings={operation:'orchestrator',orchestrator:'main',mode:'yolo',order:['codex'],models:{},profiles:{main:{adapter:'codex'}},
    local:{endpoints:{lmstudio:{backend:'lmstudio',url:`http://127.0.0.1:${server.address().port}`}}},
    executables:{codex:'/nonexistent/test-codex',claude:'/nonexistent/test-claude'},skills:{scope:'user',autoSync:false}};
  const file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify(settings));
  const session=new Session(root,{root});const listeners=new Set();const requests=[];let runs=0,cancels=0;
  const profiles = validateOrchestration(settings).profiles;
  const scheduler = createScheduler({session, profiles, adapters: {}, localSettings: settings.local});
  const closeActivation = createLocalActivation({session, scheduler, profiles, settings,
    readSettings: () => JSON.parse(fs.readFileSync(file)), readRoles: () => rolesFor(root, {cwd: root}), refresh: () => {}});
  t.after(() => {closeActivation(); scheduler.close();});
  const main={state:()=>({state:runs?'running':'idle',currentTurnId:runs?'held':null}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async run(params){requests.push(params);runs++;for(const fn of listeners)fn({kind:'main.started',requestId:params.id,turnId:'held'});return{accepted:true,requestId:params.id};},
    async cancel(){cancels++;return{accepted:true};}};
  const child=fork(fileURLToPath(new URL('./helpers/tui-process.js',import.meta.url)),[],{env:{...process.env,...bin.env,BOUNCE_HOME:root,BOUNCE_SUPERVISED:'1',BOUNCE_REMOTE_SESSION:'1',BOUNCE_ROLE:'orchestrator',BOUNCE_ORCHESTRATOR_PROFILE:JSON.stringify({adapter:'codex',model:'',mode:'plan'}),BOUNCE_NO_UPDATE_CHECK:'1'},stdio:['pipe','pipe','pipe','ipc']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const hosted=hostSession({session,child,main});
  t.after(async()=>{hosted.detach();if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('close',r));}fs.rmSync(root,{recursive:true,force:true});});
  const wait=async(check)=>{const start=Date.now();while(!check()){if(Date.now()-start>4000)throw Error(output.slice(-4000));await new Promise(r=>setTimeout(r,10));}};
  const answer=async(text,next)=>{const offset=output.length;child.stdin.write(text+'\r');await wait(()=>output.slice(offset).includes(next));};
  await wait(()=>output.includes('Ready.'));child.stdin.write('work\r');await wait(()=>runs===1);
  await answer('/local setup loaded','Discovering local models');await wait(()=>response);
  child.stdin.write('editable setup draft');await wait(()=>output.includes('editable setup draft'));
  child.stdin.write('\u0015/help\r');await wait(()=>session.events.some(e=>e.kind==='help'&&e.text?.includes('Agents & models')));
  slow=false;response.setHeader('content-type','application/json');response.end(payload);
  // Setup opens on the shipped agents, one numbered pick each: analyst takes the loaded model, the rest are skipped.
  await wait(()=>output.includes('analyst ('));await answer('1','builder (');
  await answer('skip','integrator (');await answer('skip','reviewer (');await answer('skip','Save this configuration?');
  assert.equal(output.includes('unloaded-choice'),false,'`loaded` never offers a model that would have to be loaded');
  child.stdin.write('y\r');await wait(()=>fs.existsSync(path.join(root,'agents','analyst.md')));
  assert.deepEqual(agentMetadata(fs.readFileSync(path.join(root,'agents','analyst.md'),'utf8')).models,['lmstudio/loaded','codex/default']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).profiles,{main:{adapter:'codex'}},'no profile is created');
  assert.equal(posts,0);assert.equal(runs,1);assert.equal(cancels,0);
  await wait(()=>output.includes('agents analyst active in this session'));
  assert.deepEqual([profiles.analyst.adapter, profiles.analyst.model, profiles.analyst.fallback], ['opencode', 'loaded', ['analyst~2']]);
  assert.equal(profiles['analyst~2'].adapter, 'codex');
  assert.equal(session.events.filter(row => row.kind === 'local.profiles.activated').length, 1);
  // `/local` renders the same status `bounce local` prints, into the transcript. It runs here, once
  // the fake LM Studio answers immediately and a worker exists: the status is a chain check, and an
  // endpoint that does not answer is (correctly) reported as the first broken link rather than
  // ignored. The live bridge turn stays behind `/local verify`, so a plain status costs no inference.
  child.stdin.write('/local\r');
  await wait(()=>session.events.some(e=>e.kind==='status'&&e.text?.includes('OpenCode:')));
  const localStatus=session.events.findLast(e=>e.kind==='status'&&e.text?.includes('OpenCode:'));
  assert.doesNotMatch(localStatus.text,/NOT READY/);
  assert.match(localStatus.text,/run \/local verify to prove the bridge/);
  assert.match(localStatus.text,/Agents a local model may play: analyst \(lmstudio\/loaded, read-only\)/);
  await answer('/local setup loaded','analyst (');
  child.stdin.write('\u001b');await wait(()=>output.includes('Local setup cancelled'));
  assert.equal(cancels,0);assert.equal(runs,1);
  child.stdin.write('/model test-only\r');
  await wait(()=>JSON.parse(fs.readFileSync(file)).models.codex==='test-only');
  assert.equal(JSON.parse(fs.readFileSync(file)).mode,'yolo','future defaults survive later TUI saves');
  session.append({kind:'main.terminal',requestId:requests[0].id,turnId:'held',status:'completed'});
  await wait(()=>output.includes('Turn completed'));
  child.stdin.write('next work\r');await wait(()=>runs===2);
  assert.equal(requests[1].mode,'plan','setup must not change permissions on the active session');
});

// Orchestrator config with no `profiles` block (the shipped roster): /local setup must add the
// worker rather than TypeError on the absent block, the saved block holds only the worker (the
// shipped roster stays underneath it in the validated view), and a later `/model worker … --save`
// persists into the same block.
test('TUI setup on a config with no profiles block writes an agent file and never copies the shipped roster into the config', {timeout:20000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-setup-tui-roster-'));
  const bin=fakeOpencodeBin(t,{model:'loaded'});
  const payload=JSON.stringify({models:[{key:'loaded-choice',type:'llm',capabilities:{trained_for_tool_use:true},loaded_instances:[{id:'loaded',config:{context_length:8192}}]}]});
  const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(payload);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const settings={operation:'orchestrator',mode:'yolo',order:['codex'],models:{},
    local:{endpoints:{lmstudio:{backend:'lmstudio',url:`http://127.0.0.1:${server.address().port}`}}},
    executables:{codex:'/nonexistent/test-codex',claude:'/nonexistent/test-claude'},skills:{scope:'user',autoSync:false}};
  const file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify(settings));
  const session=new Session(root,{root});
  const profiles = validateOrchestration(settings).profiles;
  const scheduler = createScheduler({session, profiles, adapters: {}, localSettings: settings.local});
  const closeActivation = createLocalActivation({session, scheduler, profiles, settings,
    readSettings: () => JSON.parse(fs.readFileSync(file)), readRoles: () => rolesFor(root, {cwd: root}), refresh: () => {}});
  t.after(() => {closeActivation(); scheduler.close();});
  const main={state:()=>({state:'idle',currentTurnId:null}),subscribe(){return()=>{};},
    async run(params){return{accepted:true,requestId:params.id};},async cancel(){return{accepted:true};}};
  const child=fork(fileURLToPath(new URL('./helpers/tui-process.js',import.meta.url)),[],{env:{...process.env,...bin.env,BOUNCE_HOME:root,BOUNCE_SUPERVISED:'1',BOUNCE_REMOTE_SESSION:'1',BOUNCE_ROLE:'orchestrator',BOUNCE_ORCHESTRATOR_PROFILE:JSON.stringify({adapter:'codex',model:'',mode:'plan'}),BOUNCE_NO_UPDATE_CHECK:'1'},stdio:['pipe','pipe','pipe','ipc']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const hosted=hostSession({session,child,main});
  t.after(async()=>{hosted.detach();if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('close',r));}fs.rmSync(root,{recursive:true,force:true});});
  const wait=async(check)=>{const start=Date.now();while(!check()){if(Date.now()-start>4000)throw Error(output.slice(-4000));await new Promise(r=>setTimeout(r,10));}};
  const answer=async(text,next)=>{const offset=output.length;child.stdin.write(text+'\r');await wait(()=>output.slice(offset).includes(next));};
  await wait(()=>output.includes('Ready.'));
  await answer('/local setup loaded','analyst (');
  await answer('1','builder (');await answer('skip','integrator (');await answer('skip','reviewer (');await answer('skip','Save this configuration?');
  child.stdin.write('y\r');await wait(()=>output.includes('agents analyst active in this session'));
  const saved=JSON.parse(fs.readFileSync(file));
  assert.equal(saved.orchestrator,'main');
  assert.deepEqual(saved.profiles,{},'the overlay only, never a copy of the roster — and an agent is a file, not a profile');
  assert.deepEqual(agentMetadata(fs.readFileSync(path.join(root,'agents','analyst.md'),'utf8')).models,['lmstudio/loaded','codex/default']);
  const view=validateOrchestration(saved,undefined,{roles:rolesFor(root,{cwd:root})});
  assert.deepEqual(Object.keys(view.profiles).filter(name=>!view.profiles[name].derived),Object.keys(starterProfiles(settings)));
  assert.equal(view.profiles.build.adapter,'codex');
  assert.deepEqual([view.profiles.analyst.adapter,view.profiles.analyst.model],['opencode','loaded']);
  assert.equal(profiles.analyst.model,'loaded','and the running session has it');
});
