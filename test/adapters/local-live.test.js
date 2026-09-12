import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLocalLive} from '../../src/adapters/local-live.js';
import {createFakeBackend} from '../../src/adapters/backends/fake.js';
import {createLmStudioBackend} from '../../src/adapters/backends/lmstudio.js';
import {createOllamaBackend} from '../../src/adapters/backends/ollama.js';

// B1-B4 (CONTRACT.md section B): the local adapter owns its own tool loop over a pluggable
// backend. Every test here drives the `fake` backend (in-process, scripted) — never a real
// model, never LM Studio/Ollama, never the network.

const tmpDirs = [];
// One after-all sweep instead of a t.after at each of the many call sites: every setup() dir
// is removed when the file finishes, so a run leaves nothing under os.tmpdir().
after(() => { for (const dir of tmpDirs) fs.rmSync(dir, {recursive: true, force: true}); });
const setup = () => { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'local-live-')); tmpDirs.push(cwd); return cwd; };
const dirFor = cwd => path.join(cwd, '.task');

const drain = async (adapter, handle) => {
  const events = [];
  for await (const event of adapter.events(handle)) { events.push(event); if (event.kind === 'result') break; }
  return events;
};

test('B3 happy path: a read_file tool call is executed against cwd and the turn completes', async () => {
  const cwd = setup();
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello world');
  const script = [
    [{kind: 'tool_call', id: 't1', name: 'read_file', arguments: {path: 'README.md'}}],
    [{kind: 'delta', text: 'the file says hello'}, {kind: 'usage', usage: {input: 5, output: 3}}, {kind: 'done', text: 'the file says hello'}],
  ];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'read README', cwd, dir: dirFor(cwd)});
  const events = await drain(adapter, handle);
  const activity = events.filter(e => e.kind === 'activity').map(e => e.text);
  assert.equal(activity.some(text => text === 'the file says hello'), true);
  const usage = events.find(e => e.kind === 'usage');
  assert.deepEqual(usage.usage, {input: 5, output: 3});
  const result = events.at(-1);
  assert.equal(result.kind, 'result');
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'the file says hello');
  // the tool result must have reached the model as a tool-role message
  const toolMessage = handle.messages.find(m => m.role === 'tool');
  assert.equal(toolMessage.content, 'hello world');
});

test('B3 happy path: search finds a matching line under cwd', async () => {
  const cwd = setup();
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'const needle = 1;\nconst other = 2;\n');
  const script = [
    [{kind: 'tool_call', id: 't1', name: 'search', arguments: {query: 'needle'}}],
    [{kind: 'done', text: 'found it'}],
  ];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'find needle', cwd, dir: dirFor(cwd)});
  const events = await drain(adapter, handle);
  assert.equal(events.at(-1).status, 'completed');
  const toolMessage = handle.messages.find(m => m.role === 'tool');
  assert.equal(toolMessage.content.includes('src/a.js'), true);
  assert.equal(toolMessage.content.includes('needle'), true);
});

test('read_file tool refuses a path outside cwd without throwing', async () => {
  const cwd = setup();
  const script = [
    [{kind: 'tool_call', id: 't1', name: 'read_file', arguments: {path: '../outside.txt'}}],
    [{kind: 'done', text: 'done'}],
  ];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'x', cwd, dir: dirFor(cwd)});
  const events = await drain(adapter, handle);
  assert.equal(events.at(-1).status, 'completed');
  const toolMessage = handle.messages.find(m => m.role === 'tool');
  assert.equal(typeof toolMessage.content, 'string');
  assert.equal(toolMessage.content, 'error: path escapes the working directory');
});

test('read_file tool refuses an absolute-path escape without throwing', async () => {
  const cwd = setup();
  const script = [
    [{kind: 'tool_call', id: 't1', name: 'read_file', arguments: {path: '/etc/passwd'}}],
    [{kind: 'done', text: 'done'}],
  ];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'x', cwd, dir: dirFor(cwd)});
  const events = await drain(adapter, handle);
  assert.equal(events.at(-1).status, 'completed');
  const toolMessage = handle.messages.find(m => m.role === 'tool');
  assert.equal(toolMessage.content, 'error: path escapes the working directory');
});

// L1
test('L1 backend absent: an unknown profile.backend throws backend_unavailable', async () => {
  const cwd = setup();
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  await assert.rejects(
    adapter.launch({peer: {}, profile: {backend: 'nope', model: 'x', script: []}, orders: 'x', cwd, dir: dirFor(cwd)}),
    error => { assert.equal(error.code, 'backend_unavailable'); return true; },
  );
});

// L2
test('L2 health fails: a rejecting health() throws backend_unavailable', async () => {
  const cwd = setup();
  const adapter = createLocalLive({backends: {fake: createFakeBackend({healthy: false})}});
  await assert.rejects(
    adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script: []}, orders: 'x', cwd, dir: dirFor(cwd)}),
    error => { assert.equal(error.code, 'backend_unavailable'); return true; },
  );
});

// L3
test('L3 generation errors mid-stream: events end with result{status:"failed"}, no unhandled rejection', async () => {
  const cwd = setup();
  const script = [[{kind: 'delta', text: 'partial'}, {kind: 'throw', text: 'boom'}]];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'x', cwd, dir: dirFor(cwd)});
  const events = await drain(adapter, handle);
  assert.equal(events.at(-1).kind, 'result');
  assert.equal(events.at(-1).status, 'failed');
});

// L4
test('L4 cancellation: cancel aborts a never-ending generation and events end', async () => {
  const cwd = setup();
  let released;
  const gate = new Promise(resolve => { released = resolve; });
  const script = [[{kind: 'delta', text: 'first'}, {kind: 'wait', wait: () => gate}, {kind: 'delta', text: 'never'}]];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'x', cwd, dir: dirFor(cwd)});
  // wait for the first delta to land before cancelling, so we know the loop is truly mid-stream
  const iterator = adapter.events(handle);
  const first = await iterator.next();
  assert.equal(first.value.kind, 'activity');
  const cancelled = await adapter.cancel(handle);
  assert.deepEqual(cancelled, {verified: true});
  released();
  const next = await iterator.next();
  assert.equal(next.done, true);
});

// L5
test('L5 malformed tool call: an unknown tool name is fed back as an error, the turn still completes', async () => {
  const cwd = setup();
  const script = [
    [{kind: 'tool_call', id: 't1', name: 'delete_everything', arguments: {}}],
    [{kind: 'done', text: 'recovered'}],
  ];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'x', cwd, dir: dirFor(cwd)});
  const events = await drain(adapter, handle);
  const result = events.at(-1);
  assert.equal(result.kind, 'result');
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'recovered');
  const toolMessage = handle.messages.find(m => m.role === 'tool');
  assert.equal(toolMessage.content, 'error: unknown tool delete_everything');
  assert.equal(events.some(e => e.kind === 'activity' && e.text.startsWith('error:')), true);
});

test('deliver: text is coerced, oversize text is queued, tier is one of live/next-turn/queued', async () => {
  const cwd = setup();
  let released;
  const gate = new Promise(resolve => { released = resolve; });
  const script = [
    [{kind: 'tool_call', id: 't1', name: 'read_file', arguments: {path: 'README.md'}}],
    [{kind: 'wait', wait: () => gate}, {kind: 'done', text: 'ok'}],
  ];
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hi');
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'x', cwd, dir: dirFor(cwd)});
  const iterator = adapter.events(handle);
  // drive past the tool_call so the loop reaches the boundary and pauses on the gate
  await new Promise(resolve => setTimeout(resolve, 20));
  const tier = await adapter.deliver(handle, {text: 42});
  assert.equal(['live', 'next-turn', 'queued'].includes(tier), true);
  assert.equal(await adapter.deliver(handle, {text: 'x'.repeat(1_000_001)}), 'queued');
  released();
  const events = [];
  for await (const event of iterator) { events.push(event); if (event.kind === 'result') break; }
  assert.equal(events.at(-1).status, 'completed');
});

test('deliver at the tool boundary reaches the model live', async () => {
  const cwd = setup();
  let released;
  const gate = new Promise(resolve => { released = resolve; });
  const script = [
    [{kind: 'tool_call', id: 't1', name: 'read_file', arguments: {path: 'README.md'}}],
    [{kind: 'wait', wait: () => gate}, {kind: 'done', text: 'ok'}],
  ];
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hi');
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'x', cwd, dir: dirFor(cwd)});
  const iterator = adapter.events(handle);
  await new Promise(resolve => setTimeout(resolve, 20)); // let the loop reach the boundary and pause on the gate
  const tier = await adapter.deliver(handle, {text: 'inject me'});
  assert.equal(tier, 'live');
  assert.equal(handle.messages.some(m => m.role === 'user' && m.content === 'inject me'), true);
  released();
  for await (const event of iterator) { if (event.kind === 'result') break; }
});

test('cancel on an already-finished handle still resolves {verified:true}', async () => {
  const cwd = setup();
  const script = [[{kind: 'done', text: 'ok'}]];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script}, orders: 'x', cwd, dir: dirFor(cwd)});
  await drain(adapter, handle);
  assert.deepEqual(await adapter.cancel(handle), {verified: true});
});

test('concurrency 1: a second launch on the same adapter instance queues and runs after the first completes', async () => {
  const cwd = setup();
  let released;
  const gate = new Promise(resolve => { released = resolve; });
  const scriptA = [[{kind: 'wait', wait: () => gate}, {kind: 'done', text: 'a-done'}]];
  const scriptB = [[{kind: 'done', text: 'b-done'}]];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handleA = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script: scriptA}, orders: 'x', cwd, dir: dirFor(cwd)});
  const handleB = await adapter.launch({peer: {}, profile: {backend: 'fake', model: 'x', script: scriptB}, orders: 'x', cwd, dir: dirFor(cwd)});
  const bIterator = adapter.events(handleB);
  let bResolved = false;
  const bNext = bIterator.next().then(v => { bResolved = true; return v; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bResolved, false, 'B must not produce any event while A is still running');
  released();
  const aEvents = await drain(adapter, handleA);
  assert.equal(aEvents.at(-1).text, 'a-done');
  const bFirst = await bNext;
  assert.equal(bFirst.value.kind, 'result');
  assert.equal(bFirst.value.text, 'b-done');
});

test('capabilities reports the contract shape', () => {
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  assert.deepEqual(adapter.capabilities(), {live: true, resume: true, modelPin: true, policies: ['yolo'], quota: 'stream'});
});

test('resume resolves to a bare handle and completes like launch', async () => {
  const cwd = setup();
  const script = [[{kind: 'done', text: 'resumed-done'}]];
  const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
  const handle = await adapter.resume({native: {sessionId: 'none'}, message: 'continue', cwd, dir: dirFor(cwd), profile: {backend: 'fake', model: 'x', script}});
  const events = await drain(adapter, handle);
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(events.at(-1).text, 'resumed-done');
});

// B2 shape tests (CONTRACT.md §B2): "if a real backend's wire shape is uncertain, implement to
// the documented shape and cover it with the fake backend + a shape unit test; do NOT hit a
// live server." Both backends here are driven purely through an injected `fetchImpl` returning
// a canned Response — no network, no real LM Studio/Ollama process.
const bodyFromChunks = chunks => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
});

test('lmstudio backend: parses SSE deltas, an assembled tool_call, and usage from the documented OpenAI-compatible shape', async () => {
  const sse = [
    `data: ${JSON.stringify({choices: [{delta: {content: 'Hel'}}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {content: 'lo'}}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: 'call_1', function: {name: 'read_file', arguments: '{"path":'}}]}}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"a.txt"}'}}]}}]})}\n\n`,
    `data: ${JSON.stringify({usage: {prompt_tokens: 12, completion_tokens: 4}})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'tool_calls'}]})}\n\n`,
    'data: [DONE]\n\n',
  ];
  const fetchImpl = async () => ({ok: true, status: 200, body: bodyFromChunks(sse)});
  const backend = createLmStudioBackend({fetchImpl});
  const events = [];
  for await (const event of backend.generate({model: 'x', messages: [], tools: [], signal: undefined})) events.push(event);
  assert.deepEqual(events.filter(e => e.kind === 'delta').map(e => e.text), ['Hel', 'lo']);
  const toolCall = events.find(e => e.kind === 'tool_call');
  assert.equal(toolCall.name, 'read_file');
  assert.deepEqual(toolCall.arguments, {path: 'a.txt'});
  const usage = events.find(e => e.kind === 'usage');
  assert.deepEqual(usage.usage, {input: 12, output: 4});
});

test('lmstudio backend: health() reflects the /v1/models probe result', async () => {
  const ok = createLmStudioBackend({fetchImpl: async () => ({ok: true})});
  assert.equal(await ok.health(), true);
  const down = createLmStudioBackend({fetchImpl: async () => { throw new Error('ECONNREFUSED'); }});
  assert.equal(await down.health(), false);
});

test('ollama backend: parses streamed newline-delimited JSON deltas, a tool_call, and usage from the documented shape', async () => {
  const lines = [
    `${JSON.stringify({message: {content: 'Hel'}, done: false})}\n`,
    `${JSON.stringify({message: {content: 'lo'}, done: false})}\n`,
    `${JSON.stringify({message: {tool_calls: [{function: {name: 'search', arguments: {query: 'needle'}}}]}, done: false})}\n`,
    `${JSON.stringify({done: true, prompt_eval_count: 9, eval_count: 3})}\n`,
  ];
  const fetchImpl = async () => ({ok: true, status: 200, body: bodyFromChunks(lines)});
  const backend = createOllamaBackend({fetchImpl});
  const events = [];
  for await (const event of backend.generate({model: 'x', messages: [], tools: [], signal: undefined})) events.push(event);
  assert.deepEqual(events.filter(e => e.kind === 'delta').map(e => e.text), ['Hel', 'lo']);
  const toolCall = events.find(e => e.kind === 'tool_call');
  assert.equal(toolCall.name, 'search');
  assert.deepEqual(toolCall.arguments, {query: 'needle'});
  const usage = events.find(e => e.kind === 'usage');
  assert.deepEqual(usage.usage, {input: 9, output: 3});
  assert.equal(events.at(-1).kind, 'done');
});

test('ollama backend: health() reflects the /api/tags probe result', async () => {
  const ok = createOllamaBackend({fetchImpl: async () => ({ok: true})});
  assert.equal(await ok.health(), true);
  const down = createOllamaBackend({fetchImpl: async () => ({ok: false})});
  assert.equal(await down.health(), false);
});
