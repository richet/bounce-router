import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recommendLocalModels, probeLocalModel} from '../src/local-recommend.js';

const model = (id, context = 8192) => ({id, ref: `lmstudio/${id}`, label: id, type: 'llm', ready: true, tools: true, capabilitySource: 'server', instances: [{id: `${id}-instance`, context}], context});
const catalogs = [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [model('arbitrary-a'), model('arbitrary-z', 32768)]}];
const settings = {};

test('recommendations derive from evidence and user priorities, not model names', () => {
  const result = recommendLocalModels({catalogs, settings, priority: 'context'});
  assert.equal(result.recommended, 'lmstudio/arbitrary-z');
  assert.match(result.notes.join(' '), /quality.*unknown|not.*quality/i);
  const preferred = recommendLocalModels({catalogs, settings: {local: {preferences: {analyst: {prefer: ['lmstudio/arbitrary-a']}}}}, priority: 'context'});
  assert.equal(preferred.recommended, 'lmstudio/arbitrary-a');
  const speed = recommendLocalModels({catalogs, settings, priority: 'speed', probes: [
    {ref:'lmstudio/arbitrary-a',intent:'research',status:'passed',durationMs:30},
    {ref:'lmstudio/arbitrary-z',intent:'research',status:'passed',durationMs:10},
  ]});
  assert.equal(speed.recommended, 'lmstudio/arbitrary-z');
});

test('stale, unloaded, unknown tool capability, excluded and failed models are not recommended', () => {
  for (const mutate of [m => m.ready = false, m => m.tools = null, m => m.type = 'embedding']) {
    const copy = structuredClone(catalogs); copy[0].models.forEach(mutate);
    assert.equal(recommendLocalModels({catalogs: copy, settings}).recommended, null);
  }
  const unloaded = recommendLocalModels({catalogs:[{...catalogs[0],models:[{...model('a'),ready:false}]}],settings});
  assert.match(unloaded.candidates[0].reasons.join(' '), /not loaded/i);
  assert.equal(recommendLocalModels({catalogs: [{...catalogs[0], stale: true}], settings}).recommended, null);
  assert.equal(recommendLocalModels({catalogs, settings: {local: {exclude: catalogs[0].models.map(m=>m.ref)}}}).recommended, null);
  assert.equal(recommendLocalModels({catalogs, settings, probes: catalogs[0].models.map(m=>({ref:m.ref,intent:'research',status:'failed'}))}).recommended, null);
});

test('synthetic probe verifies exact tool answer, pins instance and sends no workspace data', async () => {
  let payload;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:1234/v1/chat/completions');
    payload = JSON.parse(options.body);
    const frame = {choices: [{delta: {tool_calls: [{index:0,id:'answer',function:{name:'submit_answer',arguments:JSON.stringify({answer:42})}}]},finish_reason:'tool_calls'}]};
    return new Response(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const result = await probeLocalModel({catalogs,ref:'lmstudio/arbitrary-a',fetchImpl});
  assert.equal(result.status, 'passed');
  assert.equal(payload.model, 'arbitrary-a-instance');
  assert.equal(payload.tools.length, 1);
  assert.match(payload.messages[0].content, /synthetic/i);
  assert.ok(payload.max_tokens <= 512);
  assert.match(result.limitations.join(' '), /not.*coding|not.*quality/i);
  const wrong = await probeLocalModel({catalogs,ref:'lmstudio/arbitrary-a',fetchImpl: async()=>new Response('data: {"choices":[{"delta":{"content":"42"},"finish_reason":"stop"}]}\n\n')});
  assert.equal(wrong.status, 'failed');
});

test('probe timeout is uncertain and never loads an unloaded model', async () => {
  const result = await probeLocalModel({catalogs,ref:'lmstudio/arbitrary-a',timeoutMs:15,fetchImpl:()=>new Promise(()=>{})});
  assert.equal(result.status, 'uncertain');
  await assert.rejects(probeLocalModel({catalogs:[{...catalogs[0],models:[{...model('a'),ready:false}]}],ref:'lmstudio/a',fetchImpl:()=>{throw Error('must not fetch');}}), /eligible|requirements|loaded/i);
});

test('coding probe checks a code correction rather than accepting a numeric extraction answer', async () => {
  const fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.tools[0].function.parameters.properties.replacement.type,'string');
    const frame={choices:[{delta:{tool_calls:[{index:0,id:'fix',function:{name:'submit_answer',arguments:JSON.stringify({replacement:'return a + b;'})}}]},finish_reason:'tool_calls'}]};
    return new Response(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const result=await probeLocalModel({catalogs,ref:'lmstudio/arbitrary-a',intent:'coding',fetchImpl});
  assert.equal(result.status,'passed');
});
