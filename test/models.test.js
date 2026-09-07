import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {queryCatalog, modelEntries, catalogNotes} from '../src/models.js';
import {modelRows, windowAround} from '../src/terminal.js';

const fake = script => (executable, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => {child.killed = true;};
  const requests = [];
  child.stdin.on('data', chunk => {for (const line of String(chunk).split('\n')) if (line) requests.push(JSON.parse(line));});
  setTimeout(() => script(child, {executable, args, requests}), 5);
  return child;
};
const reply = (child, ...rows) => {for (const row of rows) child.stdout.write(JSON.stringify(row) + '\n');};

test('each agent reports its own catalog over its own protocol', async () => {
  const claude = await queryCatalog('claude', 'claude', {spawn: fake((child, {args, requests}) => {
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(requests[0].request.subtype, 'initialize');
    reply(child, {type: 'control_response', response: {request_id: 'bounce-models', response: {
      account: {email: 'user@example.com'},
      models: [{value: 'default', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context'},
        {value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5'}]}}});
  })});
  assert.equal(claude.account, 'user@example.com');
  assert.equal(claude.error, null);
  assert.deepEqual(claude.models, [
    {id: 'default', label: 'Default (recommended)', description: 'Opus 5 with 1M context'},
    {id: 'haiku', label: 'Haiku', description: 'claude-haiku-4-5'}]);

  const codex = await queryCatalog('codex', '/apps/codex', {spawn: fake((child, {requests}) => {
    assert.deepEqual(requests.map(r => r.method), ['initialize', 'initialized', 'account/read', 'model/list']);
    reply(child, {id: 1, result: {}},
      {id: 3, result: {data: [{id: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Most capable'},
        {id: 'secret', displayName: 'Hidden', hidden: true}]}},
      {id: 2, result: {account: {email: 'user@example.com', planType: 'plus'}}});
  })});
  assert.deepEqual(codex.models, [{id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Most capable'}]);
  assert.equal(codex.account, 'user@example.com');

  const muse = await queryCatalog('muse', 'muse', {spawn: fake(child => reply(child,
    {jsonrpc: '2.0', id: 2, result: {providerId: 'meta', profileId: 'tbh',
      models: [{modelId: 'muse-spark-1.3', displayLabel: 'muse-spark-1.3', description: null}]}}))});
  assert.equal(muse.account, 'meta/tbh');
  assert.deepEqual(muse.models, [{id: 'muse-spark-1.3', label: 'muse-spark-1.3', description: ''}]);
});

test('a missing, silent or failing agent is reported instead of hiding the others', async () => {
  const missing = await queryCatalog('codex', 'codex', {spawn: fake(child => child.emit('error', Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'})))});
  assert.deepEqual([missing.models, missing.error], [[], 'codex CLI not installed']);

  const failed = await queryCatalog('muse', 'muse', {spawn: fake(child => {
    child.stderr.write('not signed in\n');
    setTimeout(() => child.emit('close', 1), 10);
  })});
  assert.equal(failed.error, 'not signed in');

  const silent = await queryCatalog('claude', 'claude', {timeout: 30, spawn: fake(() => {})});
  assert.equal(silent.error, 'claude did not answer in time');
  assert.equal((await queryCatalog('other', 'other', {spawn: fake(() => {})})).error, 'Unknown provider: other');
});

test('entries follow the fallback order, list a default per agent and mark the saved model', () => {
  const catalogs = [
    {provider: 'claude', account: 'user@example.com', models: [{id: 'haiku', label: 'Haiku', description: 'Fastest'}], error: null},
    {provider: 'codex', account: null, models: [], error: 'codex CLI not installed'},
    {provider: 'muse', account: 'meta/tbh', models: [{id: 'muse-spark-1.3', label: 'muse-spark-1.3', description: ''}], error: null},
  ];
  const entries = modelEntries(catalogs, {order: ['muse', 'claude', 'codex'], models: {claude: 'haiku'}});
  assert.deepEqual(entries.map(e => [e.provider, e.id, e.current]), [
    ['muse', '', true], ['muse', 'muse-spark-1.3', false], ['claude', '', false], ['claude', 'haiku', true]]);
  assert.equal(entries[0].description, 'Signed in as meta/tbh');
  assert.equal(entries[3].description, 'Fastest');
  assert.deepEqual(catalogNotes(catalogs), ['codex: codex CLI not installed · try /login codex']);
  assert.deepEqual(modelEntries([], {}), []);
});

test('the picker keeps its selection visible and never overflows the row width', () => {
  const entries = [{provider: 'claude', label: 'Provider default', description: 'The CLI picks the model', current: true},
    {provider: 'claude', label: 'Haiku', description: 'Fastest\nfor quick answers', current: false}];
  const rows = modelRows(entries, 1, 60);
  assert.deepEqual(rows, [
    '   1. claude · Provider default ✓ The CLI picks the model',
    '›  2. claude · Haiku              Fastest for quick answers']);
  assert.ok(modelRows(entries, 0, 20).every(row => row.length <= 20));
  assert.deepEqual(windowAround(10, 8, 4), {start: 6, end: 10});
  assert.deepEqual(windowAround(10, 0, 4), {start: 0, end: 4});
  assert.deepEqual(windowAround(3, 2, 9), {start: 0, end: 3});
  assert.deepEqual(windowAround(0, 0, 5), {start: 0, end: 0});
});
