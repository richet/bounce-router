import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import net from 'node:net';
import {createOpencodeLive, toolsFor, mapUsage, scrubCredentials, probeSandbox, writeFenceSandbox} from '../../src/adapters/opencode-live.js';

// The OpenCode adapter is the claude adapter's twin: one `opencode run` per turn, prompt on stdin,
// JSON lines out, exit = turn end. The fake prints the event shapes observed from the real binary
// (docs/plans/local-design-v2.md §1) and exits; it does not simulate a server.
const helper = fileURLToPath(new URL('../helpers/fake-opencode.js', import.meta.url));

const setup = (t, env = {}) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-live-')));
  const dir = path.join(cwd, '.task'); fs.mkdirSync(dir, {mode: 0o700});
  const log = path.join(dir, 'fake.log');
  const saved = {...process.env};
  // Every test names its scenario (default: a normal turn). Some tests switch it mid-test by writing
  // process.env directly; without this a later test inherited the last one — once a worker that holds forever.
  env = {FAKE_OC_SCENARIO: 'ok', ...env};
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
    {kind: 'assistant', speaker: 'worker', text: 'echo: say hello'},
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

test('vendor credentials never reach a local worker; only its report MCP server receives the scoped grant', async t => {
  const {cwd, dir, logged} = setup(t, {ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', MY_LMSTUDIO_KEY: 'lm', BOUNCE_BUS: '/tmp/orchestrator.sock'});
  const adapter = createOpencodeLive({});
  const profile = profileFor({apiKeyEnv: 'MY_LMSTUDIO_KEY', report: {BOUNCE_REPORT_BUS: '/tmp/r.sock', BOUNCE_REPORT_TOKEN_FILE: '/tmp/r.tok'}});
  await drain(adapter, await adapter.launch({peer: 'worker:t1', profile, orders: 'x', cwd, dir}));
  const keys = logged('ENV');
  assert.equal(keys.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(keys.includes('OPENAI_API_KEY'), false);
  assert.equal(keys.includes('BOUNCE_BUS'), false, 'a worker never inherits the orchestrator bus');
  assert.deepEqual(keys.filter(key => key.startsWith('BOUNCE_REPORT')), []);
  const config = logged('CONFIG');
  assert.deepEqual(Object.keys(config.mcp), ['bounce']);
  assert.deepEqual(config.mcp.bounce.environment, {...profile.report, BOUNCE_REPORT_TASK: 't1'});
  assert.equal(config.mcp.bounce.type, 'local');
  assert.equal(config.mcp.bounce.command[0], process.execPath);
  assert.match(config.mcp.bounce.command[1], /\/mcp-report\.js$/);
  assert.equal(config.agent['bounce-worker'].tools.bounce_report, true);
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
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'loop', FAKE_OC_CONCLUDE: 'silent'});
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

// Traced live (qwen3.6-35b-a3b as reviewer): it read the diff and every file a review needs, then
// repeated one identical glob 26 times and never wrote a verdict. The stall is real, but the reading
// was done — so after the guard stops the turn, the same session is asked ONCE, with no tools, to
// state its conclusion from what it has. An answer completes the task; silence is the failure it was.
test('a stalled worker that had read material is asked once, tools off, for its conclusion: an answer is the result, silence stays a no-progress failure', async t => {
  const {cwd, dir, logged} = setup(t, {FAKE_OC_SCENARIO: 'loop', FAKE_OC_CONCLUDE: 'answer'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t2', profile: profileFor({policy: 'read-only', agent: {name: 'reviewer', prompt: 'You review.', maxSteps: 40}}), orders: 'review it', cwd, dir});
  const events = await drain(adapter, handle);
  assert.equal(events.at(-1).status, 'completed');
  assert.match(events.at(-1).text, /^FAIL: the boundary is off by one/);
  const diagnostics = events.filter(e => e.kind === 'diagnostic').map(e => e.text);
  assert.equal(diagnostics.some(text => text.startsWith('no progress: read')), true, 'the stall is still on record');
  assert.equal(diagnostics.some(text => /^stalled after reading \d+ files?; asked once, tools off, for its conclusion$/.test(text)), true, diagnostics.join(' | '));
  assert.deepEqual(events.find(e => e.kind === 'diagnostic' && /^stalled after reading/.test(e.text)).reason, 'repeated_tools');
  assert.equal(diagnostics.includes('the conclusion turn answered: that answer is the result'), true);
  // the conclusion turn resumed the SAME session with every tool off and a prompt that says why
  const lines = fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n');
  const argvs = lines.filter(l => l.startsWith('ARGV ')).map(l => JSON.parse(l.slice(5)));
  assert.equal(argvs.length, 2);
  assert.equal(argvs[1].includes('-s'), true);
  const configs = lines.filter(l => l.startsWith('CONFIG ')).map(l => JSON.parse(l.slice(7)));
  assert.deepEqual(Object.values(configs[1].agent.reviewer.tools).every(v => v === false), true);
  assert.equal(configs[1].agent.reviewer.maxSteps, 2);
  const prompts = lines.filter(l => l.startsWith('PROMPT ')).map(l => JSON.parse(l.slice(7)));
  assert.match(prompts[1], /^Stop using tools and give your final answer now, in full, as the orders asked \(you repeated the same call with nothing new\)\./);
  assert.throws(() => process.kill(handle.pid, 0), {code: 'ESRCH'});

  // a worker that stalled WITHOUT having read anything is not asked: it has nothing to conclude from
  fs.rmSync(path.join(dir, 'fake.log'));
  process.env.FAKE_OC_SCENARIO = 'loop-unread';
  const bare = await adapter.launch({peer: 'worker:t3', profile: profileFor({policy: 'read-only'}), orders: 'x', cwd, dir});
  const bareEvents = await drain(adapter, bare);
  assert.equal(bareEvents.at(-1).status, 'failed');
  assert.equal(fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(l => l.startsWith('ARGV ')).length, 1, 'no conclusion turn');
});

// Task leases: when bounce asks a running worker to conclude (ceiling reached, no progress, stuck),
// the running turn is stopped and the same session is asked, tools off, for its final answer, with
// the prompt bounce gives. The answer is the task's result; silence is a recoverable failure.
test('conclude stops the running turn and asks the same session, tools off, with bounce\'s prompt: the answer is the result', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'hold', FAKE_OC_CONCLUDE: 'answer'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t9', profile: profileFor({policy: 'read-only', agent: {name: 'reviewer', prompt: 'You review.', maxSteps: 40}}), orders: 'review it', cwd, dir});
  const drained = drain(adapter, handle);
  const started = Date.now();
  while (!handle.sessionId && Date.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 10));
  const firstPid = handle.pid;
  await adapter.conclude(handle, {prompt: 'bounce: time is up (the 60 min ceiling). Give your final answer now.'});
  const events = await drained;
  assert.equal(events.at(-1).status, 'completed');
  assert.match(events.at(-1).text, /^FAIL: the boundary is off by one \(conclusion for bounce: time is up/);
  assert.deepEqual(events.find(e => e.kind === 'diagnostic' && e.text === 'asked, tools off, for its conclusion: bounce: time is up (the 60 min ceiling). Give your final answer now.'),
    {kind: 'diagnostic', text: 'asked, tools off, for its conclusion: bounce: time is up (the 60 min ceiling). Give your final answer now.', reason: 'watchdog', phase: 'conclusion', toolsDisabled: true});
  assert.throws(() => process.kill(firstPid, 0), {code: 'ESRCH'});
  const lines = fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n');
  const argvs = lines.filter(l => l.startsWith('ARGV ')).map(l => JSON.parse(l.slice(5)));
  assert.equal(argvs.length, 2);
  assert.equal(argvs[1][argvs[1].indexOf('-s') + 1], handle.sessionId);
  const configs = lines.filter(l => l.startsWith('CONFIG ')).map(l => JSON.parse(l.slice(7)));
  assert.equal(Object.values(configs[1].agent.reviewer.tools).every(v => v === false), true);
  assert.equal(configs[1].agent.reviewer.maxSteps, 2);
  const prompts = lines.filter(l => l.startsWith('PROMPT ')).map(l => JSON.parse(l.slice(7)));
  assert.equal(prompts[1], 'bounce: time is up (the 60 min ceiling). Give your final answer now.');
});

test('a tool call is reported with its target, so bounce can tell new work from repeated work', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'loop', FAKE_OC_CONCLUDE: 'answer'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t10', profile: profileFor({policy: 'read-only'}), orders: 'x', cwd, dir});
  const events = await drain(adapter, handle);
  const calls = events.filter(e => e.kind === 'activity' && e.call).map(e => [e.call, e.change]);
  assert.deepEqual(calls.slice(0, 2), [['read CHANGE.diff', false], ['read src/a.js', false]]);
});

// Measured on the review-quality benchmark (2026-09-22): `opencode run --format json` prints nothing while
// a step generates, and one 27B step ran past 6 minutes writing its review — a silence watchdog killed a
// working model. While a step is open the adapter says so on a heartbeat; after the per-step cap it stops,
// so a step that never ends still goes silent and the watchdog still catches it.
test('an open step heartbeats as activity until the per-step cap, so a long generation is not silence', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'hold'});
  const adapter = createOpencodeLive({heartbeatMs: 40, stepBeatCapMs: 200});
  const handle = await adapter.launch({peer: 'worker:t11', profile: profileFor({policy: 'read-only'}), orders: 'x', cwd, dir});
  const beats = []; let opened = null;
  const drained = (async () => { for await (const e of adapter.events(handle)) {
    if (e.kind === 'activity' && e.text === '' && opened === null) opened = Date.now();
    if (e.kind === 'activity' && /^generating · step open \d+ s$/.test(e.text)) beats.push(Date.now() - opened);
  } })();
  await new Promise(resolve => setTimeout(resolve, 600));
  await adapter.cancel(handle);
  await drained;
  assert.equal(beats.length >= 3, true, `beats at ${beats.join(', ')} ms`);
  assert.equal(beats.every(at => at < 200 + 40 + 60), true, `a beat after the cap: ${beats.join(', ')} ms`);
});

// The probing reviewer: it may read and run commands, never change the tree. OpenCode's bash can write
// anywhere, so the whole opencode process runs under macOS sandbox-exec: writes to the project are refused
// by the OS, temp dirs stay writable, and the network reaches only the model endpoint.
test('a probe worker has read tools and bash, and runs sandboxed: it cannot write the project', async t => {
  assert.deepEqual(toolsFor('probe'), {read: true, grep: true, glob: true, write: false, edit: false, apply_patch: false, bash: true,
    todowrite: false, task: false, websearch: false, webfetch: false, skill: false, question: false, invalid: false});
  const adapter = createOpencodeLive({});
  assert.equal(adapter.capabilities().executionPolicies.includes('probe'), true);
  const {cwd, dir} = setup(t, {FAKE_OC_WRITE: 'src/probe-wrote.txt:x'});
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-probe-log-'));
  t.after(() => fs.rmSync(outside, {recursive: true, force: true}));
  process.env.FAKE_OC_LOG = path.join(outside, 'fake.log');
  const handle = await adapter.launch({peer: 'worker:t12', profile: profileFor({policy: 'probe', opencodeConfig: {provider: {lmstudio: {options: {baseURL: 'http://127.0.0.1:1234/v1'}}}}}), orders: 'probe it', cwd, dir});
  assert.equal(handle.args[0], '-p', 'launched through sandbox-exec with an inline profile');
  await drain(adapter, handle);
  assert.equal(fs.existsSync(path.join(cwd, 'src/probe-wrote.txt')), false, 'the project write was refused');
  assert.equal(fs.existsSync(path.join(outside, 'fake.log')), true, 'a temp dir outside the project stays writable');
  // the same worker without probe writes the tree, as a yolo worker does
  const free = await adapter.launch({peer: 'worker:t13', profile: profileFor({}), orders: 'write it', cwd, dir});
  await drain(adapter, free);
  assert.equal(fs.readFileSync(path.join(cwd, 'src/probe-wrote.txt'), 'utf8'), 'x');
});

test('a probe workspace is writable while its original source remains denied', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-probe-workspace-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-probe-source-'));
  t.after(() => { fs.rmSync(workspace, {recursive: true, force: true}); fs.rmSync(source, {recursive: true, force: true}); });
  const policy = probeSandbox(workspace, '/tmp/home', source);
  const code = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(workspace, 'cache.txt'))}, 'cache'); try { fs.writeFileSync(${JSON.stringify(path.join(source, 'source.txt'))}, 'bad'); process.exit(2); } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error; }`;
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, '--input-type=module', '-e', code], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(workspace, 'cache.txt'), 'utf8'), 'cache');
  assert.equal(fs.existsSync(path.join(source, 'source.txt')), false);
  assert.match(policy, new RegExp(`allow file-write\\*[^]*subpath ${JSON.stringify(fs.realpathSync(workspace)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(policy, new RegExp(`deny file-write\\* \\(subpath ${JSON.stringify(fs.realpathSync(source)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('a report grant opens only its assigned Unix bus socket inside the probe sandbox', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS sandbox-exec only');
  const root = fs.mkdtempSync('/private/tmp/oc-report-socket-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const allowed = path.join(root, 'allowed.sock');
  const forbidden = path.join(root, 'forbidden.sock');
  const serverA = net.createServer(socket => socket.end());
  const serverB = net.createServer(socket => socket.end());
  await Promise.all([new Promise(resolve => serverA.listen(allowed, resolve)), new Promise(resolve => serverB.listen(forbidden, resolve))]);
  t.after(() => { serverA.close(); serverB.close(); });
  const policy = probeSandbox(root, '/tmp/home', null, allowed);
  const code = `const net = require('node:net'); const one = path => new Promise(resolve => { const socket = net.createConnection(path); socket.once('connect', () => { socket.destroy(); resolve('connected'); }); socket.once('error', error => resolve(error.code)); }); (async () => { process.stdout.write(JSON.stringify([await one(process.argv[1]), await one(process.argv[2])])); })();`;
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, '-e', code, allowed, forbidden]);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise(resolve => child.once('close', resolve));
  assert.equal(exit, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), ['connected', 'EPERM']);
});

test('the report tool survives a tools-off conclusion and a grant for another task is not injected', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'loop', FAKE_OC_CONCLUDE: 'answer'});
  const adapter = createOpencodeLive({});
  const grant = {BOUNCE_REPORT_BUS: '/tmp/assigned.sock', BOUNCE_REPORT_TOKEN_FILE: '/tmp/assigned.token', task: 'assigned'};
  const handle = await adapter.launch({peer: 'worker:assigned', profile: profileFor({policy: 'read-only', report: grant}), orders: 'audit', cwd, dir});
  await drain(adapter, handle);
  const configs = fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(line => line.startsWith('CONFIG ')).map(line => JSON.parse(line.slice(7)));
  assert.equal(configs.length, 2);
  assert.equal(configs[1].agent['bounce-worker'].tools.bounce_report, true);
  assert.equal(Object.entries(configs[1].agent['bounce-worker'].tools).filter(([name]) => name !== 'bounce_report').every(([, enabled]) => enabled === false), true);
  assert.deepEqual(Object.keys(configs[1].mcp), ['bounce']);
  fs.rmSync(path.join(dir, 'fake.log'));
  await drain(adapter, await adapter.launch({peer: 'worker:other', profile: profileFor({report: grant}), orders: 'x', cwd, dir}));
  const wrong = fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').find(line => line.startsWith('CONFIG '));
  assert.deepEqual(JSON.parse(wrong.slice(7)).mcp, {});
});

test('an acknowledged final report tool ends a clean OpenCode turn without a prose answer or extra conclusion', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'report-final', FAKE_OC_CONCLUDE: 'answer'});
  const adapter = createOpencodeLive({});
  const profile = profileFor({report: {BOUNCE_REPORT_BUS: '/tmp/r.sock', BOUNCE_REPORT_TOKEN_FILE: '/tmp/r.token'}});
  const events = await drain(adapter, await adapter.launch({peer: 'worker:t1', profile, orders: 'audit', cwd, dir}));
  assert.deepEqual(events.at(-1), {kind: 'result', status: 'completed', text: 'Final report submitted via bounce_report'});
  assert.equal(fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(line => line.startsWith('ARGV ')).length, 1);
});

test('a rejected final tool call or a milestone alone still requires a final answer', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'report-rejected', FAKE_OC_CONCLUDE: 'silent'});
  const adapter = createOpencodeLive({});
  const profile = profileFor({report: {BOUNCE_REPORT_BUS: '/tmp/r.sock', BOUNCE_REPORT_TOKEN_FILE: '/tmp/r.token'}});
  for (const scenario of ['report-rejected', 'report-milestone']) {
    process.env.FAKE_OC_SCENARIO = scenario;
    fs.rmSync(path.join(dir, 'fake.log'), {force: true});
    const events = await drain(adapter, await adapter.launch({peer: 'worker:t1', profile, orders: 'audit', cwd, dir}));
    assert.equal(events.at(-1).status, 'failed', scenario);
    assert.equal(fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(line => line.startsWith('ARGV ')).length, 2, scenario);
  }
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
    executionPolicies: ['read-only', 'probe', 'plan', 'write', 'yolo'], quota: 'stream'});
});

test('the answer is the last text that says something: a stray closing fence after the report is not the result', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'fence'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:f', profile: profileFor({policy: 'read-only'}), cwd, dir, orders: 'report please'});
  const events = await drain(adapter, handle);
  assert.deepEqual(events.at(-1), {kind: 'result', status: 'completed', text: 'echo: report please'});
  assert.deepEqual(events.filter(event => event.kind === 'assistant').map(event => event.text), ['echo: report please', '```'], 'the fence is still shown in the pane');
});

test('any worker may reach a path outside the project folder, as a cloud worker may; what it can DO there is still its tools', async t => {
  // Found live: the orchestrator put a gate script and an evidence folder under /private/tmp, and
  // opencode auto-rejected the first path outside --dir, which ends the whole turn.
  const {cwd, dir, logged} = setup(t);
  const adapter = createOpencodeLive({});
  await drain(adapter, await adapter.launch({peer: 'worker:w', profile: profileFor({policy: 'write'}), cwd, dir, orders: 'go'}));
  assert.deepEqual(logged('CONFIG').permission, {external_directory: 'allow'});
  fs.rmSync(path.join(dir, 'fake.log'));
  await drain(adapter, await adapter.launch({peer: 'worker:r', profile: profileFor({policy: 'read-only'}), cwd, dir, orders: 'go'}));
  // Found live, twice: a READ-ONLY reviewer was pointed at evidence under /private/tmp, opencode
  // auto-rejected the path and ended its turn. A cloud read-only worker reads anywhere; so does this
  // one — and it still has no tool that writes or runs anything, outside or inside.
  const readOnly = logged('CONFIG');
  assert.deepEqual(readOnly.permission, {external_directory: 'allow'});
  assert.deepEqual([readOnly.agent['bounce-worker'].tools.write, readOnly.agent['bounce-worker'].tools.edit, readOnly.agent['bounce-worker'].tools.bash], [false, false, false]);
  fs.rmSync(path.join(dir, 'fake.log'));
  await drain(adapter, await adapter.launch({peer: 'worker:p', profile: profileFor({policy: 'write', mode: 'plan'}), cwd, dir, orders: 'go'}));
  assert.deepEqual(logged('CONFIG').permission, {external_directory: 'allow'});
  assert.equal(logged('CONFIG').agent['bounce-worker'].tools.write, false, 'a plan session still changes nothing');
});

// Observed live: a worker said "I'll execute this task systematically…", did tool work for six
// minutes, went silent, and that opening sentence became the task's completion (Jev caught it via
// empty_diff, one wasted round). Text before tool work is not an answer to the orders.
// Then found live: this is the commonest way a local worker ends. Both
// `worker_runtime` failures in that session were qwen3.6-35b ending a clean turn with tool work done and
// nothing said after it — 6 and 14 minutes of work discarded, with ZERO conclusion attempts, because the
// ask fired only for a step cap, a repeat-stall or a lease end. Having no answer is the reason TO ask.
test('a turn that ends with tool calls and no text after them is asked, once, for its answer', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'opener-then-silence', FAKE_OC_CONCLUDE: 'answer'});
  const adapter = createOpencodeLive({});
  const events = await drain(adapter, await adapter.launch({peer: 'worker:o', profile: profileFor({policy: 'read-only'}), cwd, dir, orders: 'do it'}));
  assert.equal(events.some(e => e.kind === 'assistant' && e.text.startsWith('I will execute')), true, 'the opener is still shown');
  assert.equal(events.at(-1).status, 'completed');
  assert.match(events.at(-1).text, /^FAIL: the boundary is off by one/, 'the answer is what it said when asked, never the opener');
  assert.deepEqual(events.find(e => e.kind === 'diagnostic' && /ended without an answer/.test(e.text)),
    {kind: 'diagnostic', text: 'the turn ended without an answer; asked once, tools off, for it', reason: 'missing_answer', phase: 'conclusion', toolsDisabled: true});
});

test('when the worker will not answer even then, the turn fails and the next AI may try', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'opener-then-silence'}); // no FAKE_OC_CONCLUDE: silent when asked
  const adapter = createOpencodeLive({});
  const events = await drain(adapter, await adapter.launch({peer: 'worker:o2', profile: profileFor({policy: 'read-only'}), cwd, dir, orders: 'do it'}));
  assert.deepEqual(events.at(-1), {kind: 'result', status: 'failed', recoverable: true, text: 'no answer: the worker said nothing after its last tool call'});
});

// Found live: a reviewer hit opencode's step cap; opencode injected
// "CRITICAL - MAXIMUM STEPS REACHED … Respond with text only", and bounce recorded THAT as the
// worker's answer — the review was blocked as an unreadable verdict after 24 minutes. The notice is
// opencode talking, not the worker: the same session is asked once, tools off, for its real answer,
// and a model's stray thinking markers never reach the answer either.
test('the step-cap notice is not an answer: the worker is asked to conclude, and thinking tags are stripped', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'stepcap', FAKE_OC_CONCLUDE: 'answer'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t14', profile: profileFor({policy: 'read-only', agent: {name: 'reviewer', prompt: 'You review.', maxSteps: 40}}), orders: 'review it', cwd, dir});
  const events = await drain(adapter, handle);
  const said = events.filter(e => e.kind === 'assistant').map(e => e.text);
  assert.equal(said.some(text => /MAXIMUM STEPS REACHED/.test(text)), false, 'opencode\'s own notice is never the worker speaking');
  assert.equal(said.some(text => /<\/?think>/.test(text)), false, 'thinking markers are stripped');
  assert.equal(events.at(-1).status, 'completed');
  assert.match(events.at(-1).text, /^FAIL: the boundary is off by one/);
  assert.equal(events.find(e => e.kind === 'diagnostic' && /step cap; asked once/.test(e.text)).reason, 'step_cap');
  const prompts = fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(l => l.startsWith('PROMPT ')).map(l => JSON.parse(l.slice(7)));
  assert.match(prompts[1], /^Stop using tools and give your final answer now, in full, as the orders asked \(your step budget is spent\)\./);
});

test('a conclusion titled after the step-cap notice is the worker\'s answer, not runtime noise', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'stepcap', FAKE_OC_CONCLUDE: 'capsummary'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t15', profile: profileFor({policy: 'read-only', agent: {name: 'reviewer', prompt: 'You review.', maxSteps: 40}}), orders: 'review it', cwd, dir});
  const events = await drain(adapter, handle);
  assert.equal(events.at(-1).kind, 'result');
  assert.equal(events.at(-1).status, 'completed');
  assert.match(events.at(-1).text, /^## Maximum Steps Reached - Final Summary\n\n### Work Completed\n1\. Baseline: 148 passed/);
  assert.equal(events.some(e => e.kind === 'diagnostic' && /^opencode: ## Maximum Steps Reached/.test(e.text)), false);
});

test('an acknowledged report in the conclusion turn is what the worker said; a rejected one is not', async t => {
  for (const [mode, status] of [['milestone', 'completed'], ['rejected', 'failed']]) {
    const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'stepcap', FAKE_OC_CONCLUDE: mode});
    const adapter = createOpencodeLive({});
    const handle = await adapter.launch({peer: 'worker:t16', profile: profileFor({policy: 'read-only', agent: {name: 'reviewer', prompt: 'You review.', maxSteps: 40}}), orders: 'review it', cwd, dir});
    const events = await drain(adapter, handle);
    assert.equal(events.at(-1).status, status, mode);
    if (mode === 'milestone') assert.equal(events.at(-1).text, 'Mutation test complete: removing the realPath check at create.ts:156 makes the line 327 test fail with definition_changed.');
  }
});

test('a step cap with no answer at all is a clean failure, not a fake result', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'stepcap', FAKE_OC_CONCLUDE: 'silent'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t15', profile: profileFor({policy: 'read-only'}), orders: 'review it', cwd, dir});
  const events = await drain(adapter, handle);
  assert.deepEqual([events.at(-1).kind, events.at(-1).status, events.at(-1).text], ['result', 'failed', 'step cap reached without an answer']);
});

// A write worker edits its isolated copy; the real checkout it was copied from is fenced by the OS, so an
// absolute path back into it fails loudly instead of silently bypassing integration and review.
test('a fenced write worker writes its copy and anything else, but not the original checkout', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS sandbox-exec only');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fence-copy-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fence-source-'));
  t.after(() => { fs.rmSync(copy, {recursive: true, force: true}); fs.rmSync(source, {recursive: true, force: true}); });
  const policy = writeFenceSandbox(source);
  const code = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(copy, 'edit.txt'))}, 'work'); try { fs.writeFileSync(${JSON.stringify(path.join(source, 'leak.txt'))}, 'bad'); process.exit(2); } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error; }`;
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, '--input-type=module', '-e', code], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(copy, 'edit.txt'), 'utf8'), 'work');
  assert.equal(fs.existsSync(path.join(source, 'leak.txt')), false);
  // the adapter launches a write worker with a fence through sandbox-exec, and it still edits its copy
  const {cwd, dir} = setup(t, {FAKE_OC_WRITE: 'src/fenced.txt:ok'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t17', profile: profileFor({policy: 'write', writeFence: source}), orders: 'write it', cwd, dir});
  assert.equal(handle.args[0], '-p');
  await drain(adapter, handle);
  assert.equal(fs.readFileSync(path.join(cwd, 'src/fenced.txt'), 'utf8'), 'ok');
});

// Found live (ACE 43387649): opencode hit maxSteps 60 with no runtime notice in the stream — the turn just
// ended after 60 finished steps, the model's own "## Maximum Steps Reached" heading the only text. The cap
// went unrecorded, so bounce's step renewal (scheduler) never fired. The step count is the signal.
test('a turn that used its whole step budget is a step cap even when opencode prints no notice', async t => {
  const {cwd, dir} = setup(t, {FAKE_OC_SCENARIO: 'capsilent', FAKE_OC_STEPS: '4'});
  const adapter = createOpencodeLive({});
  const handle = await adapter.launch({peer: 'worker:t16', profile: profileFor({policy: 'read-only', agent: {name: 'builder', prompt: 'You build.', maxSteps: 4}}), orders: 'do it', cwd, dir});
  const events = await drain(adapter, handle);
  assert.equal(events.filter(e => e.kind === 'diagnostic' && e.reason === 'step_cap').length, 1);
});
