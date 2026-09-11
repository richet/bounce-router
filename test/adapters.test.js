import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {providers, invocation, normalize, runProcess} from '../src/providers.js';
import {catalogQueries} from '../src/models.js';
import {adapters} from '../src/adapters/index.js';

// Pinned from src/providers.js before the adapter extraction (today's behavior).
const oldLogin = {claude: ['auth', 'login'], codex: ['login'], muse: ['login']};
const oldInvocation = {
  claude: {
    yolo: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
    plan: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan'],
  },
  codex: {
    yolo: ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-'],
    plan: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-'],
  },
  muse: {
    yolo: ['exec', '--json', '--prompt-file', '/tmp/prompt', '--yolo'],
    plan: ['exec', '--json', '--prompt-file', '/tmp/prompt', '--disable-write', '--disable-shell', '--approval-mode', 'never'],
  },
};
// Pinned from `git show main:src/providers.js` — the model+images variant (yolo mode).
const oldInvocationModelImages = {
  claude: ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'm1', '--input-format', 'stream-json', '--dangerously-skip-permissions'],
  codex: ['exec', '--json', '--skip-git-repo-check', '--model', 'm1', '--image', '/img/a.png', '--image', '/img/b.png', '--dangerously-bypass-approvals-and-sandbox', '-'],
  muse: ['exec', '--json', '--prompt-file', '/tmp/prompt', '--model', 'm1', '--image', '/img/a.png', '--image', '/img/b.png', '--yolo'],
};

test('providers registry is a derived view with unchanged login arrays', () => {
  for (const name of ['claude', 'codex', 'muse']) assert.deepEqual(providers[name].login, oldLogin[name]);
});

test('invocation output is unchanged for yolo and plan modes', () => {
  assert.deepEqual(invocation('claude', {mode: 'yolo'}), oldInvocation.claude.yolo);
  assert.deepEqual(invocation('claude', {mode: 'plan'}), oldInvocation.claude.plan);
  assert.deepEqual(invocation('codex', {mode: 'yolo'}), oldInvocation.codex.yolo);
  assert.deepEqual(invocation('codex', {mode: 'plan'}), oldInvocation.codex.plan);
  assert.deepEqual(invocation('muse', {mode: 'yolo'}, '/tmp/prompt'), oldInvocation.muse.yolo);
  assert.deepEqual(invocation('muse', {mode: 'plan'}, '/tmp/prompt'), oldInvocation.muse.plan);
});

test('invocation output is unchanged for the model+images variant', () => {
  const images = [{path: '/img/a.png'}, {path: '/img/b.png'}];
  assert.deepEqual(invocation('claude', {mode: 'yolo', model: 'm1', images}), oldInvocationModelImages.claude);
  assert.deepEqual(invocation('codex', {mode: 'yolo', model: 'm1', images}), oldInvocationModelImages.codex);
  assert.deepEqual(invocation('muse', {mode: 'yolo', model: 'm1', images}, '/tmp/prompt'), oldInvocationModelImages.muse);
});

test('invocation throws Unknown provider for an unknown name', () => {
  assert.throws(() => invocation('other', {mode: 'yolo'}), /Unknown provider: other/);
});

test('normalize throws Unknown provider for an unknown name', () => {
  assert.throws(() => normalize('other', {}), /Unknown provider: other/);
});

test('adapter.stdin: claude and codex echo the prompt, muse returns undefined', () => {
  assert.equal(adapters.claude.stdin('x'), 'x');
  assert.equal(adapters.codex.stdin('x'), 'x');
  assert.equal(adapters.muse.stdin('x'), undefined);
});

test('runProcess: muse gets no stdin, claude and codex get the prompt', async () => {
  // Read stdin fully; report whether any bytes arrived, as a single JSON result line
  // that each provider's normalize() branch turns into a `result` event.
  const src = provider => `let data=''; process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => { ${provider === 'claude'
      ? "console.log(JSON.stringify({type:'result',is_error:false,result:data.length>0?'had-stdin':'no-stdin'}))"
      : "console.log(JSON.stringify({type:'turn.completed',usage:{}})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:data.length>0?'had-stdin':'no-stdin'}}))"} });`;
  const run = async provider => {
    const events = [];
    await runProcess({provider, executable: process.execPath, args: ['-e', src(provider)], prompt: 'hello', cwd: os.tmpdir(), emit: e => events.push(e)});
    return events;
  };
  const claudeEvents = await run('claude');
  assert.equal(claudeEvents.find(e => e.kind === 'result').text, 'had-stdin');
  const codexEvents = await run('codex');
  assert.equal(codexEvents.find(e => e.kind === 'assistant').text, 'had-stdin');
  // muse ignores stdin entirely (prompt travels via --prompt-file), so its process
  // sees end-of-stream immediately with zero bytes.
  const museSrc = `let data=''; process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => console.log(JSON.stringify({payload_type:'run.terminal.completed', payload:{terminal:'completed', text: data.length>0?'had-stdin':'no-stdin'}})));`;
  const museEvents = [];
  await runProcess({provider: 'muse', executable: process.execPath, args: ['-e', museSrc], prompt: 'hello', cwd: os.tmpdir(), emit: e => museEvents.push(e)});
  assert.equal(museEvents.find(e => e.kind === 'result').text, 'no-stdin');
});

test('normalize emits peer.native with the exact sessionId, and none when absent', () => {
  const claudeWith = normalize('claude', {type: 'system', subtype: 'init', session_id: 'sess-claude-1'});
  assert.deepEqual(claudeWith.find(e => e.kind === 'peer.native'), {kind: 'peer.native', provider: 'claude', sessionId: 'sess-claude-1'});
  const claudeWithout = normalize('claude', {type: 'system', subtype: 'init'});
  assert.equal(claudeWithout.some(e => e.kind === 'peer.native'), false);

  const codexWith = normalize('codex', {type: 'session.started', thread_id: 'thread-codex-1'});
  assert.deepEqual(codexWith.find(e => e.kind === 'peer.native'), {kind: 'peer.native', provider: 'codex', sessionId: 'thread-codex-1'});
  const codexWithout = normalize('codex', {type: 'session.started'});
  assert.equal(codexWithout.some(e => e.kind === 'peer.native'), false);
  // Unrelated JSON-RPC-shaped raw.id must never leak into peer.native.
  const codexUnrelated = normalize('codex', {id: 42, result: {}});
  assert.equal(codexUnrelated.some(e => e.kind === 'peer.native'), false);

  const museWith = normalize('muse', {payload_type: 'run.started', payload: {session_id: 'sess-muse-1'}});
  assert.deepEqual(museWith.find(e => e.kind === 'peer.native'), {kind: 'peer.native', provider: 'muse', sessionId: 'sess-muse-1'});
  const museWithout = normalize('muse', {payload_type: 'run.started', payload: {}});
  assert.equal(museWithout.some(e => e.kind === 'peer.native'), false);
});

test('peer.native is emitted at most once per raw line, after all other events', () => {
  const events = normalize('claude', {type: 'result', is_error: false, result: 'done', session_id: 'sess-claude-2'});
  assert.equal(events.filter(e => e.kind === 'peer.native').length, 1);
  assert.equal(events.at(-1).kind, 'peer.native');
});

test('existing fixtures with no ids still normalize to no peer.native events', () => {
  assert.deepEqual(normalize('claude', {type: 'assistant', message: {content: [{type: 'text', text: 'hello'}]}})
    .filter(e => e.kind === 'peer.native'), []);
  assert.deepEqual(normalize('codex', {type: 'turn.completed', usage: {input_tokens: 42}})
    .filter(e => e.kind === 'peer.native'), []);
  assert.deepEqual(normalize('muse', {payload_type: 'run.output.delta', payload: {text: 'hello'}})
    .filter(e => e.kind === 'peer.native'), []);
});

// F1 regression: claude sends session_id on EVERY message and muse carries run_id on
// every streamed delta. Emitting peer.native there would journal one row per token/line.
test('peer.native is never emitted from high-frequency lines, even when they carry an id', () => {
  assert.deepEqual(normalize('claude', {type: 'assistant', session_id: 'sess-claude-3',
    message: {content: [{type: 'text', text: 'hello'}]}}).filter(e => e.kind === 'peer.native'), []);
  assert.deepEqual(normalize('claude', {type: 'user', session_id: 'sess-claude-3',
    message: {content: [{type: 'tool_result', content: [{type: 'text', text: 'ok'}]}]}}).filter(e => e.kind === 'peer.native'), []);
  assert.deepEqual(normalize('muse', {payload_type: 'run.output.delta', payload: {text: 'hi', run_id: 'r1'}})
    .filter(e => e.kind === 'peer.native'), []);
});

test('peer.native is emitted exactly once on each allowed lifecycle line, per provider', () => {
  assert.equal(normalize('claude', {type: 'system', subtype: 'init', session_id: 'sess-claude-4'})
    .filter(e => e.kind === 'peer.native').length, 1);
  assert.equal(normalize('claude', {type: 'result', is_error: false, result: 'done', session_id: 'sess-claude-4'})
    .filter(e => e.kind === 'peer.native').length, 1);
  assert.equal(normalize('codex', {type: 'session.started', thread_id: 'thread-codex-2'})
    .filter(e => e.kind === 'peer.native').length, 1);
  assert.equal(normalize('muse', {payload_type: 'run.started', payload: {session_id: 'sess-muse-2'}})
    .filter(e => e.kind === 'peer.native').length, 1);
  assert.equal(normalize('muse', {payload_type: 'run.model.configured', payload: {model_id: 'muse-spark', run_id: 'r2'}})
    .filter(e => e.kind === 'peer.native').length, 1);
  assert.equal(normalize('muse', {payload_type: 'run.terminal.completed', payload: {terminal: 'completed', run_id: 'r3'}})
    .filter(e => e.kind === 'peer.native').length, 1);
});

// Exact repro command from the review: a muse delta line must normalize to only the delta.
test('muse run.output.delta with a run_id normalizes to only the delta event', () => {
  assert.deepEqual(normalize('muse', {payload_type: 'run.output.delta', payload: {text: 'hi', run_id: 'r1'}}),
    [{kind: 'delta', text: 'hi'}]);
});

test('catalogQueries.codex.args is unchanged', () => {
  assert.deepEqual(catalogQueries.codex.args, ['app-server']);
});
