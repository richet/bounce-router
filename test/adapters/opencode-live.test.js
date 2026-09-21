import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createOpencodeLive, toolsFor, mapUsage, scrubCredentials} from '../../src/adapters/opencode-live.js';

// The OpenCode adapter is the claude adapter's twin: one `opencode run` per turn, prompt on stdin,
// JSON lines out, exit = turn end. The fake prints the event shapes observed from the real binary
// (docs/plans/local-design-v2.md §1) and exits; it does not simulate a server.
const helper = fileURLToPath(new URL('../helpers/fake-opencode.js', import.meta.url));

const setup = (t, env = {}) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-live-')));
  const dir = path.join(cwd, '.task'); fs.mkdirSync(dir, {mode: 0o700});
  const log = path.join(dir, 'fake.log');
  const saved = {...process.env};
  Object.assign(process.env, {FAKE_OC_LOG: log, ...env});
  t.after(() => { for (const key of Object.keys({FAKE_OC_LOG: 1, ...env})) delete process.env[key]; Object.assign(process.env, saved); fs.rmSync(cwd, {recursive: true, force: true}); });
  const logged = prefix => JSON.parse(fs.readFileSync(log, 'utf8').split('\n').find(line => line.startsWith(`${prefix} `)).slice(prefix.length + 1));
  return {cwd, dir, logged};
};
const profileFor = (extra = {}) => ({mode: 'yolo', executables: {opencode: helper}, ...extra});
const drain = async (adapter, handle) => { const events = []; for await (const event of adapter.events(handle)) events.push(event); return events; };

test('launch: the prompt goes in on stdin, the worker runs in the real tree as its agent, and the stream ends in a result', async t => {
  const {cwd, dir, logged} = setup(t, {FAKE_OC_USAGE: JSON.stringify({total: 21, input: 11, output: 7, reasoning: 4, cache: {read: 3, write: 2}})});
  const adapter = createOpencodeLive({});
  const profile = profileFor({policy: 'read-only', providerID: 'lmstudio', model: 'qwen-loaded',
    opencodeConfig: {provider: {lmstudio: {options: {baseURL: 'http://127.0.0.1:1234/v1'}}}},
    agent: {name: 'analyst', description: 'Scouts.', prompt: 'You scout.', maxSteps: 12}});
  const handle = await adapter.launch({peer: 'worker:t1', profile, orders: 'say hello', cwd, dir});
  assert.equal(typeof handle.pid, 'number');
  const events = await drain(adapter, handle);

  assert.deepEqual(events.filter(e => e.kind !== 'activity'), [
    {kind: 'native', provider: 'opencode', sessionId: handle.sessionId},
    {kind: 'assistant', text: 'echo: say hello'},
    {kind: 'usage', usage: {input: 11, cache_read: 3, cache_write: 2, output: 7}},
    {kind: 'result', status: 'completed', text: 'echo: say hello'},
  ]);
  assert.match(handle.sessionId, /^ses_fake_/);
  assert.deepEqual(events.filter(e => e.kind === 'activity').map(e => e.text), ['', 'read completed']);

  assert.deepEqual(logged('ARGV'), ['run', '--pure', '--format', 'json', '--agent', 'analyst', '-m', 'lmstudio/qwen-loaded', '--dir', cwd]);
  assert.equal(logged('PROMPT'), 'say hello');
  const config = logged('CONFIG');
  assert.deepEqual(config.provider, {lmstudio: {options: {baseURL: 'http://127.0.0.1:1234/v1'}}}, 'the provider block bounce built is passed through');
  assert.deepEqual(config.agent.analyst, {description: 'Scouts.', mode: 'primary', prompt: 'You scout.', maxSteps: 12, tools: toolsFor('read-only')});
});

test('the policy tier is the tools map: read-only and plan can change nothing; write and yolo edit and run commands', () => {
  for (const tier of ['read-only', 'plan']) {
    const tools = toolsFor(tier);
    assert.deepEqual([tools.read, tools.grep, tools.glob, tools.todowrite], [true, true, true, false]);
    assert.deepEqual([tools.write, tools.edit, tools.apply_patch, tools.bash], [false, false, false, false], tier);
  }
  for (const tier of ['write', 'yolo']) {
    const tools = toolsFor(tier);
    assert.deepEqual([tools.write, tools.edit, tools.apply_patch, tools.bash], [true, true, true, true], tier);
  }
  for (const tier of ['read-only', 'plan', 'write', 'yolo']) {
    const tools = toolsFor(tier);
    assert.deepEqual([tools.task, tools.websearch, tools.webfetch, tools.skill, tools.question, tools.invalid], [false, false, false, false, false, false], 'never a subagent, the network or a question to nobody');
  }
});

test('a worker with no agent file still gets a named agent carrying its tier, and no -m when no model was resolved', async t => {
  const {cwd, dir, logged} = setup(t);
  const adapter = createOpencodeLive({});
  await drain(adapter, await adapter.launch({peer: 'worker:t1', profile: profileFor({mode: 'plan'}), orders: 'x', cwd, dir}));
  assert.deepEqual(logged('ARGV'), ['run', '--pure', '--format', 'json', '--agent', 'bounce-worker', '--dir', cwd]);
  const agent = logged('CONFIG').agent['bounce-worker'];
  assert.equal(agent.maxSteps, 30, 'a step cap always exists: it is what bounds a model that will not stop');
  assert.deepEqual(agent.tools, toolsFor('plan'));
});

test('vendor credentials never reach a local worker; its report grant and the endpoint key do', async t => {
  const {cwd, dir, logged} = setup(t, {ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', MY_LMSTUDIO_KEY: 'lm', BOUNCE_BUS: '/tmp/orchestrator.sock'});
  const adapter = createOpencodeLive({});
  const profile = profileFor({apiKeyEnv: 'MY_LMSTUDIO_KEY', report: {BOUNCE_REPORT_BUS: '/tmp/r.sock', BOUNCE_REPORT_TOKEN_FILE: '/tmp/r.tok'}});
  await drain(adapter, await adapter.launch({peer: 'worker:t1', profile, orders: 'x', cwd, dir}));
  const keys = logged('ENV');
  assert.equal(keys.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(keys.includes('OPENAI_API_KEY'), false);
  assert.equal(keys.includes('BOUNCE_BUS'), false, 'a worker never inherits the orchestrator bus');
  assert.deepEqual(keys.filter(key => key.startsWith('BOUNCE_REPORT')), ['BOUNCE_REPORT_BUS', 'BOUNCE_REPORT_TOKEN_FILE']);
  // The user's own Claude Code instructions and skills must never be injected into a worker.
  assert.deepEqual(keys.filter(key => key.startsWith('OPENCODE_DISABLE_')), ['OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_CLAUDE_CODE',
    'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    'OPENCODE_DISABLE_PROJECT_CONFIG']);
  assert.deepEqual(scrubCredentials({A_API_KEY: '1', MY_LMSTUDIO_KEY: '2', PATH: '/bin'}, ['MY_LMSTUDIO_KEY']), {MY_LMSTUDIO_KEY: '2', PATH: '/bin'});
  assert.deepEqual(mapUsage({total: 9, input: 4, output: 5, reasoning: 1, cache: {read: 0, write: 0}}), {input: 4, cache_read: 0, cache_write: 0, output: 5});
});

test('a write worker edits the real tree directly, like a cloud yolo worker: no copy, nothing left behind', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_WRITE: 'src/a.js:export const x = 2;'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t1', profile: profileFor({policy: 'write'}), orders: 'edit', cwd, dir});
  assert.equal(handle.cwd, cwd, 'the worker runs in the project itself');
  const events = await drain(adapter, handle);
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/a.js'), 'utf8'), 'export const x = 2;');
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('bounce-local-ws-') && fs.statSync(path.join(os.tmpdir(), name)).mtimeMs > Date.now() - 5000), []);
});

test('failures are the runtime\'s, so they are recoverable: a dead endpoint, a turn with no answer, a missing binary', async t => {
  const dead = setup(t, {FAKE_OC_SCENARIO: 'fail'});
  const adapter = createOpencodeLive({});
  const failed = (await drain(adapter, await adapter.launch({peer: 'worker:t1', profile: profileFor(), orders: 'x', cwd: dead.cwd, dir: dead.dir}))).at(-1);
  assert.deepEqual(failed, {kind: 'result', status: 'failed', recoverable: true, text: 'opencode exited 1: Error: connect ECONNREFUSED 127.0.0.1:1234'});

  process.env.FAKE_OC_SCENARIO = 'notext';
  const silent = (await drain(adapter, await adapter.launch({peer: 'worker:t1', profile: profileFor(), orders: 'x', cwd: dead.cwd, dir: dead.dir}))).at(-1);
  assert.deepEqual(silent, {kind: 'result', status: 'failed', recoverable: true, text: 'opencode finished without an answer'});

  const missing = await drain(adapter, await adapter.launch({peer: 'worker:t1', profile: {mode: 'yolo', executables: {opencode: path.join(dead.cwd, 'no-such-opencode')}}, orders: 'x', cwd: dead.cwd, dir: dead.dir}));
  assert.deepEqual(missing.map(e => [e.kind, e.code]), [['error', 'missing']]);
});

test('a tool call opencode refused is visible in the journal and does not fail the turn; a non-JSON line is tolerated', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'denied'});
  const adapter = createOpencodeLive({});
  const events = await drain(adapter, await adapter.launch({peer: 'worker:t1', profile: profileFor({policy: 'read-only'}), orders: 'x', cwd, dir}));
  assert.deepEqual(events.find(e => e.kind === 'diagnostic'), {kind: 'diagnostic', text: 'read: The user rejected permission to use this specific tool call.'});
  assert.equal(events.at(-1).status, 'completed');
  // Observed live (2026-09-20): reaching outside --dir makes opencode auto-reject AND end the turn.
  process.env.FAKE_OC_SCENARIO = 'refused';
  const stopped = await drain(adapter, await adapter.launch({peer: 'worker:t1', profile: profileFor({policy: 'read-only'}), orders: 'x', cwd, dir}));
  assert.deepEqual(stopped.at(-1), {kind: 'result', status: 'failed', recoverable: true,
    text: 'opencode stopped the turn: permission requested: external_directory (/elsewhere/*); auto-rejecting'});
  process.env.FAKE_OC_SCENARIO = 'garbage';
  const noisy = await drain(adapter, await adapter.launch({peer: 'worker:t1', profile: profileFor(), orders: 'x', cwd, dir}));
  assert.deepEqual(noisy[0], {kind: 'status', text: 'not json at all'});
  assert.equal(noisy.at(-1).status, 'completed');
});

test('resume continues the native session with -s, and messages delivered mid-turn ride in on it', async t => {
  const {cwd, dir, logged} = setup(t, {FAKE_OC_SCENARIO: 'hold', FAKE_OC_READY: path.join(os.tmpdir(), `oc-ready-${process.pid}-a`)});
  t.after(() => fs.rmSync(process.env.FAKE_OC_READY ?? '', {force: true}));
  const adapter = createOpencodeLive({});
  const running = await adapter.launch({peer: 'worker:t1', profile: profileFor(), orders: 'first', cwd, dir});
  for (const start = Date.now(); !fs.existsSync(process.env.FAKE_OC_READY);) { if (Date.now() - start > 5000) throw new Error('fake never became ready'); await new Promise(r => setTimeout(r, 10)); }
  assert.equal(await adapter.deliver(running, {text: 'also check the tests'}), 'next-turn');
  assert.equal(await adapter.deliver(running, {text: 42}), 'next-turn', 'non-string text is coerced');
  assert.equal(await adapter.deliver(running, {text: 'x'.repeat(1_000_001)}), 'queued');
  assert.deepEqual(adapter.pending(dir), ['also check the tests', '42']);
  assert.deepEqual(await adapter.cancel(running), {verified: true});

  process.env.FAKE_OC_SCENARIO = 'ok';
  fs.rmSync(path.join(dir, 'fake.log'), {force: true});
  const resumed = await adapter.resume({peer: 'worker:t1', profile: profileFor(), native: {sessionId: 'ses_earlier'}, message: 'file your report', cwd, dir});
  const events = await drain(adapter, resumed);
  assert.deepEqual(logged('ARGV').slice(-2), ['-s', 'ses_earlier']);
  assert.equal(logged('PROMPT'), 'also check the tests\n42\nfile your report');
  assert.deepEqual(events.find(e => e.kind === 'native'), {kind: 'native', provider: 'opencode', sessionId: 'ses_earlier'});
  assert.equal(events.at(-1).status, 'completed');
  assert.deepEqual(adapter.pending(dir), [], 'pending messages are consumed exactly once');
});

test('cancel is killing our own child: verified within bounds even when it ignores SIGTERM, and nothing is orphaned', async t => {
  for (const scenario of ['hold', 'stubborn']) {
    const ready = path.join(os.tmpdir(), `oc-ready-${process.pid}-${scenario}`);
    const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: scenario, FAKE_OC_READY: ready});
    const adapter = createOpencodeLive({});
    const handle = await adapter.launch({peer: 'worker:t1', profile: profileFor(), orders: 'x', cwd, dir});
    for (const start = Date.now(); !fs.existsSync(ready);) { if (Date.now() - start > 5000) throw new Error('fake never became ready'); await new Promise(r => setTimeout(r, 10)); }
    const started = Date.now();
    assert.deepEqual(await adapter.cancel(handle), {verified: true}, scenario);
    assert.equal(Date.now() - started < 6000, true, `${scenario}: cancel took ${Date.now() - started}ms`);
    assert.throws(() => process.kill(handle.pid, 0), {code: 'ESRCH'});
    fs.rmSync(ready, {force: true});
  }
});

// Observed live twice (qwen3-4b re-reading PROGRESS.md; qwen3.8-27b alternating read/todowrite for 42
// steps when asked to use a tool it did not have): a stuck model repeats itself until the step cap.
test('a worker repeating the same call with nothing changed is stopped as no progress, recoverably, and the process is gone', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'loop'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t1', profile: profileFor({policy: 'read-only'}), orders: 'x', cwd, dir});
  const started = Date.now();
  const events = await drain(adapter, handle);
  assert.deepEqual(events.at(-1), {kind: 'result', status: 'failed', recoverable: true,
    text: 'no progress: read {"filePath":"src/a.js"} repeated 4 times with nothing changed in between'});
  assert.equal(events.filter(e => e.kind === 'activity' && e.text === 'read completed').length >= 4, true);
  assert.equal(Date.now() - started < 8000, true);
  assert.throws(() => process.kill(handle.pid, 0), {code: 'ESRCH'});
});

// Observed live (qwen3-coder-30b-a3b): the answer arrives at step 2, every step claims `tool-calls`,
// and opencode then spins on empty steps until the step cap. Same model, 3 runs: 10 steps each.
test('empty steps after an answer end the turn AS that answer; empty steps with no answer are no progress', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'empty'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t1', profile: profileFor({policy: 'read-only'}), orders: 'say hello', cwd, dir});
  const started = Date.now();
  const events = await drain(adapter, handle);
  assert.deepEqual(events.at(-1), {kind: 'result', status: 'completed', text: 'echo: say hello'});
  assert.deepEqual(events.find(e => e.kind === 'diagnostic'), {kind: 'diagnostic', text: 'ended the turn after 2 empty steps; the worker had already answered'});
  assert.equal(events.filter(e => e.kind === 'usage').length, 4, 'two real steps and the two empty ones that proved the loop — no more');
  assert.equal(Date.now() - started < 6000, true);
  assert.throws(() => process.kill(handle.pid, 0), {code: 'ESRCH'});

  process.env.FAKE_OC_SCENARIO = 'empty-notext';
  const silent = await drain(adapter, await adapter.launch({peer: 'worker:t1', profile: profileFor({policy: 'read-only'}), orders: 'x', cwd, dir}));
  assert.deepEqual(silent.at(-1), {kind: 'result', status: 'failed', recoverable: true, text: 'no progress: 2 empty steps and no answer'});
});

test('capabilities: the same ladder as before, live and resumable', () => {
  assert.deepEqual(createOpencodeLive().capabilities(), {live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'],
    executionPolicies: ['read-only', 'plan', 'write', 'yolo'], quota: 'stream'});
});

test('the answer is the last text that says something: a stray closing fence after the report is not the result', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'fence'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:f', profile: profileFor({policy: 'read-only'}), cwd, dir, orders: 'report please'});
  const events = await drain(adapter, handle);
  assert.deepEqual(events.at(-1), {kind: 'result', status: 'completed', text: 'echo: report please'});
  assert.deepEqual(events.filter(event => event.kind === 'assistant').map(event => event.text), ['echo: report please', '```'], 'the fence is still shown in the pane');
});

test('a write worker in a yolo session may work outside the project folder, as a cloud yolo worker may; a read-only one may not', async t => {
  // Found live: the orchestrator put a gate script and an evidence folder under /private/tmp, and
  // opencode auto-rejected the first path outside --dir, which ends the whole turn.
  const {cwd, dir, logged} = setup(t);
  const adapter = createOpencodeLive({});
  await drain(adapter, await adapter.launch({peer: 'worker:w', profile: profileFor({policy: 'write'}), cwd, dir, orders: 'go'}));
  assert.deepEqual(logged('CONFIG').permission, {external_directory: 'allow'});
  fs.rmSync(path.join(dir, 'fake.log'));
  await drain(adapter, await adapter.launch({peer: 'worker:r', profile: profileFor({policy: 'read-only'}), cwd, dir, orders: 'go'}));
  assert.equal(Object.hasOwn(logged('CONFIG'), 'permission'), false);
  fs.rmSync(path.join(dir, 'fake.log'));
  await drain(adapter, await adapter.launch({peer: 'worker:p', profile: profileFor({policy: 'write', mode: 'plan'}), cwd, dir, orders: 'go'}));
  assert.equal(Object.hasOwn(logged('CONFIG'), 'permission'), false, 'a plan session changes nothing, inside or outside');
});
