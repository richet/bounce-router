import './helpers/env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {agentMetadata} from '../src/agents.js';
import {fakeOpencodeBin} from './helpers/fake-opencode-bin.js';

test('real guided CLI offers discovery, accepts confirmation, and never starts an agent or overwrites changed config', {timeout:20000}, async t => {
  const bin=fakeOpencodeBin(t,{model:'loaded'});
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bounce-wizard-cli-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let posts=0, requests=0, change=false;
  const file=path.join(root,'config.json');
  const server=createServer(async(req,res)=>{
    if(req.method==='POST')posts++;
    requests++;
    if(change && requests===2) await fs.writeFile(file,JSON.stringify({...settings,cooldownMinutes:99}));
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({models:[{key:'unnamed-model',type:'llm',capabilities:{trained_for_tool_use:true},loaded_instances:[{id:'loaded',config:{context_length:8192}}]}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const settings={operation:'orchestrator',mode:'yolo',orchestrator:'main',profiles:{main:{adapter:'claude'}},local:{endpoints:{lmstudio:{backend:'lmstudio',url:`http://127.0.0.1:${server.address().port}`}}}};
  const run=answers=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),'local','setup'],{env:{...process.env,...bin.env,BOUNCE_HOME:root,BOUNCE_NO_UPDATE_CHECK:'1'},stdio:['pipe','pipe','pipe']});
    let output=''; const timer=setTimeout(()=>{child.kill();reject(Error(output));},10000);
    child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
    child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({code,output});});
    child.stdin.end(answers.join('\n')+'\n');
  });
  await fs.writeFile(file,JSON.stringify(settings));
  // The four shipped agents, alphabetically: analyst takes the suggested model (Enter), the rest skip.
  const accepted=await run(['','skip','skip','skip','y']);
  assert.equal(accepted.code,0,accepted.output);
  assert.match(accepted.output,/Loaded: \[1\] loaded \(8k\)/);
  assert.match(accepted.output,/analyst → loaded · then claude\/default/);
  assert.match(accepted.output,/OpenCode bridge ready/);
  const analyst=agentMetadata(await fs.readFile(path.join(root,'agents','analyst.md'),'utf8'));
  assert.deepEqual(analyst.models.slice(0,1),['lmstudio/loaded']);
  assert.deepEqual(JSON.parse(await fs.readFile(file)).profiles,{main:{adapter:'claude'}},'no profile is created');
  assert.equal(posts,0,'setup never sends an inference or load request to LM Studio itself');
  assert.deepEqual((await fs.readdir(root)).sort(),['agents','config.json']);
  // The config changes while setup is open: nothing is saved, and no agent file is left behind.
  await fs.rm(path.join(root,'agents'),{recursive:true,force:true});
  await fs.writeFile(file,JSON.stringify(settings));requests=0;change=true;
  const conflict=await run(['','skip','skip','skip','y']);
  assert.equal(conflict.code,1,conflict.output);
  assert.match(conflict.output,/configuration changed/i);
  assert.equal(JSON.parse(await fs.readFile(file)).cooldownMinutes,99);
  assert.deepEqual((await fs.readdir(root)).sort(),['config.json']);
});
