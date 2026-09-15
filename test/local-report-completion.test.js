import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalLive} from '../src/adapters/local-live.js';

test('valid final report completes without another inference and includes observed publication evidence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-report-completion-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  let turns = 0, accepted;
  const backend = {health: async () => true, async *generate({tools}) {
    turns++;
    assert.equal(turns, 1, 'final report must end the worker turn');
    const report = tools.find(tool => tool.name === 'bounce_report');
    assert.deepEqual(report.parameters.properties.op.enum, ['milestone', 'blocked', 'input_required', 'final']);
    assert.ok(report.parameters.properties.outcome.enum.includes('completed'));
    yield {kind: 'tool_call', id: 't', name: 'run_command', arguments: {command: 'node --test'}};
    yield {kind: 'tool_call', id: 'r', name: 'bounce_report', arguments: {op: 'final', outcome: 'completed', phase: 'done', text: 'Done', next: 'accept', summary: 'Fixed', evidence: []}};
  }};
  const adapter = createLocalLive({backends: {test: backend}, runtimeFactory: () => ({prepare: async () => ({
    execute: async () => '# pass 1', finish: async () => ({verified: true, changes: ['value.js']}), cancel: async () => ({verified: true}),
  })})});
  const handle = await adapter.launch({cwd: dir, dir, orders: 'test', profile: {backend: 'test', policy: 'write', mode: 'yolo'}, report: async value => {accepted = value.report;}});
  const events = [];
  for await (const event of adapter.events(handle)) events.push(event);
  assert.equal(events.at(-1).status, 'completed', events.at(-1).text);
  assert.equal(turns, 1);
  assert.ok(accepted.evidence.some(item => item.includes('value.js')));
  assert.ok(accepted.evidence.some(item => item.includes('node --test') && item.includes('exit=0')));
  await adapter.cancel(handle);
});
