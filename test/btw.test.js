// src/btw.js: /btw forks a one-shot, read-only side answer — never a turn, never delivered into
// the running one, never fed back into the orchestrator's own context. See CLAUDE.md/WORKFLOW.md
// "observe the repro fail before fixing" — this suite is written and run red before src/btw.js
// existed; see the task's final report for the failing lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Session, handoff} from '../src/core.js';
import {askBtw, buildBtwContext, resolveBtwAgent, createBtwAsk, BTW_CONTEXT_CHARS} from '../src/btw.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliSource = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');

function tmpSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-btw-'));
  return new Session(root, {root});
}

// ---- buildBtwContext -------------------------------------------------------------------------

test('buildBtwContext: classic mode carries recent user/assistant/main.terminal text only', () => {
  const events = [
    {kind: 'user', text: 'fix the flaky login test'},
    {kind: 'assistant', text: 'looked at it, the retry loop was the bug'},
    {kind: 'state', text: 'orchestrator note that must not leak into classic mode'},
    {kind: 'tool', text: 'grep -n retry'}, // not a conversation kind — excluded
  ];
  const context = buildBtwContext(events, {orchestrating: false});
  assert.match(context, /fix the flaky login test/);
  assert.match(context, /the retry loop was the bug/);
  assert.doesNotMatch(context, /orchestrator note that must not leak/);
  assert.doesNotMatch(context, /grep -n retry/);
});

test('buildBtwContext: orchestrator mode adds the latest state note and a compact task list', () => {
  const events = [
    {kind: 'user', text: 'why is the campaign stuck'},
    {kind: 'state', text: 'first note'},
    {kind: 'state', text: 'campaign is waiting on the build task'},
    {kind: 'task.submitted', task: 'build-1111', context: 'c', parent: null, profile: 'build', deadline: null},
    {kind: 'task.started', task: 'build-1111', attempt: 1},
  ];
  const context = buildBtwContext(events, {orchestrating: true});
  assert.match(context, /campaign is waiting on the build task/);
  assert.doesNotMatch(context, /first note/, 'only the latest state note is carried');
  assert.match(context, /build-11/);
  assert.match(context, /build/);
});

test('buildBtwContext: caps at ~24k chars, keeping the newest content', () => {
  const events = Array.from({length: 400}, (_, i) => ({kind: 'user', text: `line ${i} ${'x'.repeat(80)}`}));
  const context = buildBtwContext(events, {orchestrating: false});
  assert.ok(context.length <= BTW_CONTEXT_CHARS);
  assert.match(context, /line 399/, 'the newest line survives the cap');
  assert.doesNotMatch(context, /line 0 /, 'the oldest line is trimmed first');
});

// ---- resolveBtwAgent --------------------------------------------------------------------------

test('resolveBtwAgent: orchestrator mode uses the orchestrator profile\'s adapter/model', () => {
  const orchestration = {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'codex', model: 'gpt-5.6-sol'}}};
  const agent = resolveBtwAgent({settings: {models: {}}, orchestration, session: {active: 'claude'}});
  assert.deepEqual(agent, {adapter: 'codex', model: 'gpt-5.6-sol'});
});

test('resolveBtwAgent: orchestrator mode falls back to settings.models when the profile has none', () => {
  const orchestration = {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'codex'}}};
  const agent = resolveBtwAgent({settings: {models: {codex: 'gpt-5.6-terra'}}, orchestration, session: {}});
  assert.deepEqual(agent, {adapter: 'codex', model: 'gpt-5.6-terra'});
});

test('resolveBtwAgent: classic mode uses the session\'s active provider', () => {
  const orchestration = {operation: 'classic'};
  const agent = resolveBtwAgent({settings: {order: ['claude'], models: {claude: 'sonnet'}}, orchestration, session: {active: 'claude'}});
  assert.deepEqual(agent, {adapter: 'claude', model: 'sonnet'});
});

test('resolveBtwAgent: classic mode falls back to the fallback order before any turn has run', () => {
  const orchestration = {operation: 'classic'};
  const agent = resolveBtwAgent({settings: {order: ['codex'], models: {}}, orchestration, session: {active: null}});
  assert.deepEqual(agent, {adapter: 'codex', model: ''});
});

// ---- askBtw -------------------------------------------------------------------------------------

test('askBtw: journals btw.asked then btw.answered via the injected ask, exactly once', async () => {
  const session = tmpSession();
  const settings = {order: ['claude'], models: {claude: 'sonnet'}};
  const orchestration = {operation: 'classic'};
  const calls = [];
  const ask = async ({prompt, agent}) => { calls.push({prompt, agent}); return {text: 'the answer', model: 'claude/sonnet'}; };
  await askBtw({session, settings, orchestration, ask, id: 'abc123', question: 'what changed?'});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].agent, {adapter: 'claude', model: 'sonnet'});
  assert.match(calls[0].prompt, /what changed\?/);
  const asked = session.events.find(e => e.kind === 'btw.asked');
  const answered = session.events.find(e => e.kind === 'btw.answered');
  assert.equal(asked.text, 'what changed?');
  assert.equal(asked.id, 'abc123');
  assert.equal(answered.id, 'abc123');
  assert.equal(answered.text, 'the answer');
  assert.equal(answered.model, 'claude/sonnet');
  assert.equal(session.events.some(e => e.kind === 'aside'), false);
});

// The coordinator's live evidence (session 159f4746, seq 3354): a /btw typed while the
// orchestrator was idle and a worker task was still running went unanswered — bounce journaled
// only `{kind: 'aside', text}`. Reproduce the same shape and prove /btw now answers it instead.
test('askBtw: orchestrator idle with a worker running — answers via the injected ask, no aside, nothing delivered', async () => {
  const session = tmpSession();
  session.append({kind: 'task.submitted', task: 'worker-live', context: session.id, parent: null, profile: 'build', deadline: null});
  session.append({kind: 'task.started', task: 'worker-live', attempt: 1});
  const settings = {orchestrator: 'main', models: {}};
  const orchestration = {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'codex', model: ''}}};
  const ask = async ({prompt, agent}) => { assert.match(prompt, /docker\/orbstack/); assert.equal(agent.adapter, 'codex'); return {text: 'bounce runs every service in this project\'s own docker compose scope, not the default one', model: 'codex'}; };
  await askBtw({session, settings, orchestration, ask, id: 'seq3354', question: "this is weird.. I don't see anything ace related in docker/orbstack"});
  assert.equal(session.events.some(e => e.kind === 'btw.asked' && e.text.includes('docker/orbstack')), true);
  assert.equal(session.events.some(e => e.kind === 'btw.answered' && e.id === 'seq3354'), true);
  assert.equal(session.events.some(e => e.kind === 'aside'), false, 'a /btw must never fall back to saving an aside');
  // No delivery mechanism exists on this path at all: askBtw never references router/deliver.
});

test('askBtw: a failing ask journals btw.failed with a reason identifier, never btw.answered', async () => {
  const session = tmpSession();
  const ask = async () => { throw new Error('boom'); };
  await askBtw({session, settings: {order: ['claude'], models: {}}, orchestration: {operation: 'classic'}, ask, id: 'x1', question: 'q'});
  const failed = session.events.find(e => e.kind === 'btw.failed');
  assert.equal(failed.id, 'x1');
  assert.equal(failed.reason, 'failed');
  assert.equal(session.events.some(e => e.kind === 'btw.answered'), false);
});

test('askBtw: an ask returning no text journals btw.failed reason no_answer', async () => {
  const session = tmpSession();
  const ask = async () => ({text: ''});
  await askBtw({session, settings: {order: ['claude'], models: {}}, orchestration: {operation: 'classic'}, ask, id: 'x2', question: 'q'});
  assert.equal(session.events.find(e => e.kind === 'btw.failed').reason, 'no_answer');
});

test('askBtw: no resolvable agent journals btw.failed reason no_agent, without calling ask', async () => {
  const session = tmpSession();
  let called = false;
  const ask = async () => { called = true; return {text: 'x'}; };
  await askBtw({session, settings: {order: [], models: {}}, orchestration: {operation: 'classic'}, ask, id: 'x3', question: 'q'});
  assert.equal(called, false);
  assert.equal(session.events.find(e => e.kind === 'btw.failed').reason, 'no_agent');
});

// ---- createBtwAsk (the real, injectable one-shot path) -----------------------------------------

test('createBtwAsk: runs the provider in plan mode with the resolved agent\'s model, one-shot', async () => {
  const calls = [];
  const run = async ({provider, args, prompt, emit}) => {
    calls.push({provider, args, prompt});
    emit({kind: 'result', success: true, text: 'plan-mode answer'});
    return {status: 'completed', code: 0};
  };
  const ask = createBtwAsk({run, executables: {}});
  const answer = await ask({prompt: 'question in context', agent: {adapter: 'claude', model: 'sonnet'}});
  assert.equal(answer.text, 'plan-mode answer');
  assert.equal(answer.model, 'claude/sonnet');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.ok(calls[0].args.length, 'invocation() must have produced args');
});

test('createBtwAsk: a request in flight is aborted when its owner exits, like session-title\'s createAsk', async () => {
  let exiting;
  const onExit = fn => { exiting = fn; return () => { exiting = null; }; };
  let aborted = false;
  const run = ({signal}) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({status: 'cancelled'}); }));
  const ask = createBtwAsk({run, onExit});
  const pending = ask({prompt: 'p', agent: {adapter: 'claude', model: ''}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof exiting, 'function');
  exiting();
  await assert.rejects(pending, /cancelled/);
  assert.equal(aborted, true);
});

// ---- exclusion from the orchestrator's own context/handoff packet -----------------------------

test('handoff(): btw.asked/btw.answered/btw.failed rows never enter the packet handed to the orchestrator', () => {
  const session = tmpSession();
  session.append({kind: 'user', text: 'original task'});
  session.append({kind: 'btw.asked', text: 'a side question nobody should see in the main context', id: 'z1'});
  session.append({kind: 'btw.answered', id: 'z1', text: 'a side answer that must stay out of the handoff packet', model: 'claude/sonnet'});
  session.append({kind: 'btw.failed', id: 'z2', reason: 'failed'});
  const packet = handoff(session, 'continue', 48000);
  assert.doesNotMatch(packet, /side question nobody should see/);
  assert.doesNotMatch(packet, /side answer that must stay out/);
  assert.match(packet, /original task/);
});

// ---- CONTRACT U5a: /btw is a side call, never a submit(/router.run( site ----------------------

test('cli.js: the /btw branch never calls router.deliver, steerAside, or saves an aside', () => {
  const btw = cliSource.indexOf("command === 'btw'");
  assert.notEqual(btw, -1);
  const block = cliSource.slice(btw, cliSource.indexOf('} else if', btw + 1));
  assert.equal(/router\.deliver\(|steerAside\(|noteAside\(|session\.append\(\{kind: 'aside'/.test(block), false);
  assert.match(block, /askBtw\(/);
});

test('cli.js: the busy notice tells the user /steer steers and /btw asks aside', () => {
  assert.match(cliSource, /\/steer steers it · \/btw asks aside/);
});
