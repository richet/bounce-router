import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session, Router, defaults, handoff} from '../src/core.js';
import {invocation, normalize, runProcess} from '../src/providers.js';
const setup = t => {const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localrouter-test-')); t.after(() => fs.rmSync(root, {recursive:true, force:true})); return {root, session: new Session(root, {root})};};

test('quota fallback transfers partial work and remains sticky across turns', async t => {
  const {session} = setup(t); const attempts = [];
  const router = new Router(session, defaults(), {runner: async options => {
    attempts.push(options);
    if (options.provider === 'claude') {options.emit({kind:'assistant',text:'Created parser.js; tests still pending'}); return {status:'limited'};}
    return {status:'completed'};
  }});
  assert.equal(await router.run('Build a parser'), 'completed');
  assert.deepEqual(attempts.map(a=>a.provider), ['claude','codex']);
  assert.match(attempts[1].prompt, /Created parser.js/);
  await router.run('Now test it');
  assert.equal(attempts[2].provider, 'codex');
  assert.match(attempts[2].prompt, /Build a parser/);
});
test('unrelated failures stop and cancellation never falls through', async t => {
  const {session} = setup(t); let calls = 0;
  const router = new Router(session, defaults(), {runner: async () => {calls++; return {status:'failed'};}});
  assert.equal(await router.run('Task'), 'failed'); assert.equal(calls,1);
  const cancelRouter = new Router(session, defaults(), {runner: async ({signal}) => {cancelRouter.cancel(); assert.equal(signal.aborted,true); return {status:'cancelled'};}});
  assert.equal(await cancelRouter.run('Task'), 'cancelled');
});
test('missing agents and exhausted route terminate after one attempt each', async t => {
  const {session} = setup(t); let calls=0;
  const router = new Router(session, defaults(), {runner: async () => {calls++; return {status:'missing'};}});
  assert.equal(await router.run('Task'), 'unavailable'); assert.equal(calls,3);
});
test('session replay, durable cooldown, lock and path validation', async t => {
  const {root, session} = setup(t);
  session.append({kind:'note',text:'Keep the public API stable'});
  session.append({kind:'cooldown',provider:'claude',until:Date.now()+50000});
  session.lock(); assert.throws(()=>session.lock(), /already open/); session.unlock();
  const resumed = new Session(root, {root,id:session.id});
  assert.equal(resumed.events.at(-2).text, 'Keep the public API stable');
  assert.ok(new Router(resumed,defaults()).cooldowns.claude > Date.now());
  assert.throws(()=>new Session(root,{root,id:'../escape'}), /Invalid/);
  assert.match(handoff(resumed, 'Continue'), /Keep the public API stable/);
});
test('torn final journal record can be recovered', t => {
  const {root,session} = setup(t);
  fs.appendFileSync(session.file, '{"torn":');
  const resumed = new Session(root,{root,id:session.id}); resumed.append({kind:'note',text:'Recovered'});
  assert.equal(new Session(root,{root,id:session.id}).events.at(-1).text,'Recovered');
});
test('provider commands use explicit YOLO and model flags without shell interpolation', () => {
  assert.ok(invocation('claude',{mode:'yolo',model:'model; echo no'}).includes('model; echo no'));
  assert.ok(invocation('codex',{mode:'yolo'}).includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(invocation('muse',{mode:'yolo'},'/tmp/prompt').includes('--yolo'));
  for (const p of ['claude','codex','muse']) assert.ok(!invocation(p,{mode:'plan'},'/tmp/prompt').includes('--yolo'));
});
test('normalizers capture vendor results, tools and usage', () => {
  assert.equal(normalize('claude',{type:'assistant',message:{content:[{type:'text',text:'hello'}]}})[0].text,'hello');
  assert.equal(normalize('claude',{type:'result',is_error:true,result:'usage limit'})[0].kind,'error');
  assert.equal(normalize('codex',{type:'item.completed',item:{type:'command_execution',command:'npm test',aggregated_output:'passed'}})[0].kind,'tool');
  assert.equal(normalize('codex',{type:'turn.completed',usage:{input_tokens:42}})[0].usage.input_tokens,42);
  assert.equal(normalize('muse',{payload_type:'run.output.delta',payload:{text:'hello'}})[0].text,'hello');
  assert.equal(normalize('muse',{payload_type:'run.terminal.completed',payload:{terminal:'completed',text:'hello'}})[0].success,true);
});
async function fixture(source, {signal, provider='codex'} = {}) {
  const events=[];
  const result=await runProcess({provider,executable:process.execPath,args:['-e',source],prompt:'test',cwd:os.tmpdir(),signal,emit:e=>events.push(e)});
  return {result,events};
}
test('real child handles chunked JSON, nonzero quota errors and avoids text false positives', async () => {
  let r = await fixture(`process.stdout.write('{"type":"turn.fa'); setTimeout(()=>{process.stdout.write('iled","error":{"message":"usage limit reached"}}\\n');process.exitCode=1},10)`);
  assert.equal(r.result.status,'limited');
  r = await fixture(`console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Document error 429 rate limit'}}));console.log(JSON.stringify({type:'turn.completed',usage:{}}))`);
  assert.equal(r.result.status,'completed');
  r = await fixture(`console.error('rate limit exceeded');process.exitCode=1`);
  assert.equal(r.result.status,'limited');
  r = await fixture(`console.log('some output but no terminal event')`);
  assert.equal(r.result.status,'failed');
});
test('child cancellation waits for exit and reports cancelled', async () => {
  const controller=new AbortController(); setTimeout(()=>controller.abort(),80);
  const {result}=await fixture('setInterval(()=>{},1000)',{signal:controller.signal});
  assert.equal(result.status,'cancelled');
});
test('missing executable is classified for fallback', async () => {
  const result=await runProcess({provider:'codex',executable:'/nonexistent/localrouter-fixture',args:[],prompt:'',cwd:os.tmpdir(),emit:()=>{}});
  assert.equal(result.status,'missing');
});
