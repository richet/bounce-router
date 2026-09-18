import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runLocalSetup} from '../src/local-wizard.js';
import {starterProfiles, validateOrchestration} from '../src/profiles.js';

const settings = {operation:'orchestrator',mode:'yolo',orchestrator:'main',profiles:{main:{adapter:'claude'}}};
const catalogs = [{provider:'local',backend:'lmstudio',endpoint:'lmstudio',models:[{id:'any',ref:'lmstudio/any',label:'Any',ready:true,type:'llm',tools:true,instances:[{id:'instance',context:8192}],capabilitySource:'server'}]}];
function fixture(answers) {
  let saved; const output = []; const questions = [];
  return {options:{settings, cwd:'/tmp', ask:async q=>{questions.push(q);return answers.shift() ?? null;},write:s=>output.push(s),discover:async()=>catalogs,save:async s=>{saved=s;}}, saved:()=>saved, output, questions};
}
test('guided setup confirms recommended model and saves a validated read-only profile only at final consent', async () => {
  const f=fixture(['research','balanced','n','','local_read','n','y']);
  const result=await runLocalSetup(f.options);
  assert.equal(result.saved,true);
  assert.equal(f.saved().profiles.local_read.model,'any');
  assert.equal(f.saved().profiles.local_read.policy,'read-only');
  assert.equal(f.saved().profiles.local_read.endpoint,'lmstudio');
  assert.deepEqual(settings.profiles,{main:{adapter:'claude'}});
  assert.match(f.output.join('\n'),/Recommendation/);
});
// A worker named after a shipped profile the config never wrote would silently override it in
// the validated view; the name prompt reads the merged table and asks again instead.
test('the name prompt refuses a shipped profile name the config never wrote', async () => {
  const f=fixture(['research','balanced','n','','build','local_read','n','y']);
  const result=await runLocalSetup(f.options);
  assert.equal(result.saved,true);
  assert.deepEqual(result.profiles,['local_read']);
  assert.deepEqual(Object.keys(f.saved().profiles),['main','local_read'],'build stays shipped, never written');
  assert.equal(f.output.filter(line=>/Existing profiles are not overwritten/.test(line)).length,1);
});
// Switching a classic config to orchestrator writes the overlay only: `{}` plus orchestrator
// `main`, never a copy of the shipped roster, which the validated view supplies underneath.
test('the classic-to-orchestrator switch saves an empty overlay, not the shipped roster', async () => {
  const classic={mode:'yolo'};
  const f=fixture(['y','research','balanced','n','','local_read','n','y']);
  const result=await runLocalSetup({...f.options,settings:classic});
  assert.equal(result.saved,true);
  assert.deepEqual(classic,{mode:'yolo'},'the input is never mutated');
  const saved=f.saved();
  assert.equal(saved.operation,'orchestrator');
  assert.equal(saved.orchestrator,'main');
  assert.deepEqual(Object.keys(saved.profiles),['local_read'],'the overlay only, never a copy of the roster');
  const view=validateOrchestration(saved);
  assert.deepEqual(Object.keys(view.profiles),[...Object.keys(starterProfiles(saved)),'local_read']);
  assert.equal(view.profiles.build.adapter,'codex');
  assert.equal(view.profiles.local_read.adapter,'local');
});
test('EOF and final decline never save or infer', async () => {
  for (const answers of [[],['research','balanced','n','','local_read','n','n']]) {
    const f=fixture(answers);
    assert.equal((await runLocalSetup({...f.options,probe:()=>{throw Error('no consent');}})).saved,false);
    assert.equal(f.saved(),undefined);
  }
});
test('confirmation refresh blocks disappearing model without persisting', async () => {
  const f=fixture(['research','balanced','n','','local_read','n','y']); let reads=0;
  await assert.rejects(runLocalSetup({...f.options,discover:async()=>++reads===1?catalogs:[]}), /available|eligible|changed/i);
  assert.equal(f.saved(),undefined);
});
test('uncertain probe stops setup rather than continuing on shared inference capacity', async () => {
  const f=fixture(['research','balanced','y']);
  assert.equal((await runLocalSetup({...f.options,probe:async()=>({ref:'lmstudio/any',intent:'research',status:'uncertain',evidence:['timeout']})})).saved,false);
  assert.equal(f.saved(),undefined);
  assert.match(f.output.join(' '),/uncertain/i);
});

test('coding setup exposes exact permissions, dependency build consent and bounded limits', async () => {
  const f=fixture(['coding','context','n','','my_builder','src','node --test','my-image','n','y','4096','60000','256','1','32','32','y']);
  let builds=0;
  const result=await runLocalSetup({...f.options,prepare:async()=>{builds++;throw Error('not approved');},inspect:async()=>({docker:{ready:true},image:{ready:true,id:'sha256:abc'}})});
  assert.equal(result.saved,true);
  assert.equal(builds,0);
  const profile=f.saved().profiles.my_builder;
  assert.deepEqual(profile.writePaths,['src']);
  assert.deepEqual(profile.commands,['node --test']);
  assert.equal(profile.container.memoryMiB,256);
  assert.equal(profile.localOptions.maxOutputTokens,4096);
  assert.equal(profile.localOptions.timeoutMs,60000);
});
