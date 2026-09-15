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
test('an active turn snapshots routing settings before immediate TUI configuration changes', async t => {
  const {session} = setup(t);
  const settings = defaults();
  settings.models.claude = 'claude-before';
  settings.models.codex = 'codex-before';
  const attempts = [];
  const router = new Router(session, settings, {runner: async options => {
    attempts.push(options);
    if (options.provider === 'claude') {
      settings.mode = 'plan';
      settings.models.codex = 'codex-after';
      settings.order = ['muse', 'claude', 'codex'];
      router.select('muse');
      return {status: 'limited'};
    }
    return {status: 'completed'};
  }});
  assert.equal(await router.run('keep this turn stable'), 'completed');
  assert.deepEqual(attempts.map(({provider}) => provider), ['claude', 'codex']);
  assert.equal(attempts[1].args.includes('codex-before'), true);
  assert.equal(attempts[1].args.includes('codex-after'), false);
  assert.equal(attempts[1].args.includes('--dangerously-bypass-approvals-and-sandbox'), true);
  assert.equal(await router.run('use the preference selected during that turn'), 'completed');
  assert.equal(attempts[2].provider, 'muse');
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
  assert.match(normalize('codex',{method:'item/completed',params:{item:{type:'commandExecution',command:'npm test',aggregatedOutput:'VISIBLE_OUTPUT',exitCode:1}}})[0].text, /VISIBLE_OUTPUT/);
  assert.equal(normalize('codex', {method: 'item/completed', params: {item: {type: 'dynamicToolCall', tool: 'bounce_report', success: true, arguments: {summary: 'not raw JSON'}}}})[0].text, 'bounce_report · accepted');
  assert.equal(normalize('codex',{type:'turn.completed',usage:{input_tokens:42}})[0].usage.input_tokens,42);
  assert.equal(normalize('muse',{payload_type:'run.output.delta',payload:{text:'hello'}})[0].text,'hello');
  assert.equal(normalize('muse',{payload_type:'run.terminal.completed',payload:{terminal:'completed',text:'hello'}})[0].success,true);
});
test('muse tool calls journal results, not lifecycle chatter', () => {
  const intent = op => ({payload_type: 'task.lifecycle.side_effect_intent', payload: {event: {operation: op}}});
  // Model inference is internal: the deltas carry the response, so the intent leaves no trace.
  assert.deepEqual(normalize('muse', intent('model.meta.response')), []);
  // A tool start is live progress, mirroring Codex command starts.
  assert.deepEqual(normalize('muse', intent('tool:read_file')), [{kind: 'progress', text: 'Running · read_file'}]);
  assert.deepEqual(normalize('muse', intent('tool:bash')), [{kind: 'progress', text: 'Running · bash'}]);
  // Lifecycle bookkeeping and streaming output chunks are dropped: the chunk
  // duplicates the assembled tool.result verbatim, so journaling both would
  // double every tool result in the transcript and the fallback handoff.
  for (const raw of [
    {payload_type: 'task.lifecycle.proposed', payload: {event: {task_kind: 'tool.read_file'}}},
    {payload_type: 'task.lifecycle.accepted', payload: {}},
    {payload_type: 'task.lifecycle.scheduled', payload: {}},
    {payload_type: 'task.lifecycle.started', payload: {}},
    {payload_type: 'task.lifecycle.status', payload: {event: {message: 'opening meta model stream attempt 1/10'}}},
    {payload_type: 'task.lifecycle.output', payload: {event: {chunk: 'file contents'}}},
    {payload_type: 'task.lifecycle.completed', payload: {event: {}}},
  ]) assert.deepEqual(normalize('muse', raw), [], raw.payload_type);
  // The assembled result is the journaled record, prefixed with the tool name.
  const result = normalize('muse', {payload_type: 'tool.result',
    payload: {text: 'file contents', correlation_facts: {tool_name: 'read_file', outcome: 'success'}}});
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'tool');
  assert.match(result[0].text, /read_file/);
  assert.match(result[0].text, /file contents/);
  // A failed tool call stays journaled content, not a turn error: the agent may recover.
  const failed = normalize('muse', {payload_type: 'tool.result',
    payload: {text: 'no such file', correlation_facts: {tool_name: 'read_file', outcome: 'error'}}});
  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, 'tool');
  // run.model.configured reports the model under model_id, not model.
  const model = normalize('muse', {payload_type: 'run.model.configured', payload: {model_id: 'muse-spark-1.3'}})
    .find(e => e.kind === 'model');
  assert.equal(model.model, 'muse-spark-1.3');
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
  // A foreground Bash call is a "task" to Claude too; its start and end are live progress, not
  // transcript rows next to the tool row that already shows it. Backgrounded tasks keep theirs.
  assert.deepEqual(normalize('claude',{type:'system',subtype:'task_started',task_id:'fg1',task_type:'local_bash',is_backgrounded:false,description:'Run tests'}),
    [{kind:'progress',text:'Task started · Run tests'}]);
  assert.deepEqual(normalize('claude',{type:'system',subtype:'task_notification',task_id:'fg1',status:'completed',summary:'Run tests'}),
    [{kind:'progress',text:'Task completed · Run tests'}]);
  assert.deepEqual(normalize('claude',{type:'system',subtype:'task_started',task_id:'bg1',task_type:'local_bash',is_backgrounded:true,description:'Watch logs'}),
    [{kind:'status',text:'Task started · Watch logs'}]);
  assert.deepEqual(normalize('claude',{type:'system',subtype:'task_notification',task_id:'bg1',status:'completed',summary:'Watch logs'}),
    [{kind:'status',text:'Task completed · Watch logs'}]);
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

test('vendor CLI processes never inherit bus credentials from the bounce environment', async () => {
  process.env.BOUNCE_BUS_TOKEN_FILE = '/tmp/should-not-leak'; process.env.BOUNCE_BUS = '/tmp/should-not-leak.sock';
  try {
    const r = await fixture(`console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:(process.env.BOUNCE_BUS_TOKEN_FILE??'absent')+'|'+(process.env.BOUNCE_BUS??'absent')}}));console.log(JSON.stringify({type:'turn.completed',usage:{}}))`);
    assert.equal(r.events.find(e => e.kind === 'assistant').text, 'absent|absent');
  } finally { delete process.env.BOUNCE_BUS_TOKEN_FILE; delete process.env.BOUNCE_BUS; }
});

test('extraArgs(provider) is appended to the vendor invocation for this router only', async t => {
  const {Session, Router, defaults} = await import('../src/core.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-extra-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const seen = [];
  const runner = async options => { seen.push(options.args); return {status: 'completed'}; };
  const plain = new Router(session, defaults(), {runner});
  await plain.run('hi');
  const guarded = new Router(session, defaults(), {runner, extraArgs: provider => provider === 'claude' ? ['--disallowedTools', 'Agent,Task'] : []});
  await guarded.run('hi');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], [...seen[0], '--disallowedTools', 'Agent,Task']);
  assert.equal(seen[0].includes('--disallowedTools'), false);
});
