import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session, Router, defaults, handoff} from '../src/core.js';
import {invocation, normalize, runProcess} from '../src/providers.js';
const setup = t => {const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-test-')); t.after(() => fs.rmSync(root, {recursive:true, force:true})); return {root, session: new Session(root, {root})};};

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
test('token counters and command starts become live progress, not transcript', () => {
  const thinking = normalize('claude',{type:'system',subtype:'thinking_tokens',estimated_tokens:350,estimated_tokens_delta:50});
  assert.deepEqual(thinking,[{kind:'progress',text:'Thinking · ~350 tokens'}]);
  assert.deepEqual(normalize('claude',{type:'tool_progress',tool_name:'Bash',elapsed_time_seconds:30}),[{kind:'progress',text:'Bash · 30s'}]);
  assert.equal(normalize('claude',{type:'system',subtype:'init',model:'m',tools:['Bash','Read']}).find(e=>e.kind==='progress').text,'Ready · 2 tools');
  assert.equal(normalize('codex',{type:'item.started',item:{command:'npm test\nsecond line'}})[0].kind,'progress');
  // Task lifecycle and unknown system events still describe themselves in the transcript.
  assert.deepEqual(normalize('claude',{type:'system',subtype:'task_started',description:'Probe models'}),
    [{kind:'status',text:'Task started · Probe models'}]);
  assert.deepEqual(normalize('claude',{type:'system',subtype:'task_notification',status:'completed',summary:'Probe models'}),
    [{kind:'status',text:'Task completed · Probe models'}]);
  assert.deepEqual(normalize('claude',{type:'system',subtype:'compact_boundary'}),[{kind:'status',text:'compact_boundary'}]);
  // Tool results arrive as content blocks; their text is kept, not a JSON dump.
  assert.equal(normalize('claude',{type:'user',message:{content:[{type:'tool_result',content:[{type:'text',text:'passed'}]}]}})[0].text,'passed');
});

test('progress reaches the display without being written to the journal', async t => {
  const {session} = setup(t);
  const seen = [];
  session.onEvent = e => seen.push(e);
  const router = new Router(session, defaults(), {runner: async ({emit}) => {
    emit({kind:'progress',text:'Thinking · ~50 tokens'});
    emit({kind:'assistant',text:'done'});
    return {status:'completed'};
  }});
  await router.run('hello');
  assert.deepEqual(seen.filter(e=>e.kind==='progress').map(e=>[e.provider,e.text]), [['claude','Thinking · ~50 tokens']]);
  assert.equal(session.events.some(e=>e.kind==='progress'), false);
  assert.equal(fs.readFileSync(session.file,'utf8').includes('progress'), false);
  assert.ok(session.events.some(e=>e.kind==='assistant'));
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
  const result=await runProcess({provider:'codex',executable:'/nonexistent/bounce-fixture',args:[],prompt:'',cwd:os.tmpdir(),emit:()=>{}});
  assert.equal(result.status,'missing');
});

test('normalizers retain reported models without adding transcript text', () => {
  for (const [provider, raw] of [
    ['claude', {type: 'system', subtype: 'init', model: 'claude-model'}],
    ['codex', {type: 'session.started', model: 'codex-model'}],
    ['muse', {payload: {model: 'muse-model'}}],
  ]) {
    const event = normalize(provider, raw).find(e => e.kind === 'model');
    assert.equal(event.model, provider + '-model');
    assert.equal(event.text, undefined);
  }
});
