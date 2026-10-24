// opencode 2.x answers stream to classic (docs/plans/interactive-polish.md step 3): `opencode run` prints a text part
// only once it is whole, but its server's event stream carries the text and the thinking as they are written.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerRows, readEventStream} from '../src/opencode-server.js';

const event = (type, data) => ({type, data: {sessionID: 's', assistantMessageID: 'm', ordinal: 0, ...data}});

test('server events become deltas, a thinking counter and the finished text', () => {
  const rows = createServerRows();
  assert.deepEqual(rows(event('session.reasoning.delta', {delta: 'x'.repeat(100)})), [{kind: 'progress', text: 'Thinking · ~25 tokens'}]);
  assert.deepEqual(rows(event('session.reasoning.delta', {delta: 'x'.repeat(40)})), [], 'the counter moves every ~25 tokens, not on every fragment');
  assert.deepEqual(rows(event('session.reasoning.delta', {delta: 'x'.repeat(60)})), [{kind: 'progress', text: 'Thinking · ~50 tokens'}]);
  assert.deepEqual(rows(event('session.text.delta', {delta: 'A hash map'})), [{kind: 'delta', text: 'A hash map'}]);
  assert.deepEqual(rows(event('session.text.ended', {text: 'A hash map stores pairs.'})), [{kind: 'assistant', text: 'A hash map stores pairs.'}]);
  assert.deepEqual(rows(event('session.usage.updated', {})), []);
});

test('readEventStream parses server-sent events across chunk boundaries', async () => {
  const encoder = new TextEncoder();
  const chunks = ['data: {"type":"a","data":{}}\n\ndata: {"ty', 'pe":"b","data":{"x":1}}\n\n', ': keep-alive\n\n'];
  const body = new ReadableStream({start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); }});
  const seen = [];
  await readEventStream(body, value => seen.push(value));
  assert.deepEqual(seen, [{type: 'a', data: {}}, {type: 'b', data: {x: 1}}]);
});

// Found in the real-console pass 2026-10-21: `run --server` prints no step_finish, so a classic 2.x turn's footer had
// no tokens. The server's step.ended carries them, in step_finish's shape.
test('a finished step on the server becomes the turn\'s usage, with its thinking beside it', () => {
  const rows = createServerRows();
  assert.deepEqual(rows(event('session.step.ended', {finish: 'stop', tokens: {input: 1419, output: 83, reasoning: 1016, cache: {read: 0, write: 0}}})),
    [{kind: 'usage', text: '{"input":1419,"cache_read":0,"cache_write":0,"output":83}', usage: {input: 1419, cache_read: 0, cache_write: 0, output: 83}, thinking: 1016}]);
  assert.deepEqual(rows(event('session.step.ended', {finish: 'stop'})), [], 'a step with no tokens reports nothing');
});
