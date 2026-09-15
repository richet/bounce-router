import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalLive} from '../src/adapters/local-live.js';

test('failed test command returns evidence to the worker so it can fix and retest', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-tool-recovery-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  let turn = 0;
  const backend = {health: async () => true, async *generate({messages}) {
    turn++;
    if (turn === 1) yield {kind: 'tool_call', id: 'test', name: 'run_command', arguments: {command: 'node --test'}};
    else {
      assert.match(messages.at(-1).content, /COMMAND_FAILED.*exit=1.*expected 2/s);
      yield {kind: 'done', text: 'Observed failure; can correct it'};
    }
  }};
  const adapter = createLocalLive({backends: {test: backend}, runtimeFactory: () => ({prepare: async () => ({
    execute: async () => {throw Object.assign(new Error('command exited 1'), {code: 'COMMAND_FAILED', status: 1, result: 'expected 2'});},
    finish: async () => ({verified: true}), cancel: async () => ({verified: true}),
  })})});
  const handle = await adapter.launch({cwd: dir, dir, orders: 'test', profile: {backend: 'test', policy: 'write', mode: 'yolo'}});
  const events = [];
  for await (const event of adapter.events(handle)) events.push(event);
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(turn, 2);
  assert.deepEqual(await adapter.cancel(handle), {verified: true});
});
