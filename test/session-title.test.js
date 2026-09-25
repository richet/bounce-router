// src/session-title.js: a model-given title for a session's first prompt, asked once and
// journaled as `session.titled`. The sanitizer, the operation (fake `ask`, no process/network),
// and the default `ask`'s model choice (fake fetch/fake runner, no real process or endpoint —
// the hermetic preload would refuse a real one anyway).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {sanitizeTitle, titleSession, createAsk} from '../src/session-title.js';

const tmpRoot = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A minimal fetch Response for LM Studio's /api/v1/models, readable once by local-models.js's
// streaming reader.
function modelsResponse(models) {
  const body = new TextEncoder().encode(JSON.stringify({models}));
  let done = false;
  return {
    ok: true, status: 200, headers: {get: () => null},
    body: {getReader: () => ({
      read: async () => { if (done) return {done: true, value: undefined}; done = true; return {done: false, value: body}; },
      cancel: async () => {},
    })},
  };
}

// ---- sanitizeTitle --------------------------------------------------------------------------

test('sanitizeTitle: strips a <think> block and takes the last non-empty line', () => {
  assert.equal(sanitizeTitle('<think>let me consider this carefully</think>\nCode review helper'), 'code-review-helper');
});

test('sanitizeTitle: strips surrounding quotes', () => {
  assert.equal(sanitizeTitle('"fix the bug"'), 'fix-the-bug');
});

test('sanitizeTitle: strips a leading label and caps at 5 words', () => {
  assert.equal(sanitizeTitle('Title: Fix the ACE review gate!'), 'fix-the-ace-review-gate');
});

test('sanitizeTitle: caps overlong answers to 5 words', () => {
  assert.equal(sanitizeTitle('this is a very long rambling title with too many words'), 'this-is-a-very-long');
});

// Found live (2026-09-25): the 40-char cap cut a real haiku answer mid-word ("…-blocked-worke").
test('sanitizeTitle: the length cap drops whole words, never cuts one', () => {
  assert.equal(sanitizeTitle('orchestrator dropped reply, blocked worker fix'), 'orchestrator-dropped-reply-blocked');
});

// A reasoning model cut off by its token budget leaves an unclosed <think>: that is no answer.
test('sanitizeTitle: an unclosed <think> block is not a title', () => {
  assert.equal(sanitizeTitle('<think>Here is a thinking process: 1. analyze the user'), null);
});

test('sanitizeTitle: empty answer is skipped', () => {
  assert.equal(sanitizeTitle(''), null);
  assert.equal(sanitizeTitle('   '), null);
});

test('sanitizeTitle: a single-letter answer is skipped', () => {
  assert.equal(sanitizeTitle('a'), null);
  assert.equal(sanitizeTitle('"x"'), null);
});

// ---- titleSession -----------------------------------------------------------------------------

test('titleSession: journals session.titled with the exact name and model from a fake ask', async t => {
  const root = tmpRoot('bounce-title-'), cwd = tmpRoot('bounce-title-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const session = new Session(cwd, {root});
  session.append({kind: 'user', text: 'Help me fix the flaky login test'});
  const ask = async ({prompt}) => { assert.match(prompt, /Help me fix the flaky login test/); return {text: 'Fix Flaky Login Test', model: 'lmstudio/qwen3-coder'}; };
  const row = await titleSession({session, settings: {}, ask, root});
  assert.equal(row.kind, 'session.titled');
  assert.equal(row.name, 'fix-flaky-login-test');
  assert.equal(row.source, 'model');
  assert.equal(row.model, 'lmstudio/qwen3-coder');
  assert.ok(session.events.some(e => e.kind === 'session.titled' && e.name === 'fix-flaky-login-test'));
});

test('titleSession: skips when session.renamed already exists', async t => {
  const root = tmpRoot('bounce-title-'), cwd = tmpRoot('bounce-title-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const session = new Session(cwd, {root});
  session.append({kind: 'user', text: 'first prompt'});
  session.append({kind: 'session.renamed', name: 'Billing'});
  let called = false;
  const ask = async () => { called = true; return {text: 'whatever'}; };
  const row = await titleSession({session, settings: {}, ask, root});
  assert.equal(row, null);
  assert.equal(called, false, 'ask must never be called once a session is already named');
});

test('titleSession: skips when already titled (runs once per session)', async t => {
  const root = tmpRoot('bounce-title-'), cwd = tmpRoot('bounce-title-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const session = new Session(cwd, {root});
  session.append({kind: 'user', text: 'first prompt'});
  session.append({kind: 'session.titled', name: 'earlier-title', source: 'model', model: 'claude/haiku'});
  let called = false;
  const ask = async () => { called = true; return {text: 'whatever'}; };
  const row = await titleSession({session, settings: {}, ask, root});
  assert.equal(row, null);
  assert.equal(called, false);
});

test('titleSession: skips with no user row yet', async t => {
  const root = tmpRoot('bounce-title-'), cwd = tmpRoot('bounce-title-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const session = new Session(cwd, {root});
  const ask = async () => ({text: 'whatever'});
  const row = await titleSession({session, settings: {}, ask, root});
  assert.equal(row, null);
});

test('titleSession: a collision with another session\'s name gets -2, -3…', async t => {
  const root = tmpRoot('bounce-title-'), cwd = tmpRoot('bounce-title-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const taken = new Session(cwd, {root});
  taken.append({kind: 'user', text: 'first'});
  taken.append({kind: 'session.renamed', name: 'fix-the-bug'});
  const takenAgain = new Session(cwd, {root});
  takenAgain.append({kind: 'user', text: 'second'});
  takenAgain.append({kind: 'session.titled', name: 'fix-the-bug-2', source: 'model', model: 'x'});
  const session = new Session(cwd, {root});
  session.append({kind: 'user', text: 'third'});
  const ask = async () => ({text: 'Fix The Bug', model: 'x'});
  const row = await titleSession({session, settings: {}, ask, root});
  assert.equal(row.name, 'fix-the-bug-3');
});

test('titleSession: ask throwing leaves no row, no user-visible journal entry', async t => {
  const root = tmpRoot('bounce-title-'), cwd = tmpRoot('bounce-title-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const session = new Session(cwd, {root});
  session.append({kind: 'user', text: 'first prompt'});
  const before = session.events.length;
  const ask = async () => { throw new Error('endpoint unreachable'); };
  const row = await titleSession({session, settings: {}, ask, root});
  assert.equal(row, null);
  assert.equal(session.events.length, before, 'a failed ask must not add any row');
});

test('titleSession: an unsanitizable answer is skipped, no row added', async t => {
  const root = tmpRoot('bounce-title-'), cwd = tmpRoot('bounce-title-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const session = new Session(cwd, {root});
  session.append({kind: 'user', text: 'first prompt'});
  const before = session.events.length;
  const ask = async () => ({text: ''});
  const row = await titleSession({session, settings: {}, ask, root});
  assert.equal(row, null);
  assert.equal(session.events.length, before);
});

// ---- precedence (reducers.sessionName / sessions.js) -----------------------------------------

test('sessionName precedence: rename > titled > first-prompt text', async () => {
  const {sessionName} = await import('../src/reducers.js');
  const base = [{kind: 'user', text: 'original first prompt'}];
  assert.equal(sessionName(base), 'original first prompt');
  const titled = [...base, {kind: 'session.titled', name: 'model-given-title', source: 'model', model: 'x'}];
  assert.equal(sessionName(titled), 'model-given-title');
  const renamed = [...titled, {kind: 'session.renamed', name: 'Manual Rename'}];
  assert.equal(sessionName(renamed), 'Manual Rename');
});

test('resolveSessionRef: a titled session resolves by its titled name', async t => {
  const {Session: S} = await import('../src/core.js');
  const {resolveSessionRef} = await import('../src/sessions.js');
  const root = tmpRoot('bounce-title-'), cwd = tmpRoot('bounce-title-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const session = new S(cwd, {root});
  session.append({kind: 'user', text: 'first prompt'});
  session.append({kind: 'session.titled', name: 'model-given-title', source: 'model', model: 'x'});
  assert.equal(resolveSessionRef(root, 'model-given-title'), session.id);
});

// ---- default ask: local (loaded model only) vs cloud -------------------------------------

test('createAsk: prefers a loaded local model over cloud, never a not-loaded one', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/v1/models')) {
      return modelsResponse([
        {key: 'qwen3-coder', type: 'llm', loaded_instances: [{id: 'qwen3-coder', config: {context_length: 8192}}]},
        {key: 'not-loaded-model', type: 'llm', loaded_instances: []},
      ]);
    }
    if (String(url).includes('/v1/chat/completions')) {
      return {ok: true, json: async () => ({choices: [{message: {content: 'Fix The Login Bug'}}]})};
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const run = async () => { throw new Error('the cloud path must not run when a local model is loaded'); };
  const ask = createAsk({fetchImpl, run});
  const answer = await ask({prompt: 'title me', settings: {local: {enabled: true}}});
  assert.equal(answer.text, 'Fix The Login Bug');
  assert.equal(answer.model, 'lmstudio/qwen3-coder');
  assert.ok(calls.some(u => u.includes('qwen3-coder') === false || u.includes('chat/completions')), 'the chat call must target the loaded model');
});

// Found live (2026-09-25): the loaded qwen3.6 spent all 256 tokens reasoning (content "", finish
// length) and titling silently fell to the cloud; with room it answered after 1.5k-2.9k reasoning tokens.
test('createAsk: a local reasoning model gets room to finish thinking, and an empty answer falls to the cloud', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/api/v1/models')) return modelsResponse([{key: 'qwen3.6', type: 'llm', loaded_instances: [{id: 'qwen3.6', config: {context_length: 8192}}]}]);
    bodies.push(JSON.parse(init.body));
    return {ok: true, json: async () => ({choices: [{finish_reason: 'length', message: {content: '', reasoning_content: 'Here is a thinking process'}}]})};
  };
  let cloud = 0;
  const run = async ({emit}) => { cloud++; emit({kind: 'result', success: true, text: 'fix the reply queue'}); return {status: 'completed'}; };
  const answer = await createAsk({fetchImpl, run})({prompt: 'title me', settings: {local: {enabled: true}, order: ['claude'], profiles: {}}});
  assert.equal(bodies[0].max_tokens, 4096);
  assert.equal(cloud, 1);
  assert.equal(answer.text, 'fix the reply queue');
});

// Found live (2026-09-25): a daemon with no local setup probed LM Studio's default port to title its
// session. Local models are used once they are set up (/local setup writes settings.local), never before.
test('createAsk: with no local setup it never probes a local endpoint and goes to the cloud', async () => {
  const probed = [];
  const fetchImpl = async url => { probed.push(String(url)); throw new Error('refused'); };
  const run = async ({emit}) => { emit({kind: 'result', success: true, text: 'cloud title'}); return {status: 'completed'}; };
  const answer = await createAsk({fetchImpl, run})({prompt: 'title me', settings: {order: ['claude'], profiles: {}}});
  assert.deepEqual(probed, []);
  assert.equal(answer.text, 'cloud title');
  assert.equal(answer.model, 'claude/haiku');
});

// Found by the gate (2026-09-25): a title request's CLI runs in its own process group and outlived the
// daemon that asked for it (two orphaned fake CLIs after the suite). It dies with its owner.
test('createAsk: a cloud title request in flight is cancelled when its owner exits', async () => {
  let exiting;
  const onExit = fn => { exiting = fn; return () => { exiting = null; }; };
  let aborted = false;
  const run = ({signal}) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({status: 'cancelled'}); }));
  const pending = createAsk({run, onExit})({prompt: 'title me', settings: {order: ['claude'], profiles: {}}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof exiting, 'function');
  exiting();
  assert.equal(aborted, true);
  assert.equal(await pending, null);
  assert.equal(exiting, null, 'the exit hook is removed once the request settles');
});

test('createAsk: falls back to the cloud path when no local model is loaded', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/v1/models')) return modelsResponse([{key: 'not-loaded-model', type: 'llm', loaded_instances: []}]);
    throw new Error(`unexpected fetch ${url} — local must never be asked to load a model`);
  };
  const run = async ({provider, args, emit}) => {
    assert.equal(provider, 'claude');
    emit({kind: 'result', text: 'session-title-here', success: true});
    return {status: 'completed', code: 0};
  };
  const ask = createAsk({fetchImpl, run});
  const answer = await ask({prompt: 'title me', settings: {local: {enabled: true}, order: ['claude'], profiles: {}, models: {}}});
  assert.equal(answer.text, 'session-title-here');
  assert.equal(answer.model, 'claude/haiku');
});

test('createAsk: no local settings and no cloud provider answers null', async () => {
  const ask = createAsk({fetchImpl: async () => { throw new Error('must not fetch'); }, run: async () => { throw new Error('must not run'); }});
  const answer = await ask({prompt: 'title me', settings: {order: [], profiles: {}}});
  assert.equal(answer, null);
});

// ---- the daemon trigger: main-service.js start() and core.js Router.run() ------------------

test('createMainService: onFirstUserPrompt fires once for a new session\'s first prompt, not again on a second prompt', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-title-hook-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const {Session: S} = await import('../src/core.js');
  const {createMainService} = await import('../src/main-service.js');
  const session = new S(root, {root});
  const calls = [], pending = [];
  const adapter = {
    async launch() { return {turnId: 't1'}; },
    async resume() { return {turnId: 't2'}; },
    async *events() { yield {kind: 'native', provider: 'codex', sessionId: 'x'}; yield await new Promise(resolve => pending.push(resolve)); },
    async deliver() { return 'live'; },
    async cancel() { pending.shift()?.({kind: 'result', status: 'interrupted'}); return {verified: true}; },
  };
  const main = createMainService({session, adapters: {codex: adapter}, profile: {adapter: 'codex', mode: 'plan'}, settings: {executables: {}}, brief: 'Orders',
    onFirstUserPrompt: (s, cfg) => calls.push({sessionId: s.id, cfg})});
  t.after(() => main.close());
  main.run({text: 'first prompt'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, session.id);
  main.run({text: 'second prompt'});
  assert.equal(calls.length, 1, 'the hook must fire once per session, never again on a later prompt');
});

test('createMainService: onFirstUserPrompt does not fire for a resumed session that already has a user row', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-title-hook-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const {Session: S} = await import('../src/core.js');
  const {createMainService} = await import('../src/main-service.js');
  const session = new S(root, {root});
  session.append({kind: 'user', text: 'an earlier prompt from a previous run'});
  const calls = [], pending = [];
  const adapter = {
    async launch() { return {turnId: 't1'}; },
    async resume() { return {turnId: 't2'}; },
    async *events() { yield {kind: 'native', provider: 'codex', sessionId: 'x'}; yield await new Promise(resolve => pending.push(resolve)); },
    async deliver() { return 'live'; },
    async cancel() { pending.shift()?.({kind: 'result', status: 'interrupted'}); return {verified: true}; },
  };
  const main = createMainService({session, adapters: {codex: adapter}, profile: {adapter: 'codex', mode: 'plan'}, settings: {executables: {}}, brief: 'Orders',
    onFirstUserPrompt: () => calls.push(1)});
  t.after(() => main.close());
  main.run({text: 'a resumed prompt'});
  assert.equal(calls.length, 0, 'a resumed session already has a user row; onFirstUserPrompt must not fire for it');
});

test('Router.run: onFirstUserPrompt fires once for a new session, not on a second turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-title-hook-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-title-hook-cwd-'));
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const {Session: S, Router} = await import('../src/core.js');
  const session = new S(cwd, {root});
  const settings = {order: ['claude'], mode: 'yolo', models: {}, cooldownMinutes: 30, contextChars: 4000, executables: {}};
  const calls = [];
  const runner = async ({emit}) => { emit({kind: 'result', text: 'ok', success: true}); return {status: 'completed', code: 0}; };
  const router = new Router(session, settings, {runner, onFirstUserPrompt: s => calls.push(s.id)});
  await router.run('first prompt');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], session.id);
  await router.run('second prompt');
  assert.equal(calls.length, 1, 'the hook must fire once per session');
});
