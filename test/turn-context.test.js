// The turn footer's context and thinking, and the token counting under it:
// each vendor's numbers mean different things, and the footer, /stats and the sidebar must read them the same way.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsage} from '../src/reducers.js';
import {normalize} from '../src/providers.js';
import {tokenUsageRow} from '../src/adapters/codex-live.js';
import {conversationEvents} from '../src/tui/transcript.js';

test('codex counts its cached input inside its input; claude does not: both normalize to uncached input plus cache', () => {
  // Measured 2026-10-21, codex 0.162: inputTokens 15085 of which cachedInputTokens 12288.
  assert.deepEqual(normalizeUsage({input_tokens: 15085, cached_input_tokens: 12288, output_tokens: 5}), {input: 2797, cache_read: 12288, output: 5});
  // claude 2.1.291: input_tokens excludes the cache it reports beside it.
  assert.deepEqual(normalizeUsage({input_tokens: 2, cache_read_input_tokens: 12592, cache_creation_input_tokens: 13854, output_tokens: 4}), {input: 2, cache_read: 12592, cache_write: 13854, output: 4});
  assert.deepEqual(normalizeUsage({input: 10, cache_read: 5, output: 1}), {input: 10, cache_read: 5, output: 1}, 'already canonical rows are left alone');
});

test('codex app-server token usage becomes a usage row with the context its last call filled and its thinking', () => {
  const params = {tokenUsage: {last: {totalTokens: 15090, inputTokens: 15085, cachedInputTokens: 12288, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 300}, modelContextWindow: 475000}};
  assert.deepEqual(tokenUsageRow(params), {kind: 'usage', usage: {input: 2797, cache_read: 12288, cache_write: 0, output: 5}, thinking: 300, context: {used: 15090, window: 475000}});
});

test('a claude turn reports the context its last request filled, its window, and its thinking', () => {
  const session = 'sess-context';
  normalize('claude', {type: 'assistant', session_id: session, message: {content: [], usage: {input_tokens: 1, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500, output_tokens: 40}}});
  normalize('claude', {type: 'assistant', session_id: session, message: {content: [], usage: {input_tokens: 3, cache_read_input_tokens: 21000, cache_creation_input_tokens: 100, output_tokens: 60}}});
  const rows = normalize('claude', {type: 'result', session_id: session, subtype: 'success', result: 'ok', is_error: false,
    usage: {input_tokens: 4, cache_read_input_tokens: 41000, cache_creation_input_tokens: 600, output_tokens: 100, output_tokens_details: {thinking_tokens: 1200}},
    modelUsage: {'claude-sonnet-5-5': {contextWindow: 1000000, thinkingTokens: 1200}}});
  const usage = rows.find(row => row.kind === 'usage');
  assert.deepEqual(usage.context, {used: 21163, window: 1000000}, 'the last request: 3 + 21000 + 100 + 60, not the turn\'s sum');
  assert.equal(usage.usage.output_tokens_details.thinking_tokens, 1200);
});

test('the footer adds the thinking and the share of the context window the conversation now fills', () => {
  const events = [
    {kind: 'user', id: 'u1', text: 'hi', time: '2026-10-21T10:00:00.000Z'},
    {kind: 'usage', id: 'g1', usage: {input_tokens: 4, cache_read_input_tokens: 41000, cache_creation_input_tokens: 600, output_tokens: 100, output_tokens_details: {thinking_tokens: 1200}}, context: {used: 21163, window: 1000000}},
    {kind: 'turn', id: 't1', text: 'completed', time: '2026-10-21T10:00:05.000Z'},
    {kind: 'user', id: 'u2', text: 'again', time: '2026-10-21T10:01:00.000Z'},
    {kind: 'usage', id: 'g2', usage: {input: 2797, cache_read: 12288, output: 5}, thinking: 300, context: {used: 15090, window: 475000}},
    {kind: 'usage', id: 'g3', usage: {input: 100, cache_read: 15000, output: 20}, thinking: 50, context: {used: 237500, window: 475000}},
    {kind: 'turn', id: 't2', text: 'completed', time: '2026-10-21T10:01:02.000Z'},
  ];
  assert.deepEqual(conversationEvents(events).filter(e => e.kind === 'turn.footer').map(e => e.text), [
    '5.0 s · in 41.6k (41.0k cached) · out 100 · thought 1.2k · context 2%',
    '2.0 s · in 30.2k (27.3k cached) · out 25 · thought 350 · context 50%',
  ]);
});

test('an opencode step reports its thinking beside its tokens', () => {
  const rows = normalize('opencode', {type: 'step_finish', sessionID: 'ses_think', part: {tokens: {input: 900, output: 40, reasoning: 350, cache: {read: 100, write: 0}}}});
  const usage = rows.find(row => row.kind === 'usage');
  assert.deepEqual([usage.usage, usage.thinking], [{input: 900, cache_read: 100, cache_write: 0, output: 40}, 350]);
});
