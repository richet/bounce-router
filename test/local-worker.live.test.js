import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {validateOrchestration} from '../src/profiles.js';
import {createScheduler} from '../src/scheduler.js';
import {createLocalAdmission} from '../src/local-admission.js';
import {createLocalLive} from '../src/adapters/local-live.js';
import {createLocalRuntime} from '../src/local-runtime.js';

const enabled = process.env.BOUNCE_LIVE_DOCKER === '1';
const report = {op: 'final', outcome: 'completed', summary: 'Corrected value and passed tests', phase: 'verified', text: 'node --test value.test.js passed', next: 'parent acceptance', evidence: ['value.js', 'node --test value.test.js']};
const call = (id, name, args) => ({index: Number(id), id, type: 'function', function: {name, arguments: JSON.stringify(args)}});

test('live container composed worker edits, observes failure, fixes, tests and reports to parent', {skip: !enabled, timeout: 120000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-local-worker-live-'));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(cwd, 'value.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(cwd, 'value.test.js'), "import {value} from './value.js'; import assert from 'node:assert/strict'; assert.equal(value, 2);\n");
  await fs.writeFile(path.join(cwd, 'user.txt'), 'existing dirty work\n');
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const session = new Session(cwd, {root: path.join(root, 'sessions')});
  let requests = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/v1/models')) return Response.json({data: []});
    const input = JSON.parse(options.body);
    assert.equal(input.model, 'fixture-instance');
    requests++;
    let calls;
    if (requests === 1) calls = [call('1', 'read_file', {path: 'value.js'}), call('2', 'run_command', {command: 'node --test value.test.js'})];
    if (requests === 2) {
      assert.match(input.messages.at(-1).content, /COMMAND_FAILED.*exit=1/s);
      calls = [call('3', 'patch_file', {path: 'value.js', old: 'value = 1', new: 'value = 2'}), call('4', 'run_command', {command: 'node --test value.test.js'})];
    }
    if (requests === 3) {
      assert.match(input.messages.at(-1).content, /# pass 1/);
      calls = [call('5', 'bounce_report', {...report, op: 'milestone'}), call('6', 'bounce_report', report)];
    }
    const frame = {choices: [{delta: calls ? {tool_calls: calls} : {content: 'Complete'}, finish_reason: calls ? 'tool_calls' : 'stop'}]};
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}});
  };
  const catalogs = [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [{id: 'fixture', ref: 'lmstudio/fixture', type: 'llm', tools: true, ready: true, instances: [{id: 'fixture-instance', context: 32768}]}]}];
  const view = validateOrchestration({operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', profiles: {
    main: {adapter: 'claude'}, worker: {adapter: 'local', policy: 'write', model: 'fixture', writePaths: ['value.js'], commands: ['node --test value.test.js']},
  }});
  const adapter = createLocalLive({fetchImpl, runtimeFactory: () => createLocalRuntime()});
  const scheduler = createScheduler({session, adapters: {local: adapter}, profiles: view.profiles, requireFinalReport: true,
    localAdmission: createLocalAdmission({discover: async () => catalogs})});
  t.after(async () => {await scheduler.stop(); scheduler.close();});
  const completed = new Promise(resolve => session.subscribe(row => {
    if (['task.completed', 'task.failed', 'task.blocked'].includes(row.kind)) resolve(row);
  }));
  const task = scheduler.submit({profile: 'worker', orders: 'Correct value; run tests and report', deadline: 100000, budget: {starts: 1}});
  const result = await completed;
  assert.equal(result.kind, 'task.completed', result.text);
  assert.equal(result.task, task.task);
  assert.equal(requests, 3);
  assert.equal(await fs.readFile(path.join(cwd, 'value.js'), 'utf8'), 'export const value = 2;\n');
  assert.equal(await fs.readFile(path.join(cwd, 'user.txt'), 'utf8'), 'existing dirty work\n');
  assert.equal(session.events.filter(row => row.kind === 'task.reported').length, 1);
});
