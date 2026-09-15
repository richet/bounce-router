import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {Session} from '../src/core.js';
import {hostSession} from '../src/remote.js';
import {createLocalActivation} from '../src/local-activation.js';
import {createScheduler} from '../src/scheduler.js';
import {validateOrchestration} from '../src/profiles.js';

test('TUI setup loaded stays interactive during a held main turn, saves on consent, and Esc cancels only setup', {timeout:20000}, async t => {
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
    readSettings: () => JSON.parse(fs.readFileSync(file)), refresh: () => {}});
  t.after(() => {closeActivation(); scheduler.close();});
  const main={state:()=>({state:runs?'running':'idle',currentTurnId:runs?'held':null}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async run(params){requests.push(params);runs++;for(const fn of listeners)fn({kind:'main.started',requestId:params.id,turnId:'held'});return{accepted:true,requestId:params.id};},
    async cancel(){cancels++;return{accepted:true};}};
  const child=fork(fileURLToPath(new URL('./helpers/tui-process.js',import.meta.url)),[],{env:{...process.env,BOUNCE_HOME:root,BOUNCE_SUPERVISED:'1',BOUNCE_REMOTE_SESSION:'1',BOUNCE_ROLE:'orchestrator',BOUNCE_ORCHESTRATOR_PROFILE:JSON.stringify({adapter:'codex',model:'',mode:'plan'}),BOUNCE_NO_UPDATE_CHECK:'1'},stdio:['pipe','pipe','pipe','ipc']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const hosted=hostSession({session,child,main});
  t.after(async()=>{hosted.detach();if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('close',r));}fs.rmSync(root,{recursive:true,force:true});});
  const wait=async(check)=>{const start=Date.now();while(!check()){if(Date.now()-start>4000)throw Error(output.slice(-4000));await new Promise(r=>setTimeout(r,10));}};
  const answer=async(text,next)=>{const offset=output.length;child.stdin.write(text+'\r');await wait(()=>output.slice(offset).includes(next));};
  await wait(()=>output.includes('Ready.'));child.stdin.write('work\r');await wait(()=>runs===1);
  await answer('/local setup loaded','Workers for');
  await answer('research','Priority:');child.stdin.write('balanced\r');await wait(()=>response);
  child.stdin.write('editable setup draft');await wait(()=>output.includes('editable setup draft'));
  child.stdin.write('\u0015/help\r');await wait(()=>session.events.some(e=>e.kind==='status'&&e.text?.includes('TUI commands:')));
  slow=false;response.setHeader('content-type','application/json');response.end(payload);
  await wait(()=>output.includes('Compare 1 loaded models'));
  assert.equal(output.includes('lmstudio/unloaded-choice'),false);
  await answer('n','Model endpoint/key');await answer('','Worker profile name:');
  await answer('local_read','Adjust worker');await answer('n','Save this configuration?');
  child.stdin.write('y\r');await wait(()=>JSON.parse(fs.readFileSync(file)).profiles.local_read);
  assert.equal(JSON.parse(fs.readFileSync(file)).profiles.local_read.model,'loaded-choice');
  assert.equal(posts,0);assert.equal(runs,1);assert.equal(cancels,0);
  await wait(()=>output.includes('workers active in this session'));
  assert.equal(profiles.local_read.adapter, 'local');
  assert.equal(profiles.local_read.model, 'loaded-choice');
  assert.equal(session.events.filter(row => row.kind === 'local.profiles.activated').length, 1);
  await answer('/local setup loaded','Workers for');
  child.stdin.write('\u001b');await wait(()=>output.includes('Local setup cancelled'));
  assert.equal(cancels,0);assert.equal(runs,1);
  child.stdin.write('/model test-only\r');
  await wait(()=>JSON.parse(fs.readFileSync(file)).models.codex==='test-only');
  assert.equal(JSON.parse(fs.readFileSync(file)).mode,'yolo','future defaults survive later TUI saves');
  assert.equal(JSON.parse(fs.readFileSync(file)).profiles.local_read.model,'loaded-choice');
  session.append({kind:'main.terminal',requestId:requests[0].id,turnId:'held',status:'completed'});
  await wait(()=>output.includes('Turn completed'));
  child.stdin.write('next work\r');await wait(()=>runs===2);
  assert.equal(requests[1].mode,'plan','setup must not change permissions on the active session');
});
