// One vendor process per conversation instead of one per turn (docs/ARCHITECTURE.md § Classic mode, behind
// keepProcess): the process stays alive between turns, and is replaced (resuming the same thread) when what it was
// launched with changes.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConversations} from '../src/conversation.js';

const fake = fileURLToPath(new URL('./helpers/fake-claude-stream.js', import.meta.url));
const setup = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-conversation-'));
  const conversations = createConversations();
  t.after(() => { conversations.closeAll(); fs.rmSync(dir, {recursive: true, force: true}); });
  const launches = () => fs.existsSync(path.join(dir, 'args')) ? fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const turn = (prompt, {args = ['-p', '--model', 'sonnet'], env = {}, signal} = {}) => {
    const events = [];
    return conversations.turn({provider: 'claude', executable: fake, args, prompt, cwd: dir, env: {FAKE_ARGS: path.join(dir, 'args'), ...env}, signal, emit: event => events.push(event)})
      .then(result => ({result, events, answer: events.filter(e => e.kind === 'delta').map(e => e.text).join('')}));
  };
  return {dir, turn, launches};
};

test('two turns go to the same process; its arguments ask for stream-json input', async t => {
  const {turn, launches} = setup(t);
  const first = await turn('hello');
  const second = await turn('again');
  assert.equal(first.result.status, 'completed');
  assert.equal(second.result.status, 'completed');
  const pid = /^pid (\d+) turn 1: hello$/.exec(first.answer)?.[1];
  assert.ok(pid, first.answer);
  assert.equal(second.answer, `pid ${pid} turn 2: again`);
  assert.equal(launches().length, 1);
  assert.deepEqual(launches()[0].slice(-2), ['--input-format', 'stream-json']);
});

test('a change in what the process was launched with replaces it, resuming the thread', async t => {
  const {turn, launches} = setup(t);
  const first = await turn('one');
  const second = await turn('two', {args: ['-p', '--model', 'opus', '--resume', 'sess-x']});
  assert.notEqual(second.answer.split(' ')[1], first.answer.split(' ')[1], 'another process answered');
  assert.equal(second.answer.split(': ')[0].endsWith('turn 1'), true);
  assert.deepEqual(launches().map(args => args.includes('--resume')), [false, true]);
  const third = await turn('three', {args: ['-p', '--model', 'opus', '--resume', 'sess-y']});
  assert.equal(third.answer.split(' ')[1], second.answer.split(' ')[1], 'a different thread id alone does not relaunch a live process');
});

test('a process that dies mid-turn fails that turn and the next turn starts a new one', async t => {
  const {turn, launches} = setup(t);
  const failed = await turn('boom', {env: {FAKE_FAIL_ON: '1'}});
  assert.equal(failed.result.status, 'failed');
  const next = await turn('fine');
  assert.equal(next.result.status, 'completed');
  assert.match(next.answer, /turn 1: fine$/);
  assert.equal(launches().length, 2);
});

test('cancelling a turn ends it as cancelled and the next turn starts a new process', async t => {
  const {turn, launches} = setup(t);
  await turn('warm');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await turn('stop', {signal: controller.signal});
  assert.equal(cancelled.result.status, 'cancelled');
  const after = await turn('go');
  assert.match(after.answer, /turn 1: go$/);
  assert.equal(launches().length, 2);
});
