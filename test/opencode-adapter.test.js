// OpenCode as a classic provider (docs/plans/classic-conversation.md §4): the one-shot adapter that lets a
// local LM Studio model be the agent answering the conversation, ordered and picked like claude or codex.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {invocation, normalize, runProcess, providerEnv, requiresModel, canResume} from '../src/providers.js';
import {adapters} from '../src/adapters/index.js';
import opencode, {splitPin} from '../src/adapters/opencode.js';
import {queryCatalog, modelEntries, catalogNotes} from '../src/models.js';
import {Session, Router, defaults, validateSettings} from '../src/core.js';

const settings = {local: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', contextTokens: 131072}}}};
// Which opencode is installed must not decide these tests: each binary name answers its own major.
const realVersionOf = opencode.versionOf;
opencode.versionOf = executable => (executable === 'opencode-v2' ? {version: '2.0.29', major: 2} : {version: '1.18.31', major: 1});
test.after(() => { opencode.versionOf = realVersionOf; });

test('opencode is a classic provider: registered, resumable, needs a model, result is the exit', () => {
  assert.equal(adapters.opencode, opencode);
  assert.equal(canResume('opencode'), true);
  assert.equal(requiresModel('opencode'), true);
  assert.equal(requiresModel('claude'), false);
  assert.equal(opencode.login, null, 'a local model has nothing to sign in to');
  assert.doesNotThrow(() => validateSettings({...defaults(), order: ['opencode', 'claude']}));
  assert.throws(() => validateSettings({...defaults(), order: ['other']}), /claude, codex, muse, opencode/);
});

test('the pin is <endpoint>/<model>, the invocation is the worker runtime\'s command with -s to continue', () => {
  assert.deepEqual(splitPin('lmstudio/qwen3-coder-30b'), {endpoint: 'lmstudio', model: 'qwen3-coder-30b'});
  assert.deepEqual(splitPin('qwen3-coder-30b'), {endpoint: 'lmstudio', model: 'qwen3-coder-30b'});
  assert.deepEqual(invocation('opencode', {model: 'lmstudio/qwen3-coder-30b', mode: 'yolo', cwd: '/w'}),
    ['run', '--pure', '--format', 'json', '--agent', 'bounce', '-m', 'lmstudio/qwen3-coder-30b', '--dir', '/w']);
  assert.deepEqual(invocation('opencode', {model: 'lmstudio/qwen3-coder-30b', mode: 'plan', cwd: '/w', resume: 'ses_1'}),
    ['run', '--pure', '--format', 'json', '--agent', 'bounce', '-m', 'lmstudio/qwen3-coder-30b', '--dir', '/w', '-s', 'ses_1']);
});

test('the env carries the OpenCode config: the endpoint as a provider, one agent whose tools follow the mode, no Claude Code leakage', () => {
  const yolo = providerEnv('opencode', {model: 'lmstudio/qwen3-coder-30b', mode: 'yolo', settings});
  const config = JSON.parse(yolo.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.provider.lmstudio.options.baseURL, 'http://127.0.0.1:1234/v1');
  assert.equal(config.provider.lmstudio.models['qwen3-coder-30b'].limit.context, 131072);
  assert.equal(config.agent.bounce.mode, 'primary');
  assert.deepEqual([config.agent.bounce.tools.read, config.agent.bounce.tools.edit, config.agent.bounce.tools.bash, config.agent.bounce.tools.task], [true, true, true, false]);
  assert.equal(config.permission.external_directory, 'allow');
  assert.equal('mcp' in config, false, 'classic has no bus');
  for (const key of ['OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_PROJECT_CONFIG']) assert.equal(yolo[key], '1');
  const plan = JSON.parse(providerEnv('opencode', {model: 'lmstudio/qwen3-coder-30b', mode: 'plan', settings}).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual([plan.agent.bounce.tools.read, plan.agent.bounce.tools.edit, plan.agent.bounce.tools.bash], [true, false, false]);
  assert.deepEqual(providerEnv('claude', {model: 'fable', mode: 'yolo', settings}), {}, 'the vendors take everything on argv');
  assert.throws(() => providerEnv('opencode', {model: 'elsewhere/m', mode: 'yolo', settings}), /Unknown local endpoint elsewhere/);
});

test('on opencode 2.x the invocation is a private server with no --dir or --pure, and the env carries 2.x\'s config and the directory as PWD', () => {
  assert.deepEqual(invocation('opencode', {model: 'lmstudio/qwen3-coder-30b', mode: 'plan', cwd: '/w', resume: 'ses_1', executable: 'opencode-v2'}),
    ['run', '--standalone', '--format', 'json', '--agent', 'bounce', '-m', 'lmstudio/qwen3-coder-30b', '-s', 'ses_1']);
  const env = providerEnv('opencode', {model: 'lmstudio/qwen3-coder-30b', mode: 'plan', settings, cwd: '/w', executable: 'opencode-v2'});
  assert.equal(env.PWD, '/w');
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.providers.lmstudio.settings.baseURL, 'http://127.0.0.1:1234/v1');
  assert.equal('provider' in config, false, 'the 1.x shape is not sent to 2.x');
  const denied = config.agents.bounce.permissions.filter(rule => rule.effect === 'deny').map(rule => rule.action);
  for (const action of ['execute', 'edit', 'write', 'patch', 'shell', 'subagent']) assert.ok(denied.includes(action), `plan denies ${action}`);
  assert.equal(config.agents.bounce.permissions.some(rule => rule.action === 'read'), false, 'reads stay allowed');
  assert.equal('PWD' in providerEnv('opencode', {model: 'lmstudio/qwen3-coder-30b', mode: 'plan', settings, cwd: '/w'}), false, '1.x takes --dir');
});

test('normalize: text is the answer, tool_use the call, step_finish the tokens, sessionID the thread once', () => {
  const sid = 'ses_normalize_test';
  assert.deepEqual(normalize('opencode', {type: 'text', sessionID: sid, part: {text: 'Red, blue, green.'}}),
    [{kind: 'assistant', text: 'Red, blue, green.'}, {kind: 'peer.native', provider: 'opencode', sessionId: sid}]);
  assert.deepEqual(normalize('opencode', {type: 'text', sessionID: sid, part: {text: '   '}}), [], 'the id is announced once, blank text is nothing');
  assert.deepEqual(normalize('opencode', {type: 'tool_use', sessionID: sid, part: {tool: 'read', state: {status: 'running', input: {filePath: 'src/a.js'}}}}), [], 'a running call is not yet a row');
  assert.deepEqual(normalize('opencode', {type: 'tool_use', sessionID: sid, part: {tool: 'read', state: {status: 'completed', input: {filePath: 'src/a.js'}}}}), [{kind: 'tool', text: 'read src/a.js'}]);
  const bash = normalize('opencode', {type: 'tool_use', sessionID: sid, part: {tool: 'bash', state: {status: 'completed', input: {command: 'npm test'}, output: 'ok\n1 passed', metadata: {exit: 0}}}});
  assert.equal(bash.length, 1);
  assert.match(bash[0].text, /^bash npm test\n/);
  assert.match(bash[0].text, /1 passed/);
  assert.deepEqual(normalize('opencode', {type: 'tool_use', sessionID: sid, part: {tool: 'edit', state: {status: 'error', input: {filePath: 'x'}, error: 'denied'}}}), [{kind: 'tool', text: 'edit x · error\ndenied'}]);
  assert.deepEqual(normalize('opencode', {type: 'step_finish', sessionID: sid, part: {tokens: {input: 1200, output: 40, cache: {read: 1000, write: 0}}}}),
    [{kind: 'usage', text: '{"input":1200,"cache_read":1000,"cache_write":0,"output":40}', usage: {input: 1200, cache_read: 1000, cache_write: 0, output: 40}}]);
  assert.deepEqual(normalize('opencode', {type: 'step_start', sessionID: sid, part: {}}), []);
  assert.deepEqual(normalize('opencode', {type: 'error', sessionID: sid, error: {data: {message: 'model not found'}}}), [{kind: 'error', text: 'model not found'}]);
});

test('runProcess: with no result line the exit is the result — the last answer on 0, a failure otherwise', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-opencode-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const script = path.join(dir, 'fake-opencode.mjs');
  fs.writeFileSync(script, `
    const code = Number(process.argv[2]);
    process.stdout.write(JSON.stringify({type: 'text', sessionID: 'ses_exit_' + code, part: {text: 'first'}}) + '\\n');
    process.stdout.write(JSON.stringify({type: 'text', sessionID: 'ses_exit_' + code, part: {text: 'the answer'}}) + '\\n');
    process.stdout.write(JSON.stringify({type: 'step_finish', sessionID: 'ses_exit_' + code, part: {tokens: {input: 10, output: 2}}}) + '\\n');
    process.exit(code);
  `);
  const run = code => new Promise(resolve => {
    const events = [];
    runProcess({provider: 'opencode', executable: process.execPath, args: [script, String(code)], prompt: 'hi', cwd: dir, emit: e => events.push(e)}).then(result => resolve({result, events}));
  });
  const ok = await run(0);
  assert.equal(ok.result.status, 'completed');
  assert.deepEqual(ok.events.filter(e => e.kind === 'result'), [{kind: 'result', text: 'the answer', success: true}]);
  assert.deepEqual(ok.events.filter(e => e.kind === 'peer.native').map(e => e.sessionId), ['ses_exit_0']);
  const bad = await run(3);
  assert.equal(bad.result.status, 'failed');
  assert.deepEqual(bad.events.filter(e => e.kind === 'result'), [{kind: 'result', text: 'opencode exited 3', success: false}]);
});

test('the picker lists what LM Studio reports, loaded first, pinned as endpoint/id, and has no default row', async () => {
  const discover = async () => [{provider: 'local', endpoint: 'lmstudio', models: [
    {id: 'qwen3-8b', ready: null, tools: true}, {id: 'qwen3-coder-30b', ready: true, tools: true}, {id: 'gemma-chat', ready: true, tools: false}], error: null}];
  const catalog = await queryCatalog('opencode', 'opencode', {settings, discover});
  assert.deepEqual(catalog, {provider: 'opencode', account: null, error: null, models: [
    {id: 'lmstudio/qwen3-coder-30b', label: 'qwen3-coder-30b', description: 'lmstudio · loaded'},
    {id: 'lmstudio/qwen3-8b', label: 'qwen3-8b', description: 'lmstudio · loads on demand'}]});
  const entries = modelEntries([catalog], {order: ['opencode'], models: {opencode: 'lmstudio/qwen3-8b'}});
  assert.deepEqual(entries.map(e => [e.id, e.current]), [['lmstudio/qwen3-coder-30b', false], ['lmstudio/qwen3-8b', true]]);
  const empty = await queryCatalog('opencode', 'opencode', {settings, discover: async () => [{provider: 'local', endpoint: 'lmstudio', models: [], error: 'connection refused'}]});
  assert.equal(empty.error, 'lmstudio: connection refused');
  assert.deepEqual(catalogNotes([empty]), ['opencode: lmstudio: connection refused · start LM Studio and load a model, or /local setup']);
  const off = await queryCatalog('opencode', 'opencode', {settings: {local: {enabled: false}}, discover});
  assert.equal(off.error, 'local models are off (/local on)');
});

test('Router: opencode without a model is skipped with a note; with one it runs in the workspace and continues its session', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-test-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const attempts = [];
  const runner = async options => {
    attempts.push(options);
    options.emit({kind: 'peer.native', provider: options.provider, sessionId: `${options.provider}-ses`});
    options.emit({kind: 'assistant', text: 'hi'});
    options.emit({kind: 'result', text: 'hi', success: true});
    return {status: 'completed'};
  };
  const unpinned = new Router(session, {...defaults(), order: ['opencode', 'claude'], ...settings}, {runner});
  assert.equal(await unpinned.run('hi'), 'completed');
  assert.equal(attempts[0].provider, 'claude');
  assert.match(session.events.find(e => e.kind === 'status' && e.provider === 'opencode').text, /opencode needs a model: \/model to pick one/);
  const pinned = new Router(session, {...defaults(), order: ['opencode', 'claude'], models: {opencode: 'lmstudio/qwen3-coder-30b'}, ...settings}, {runner});
  pinned.select('opencode');
  assert.equal(await pinned.run('and on the local model?'), 'completed');
  const local = attempts[1];
  assert.equal(local.provider, 'opencode');
  assert.deepEqual(local.args.slice(local.args.indexOf('--dir'), local.args.indexOf('--dir') + 2), ['--dir', session.cwd]);
  assert.equal(JSON.parse(local.env.OPENCODE_CONFIG_CONTENT).agent.bounce.mode, 'primary');
  assert.match(local.prompt, /Recent history/, 'a change of provider: the packet');
  await pinned.run('still you?');
  assert.deepEqual(attempts[2].args.slice(-2), ['-s', 'opencode-ses']);
  assert.equal(attempts[2].prompt, 'still you?');
});

// Found in the real-console pass 2026-10-21: an embedding model (tools unknown) was offered as a model to talk to.
test('the picker leaves out embedding models, which cannot hold a conversation', async () => {
  const discover = async () => [{provider: 'local', endpoint: 'lmstudio', models: [
    {id: 'qwen3-8b', ready: true, tools: true, type: 'llm'}, {id: 'text-embedding-nomic-embed-text-v1.5', ready: null, tools: null, type: 'embedding'}], error: null}];
  const catalog = await queryCatalog('opencode', 'opencode', {settings, discover});
  assert.deepEqual(catalog.models.map(m => m.id), ['lmstudio/qwen3-8b']);
});
