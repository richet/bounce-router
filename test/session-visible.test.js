// What makes a session and a wake readable at a glance: its name in the terminal title, and one line saying why bounce
// started an orchestrator turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowTitle} from '../src/window-title.js';
import {conversationEvents} from '../src/tui/transcript.js';

test('the terminal title names the session, is written only on a change, and is cleared on exit', () => {
  const written = [];
  const stream = {isTTY: true, write: chunk => written.push(chunk)};
  const title = createWindowTitle({stream, env: {}});
  title('nightly-integration');
  title('nightly-integration');
  title('renamed\nsession');
  title(null);
  assert.deepEqual(written, ['\x1b]2;bounce · nightly-integration\x07', '\x1b]2;bounce · renamed session\x07', '\x1b]2;\x07']);
  const piped = [];
  createWindowTitle({stream: {isTTY: false, write: chunk => piped.push(chunk)}, env: {}})('x');
  createWindowTitle({stream: {isTTY: true, write: chunk => piped.push(chunk)}, env: {TERM: 'dumb'}})('x');
  assert.deepEqual(piped, [], 'never into a pipe or a dumb terminal');
});

test('a wake turn opens with one line naming what woke the orchestrator; the hand-off text stays out of the folded view', () => {
  const events = [
    {seq: 1, kind: 'task.submitted', task: 'gate', from: 'orchestrator', profile: 'analyst'},
    {seq: 2, kind: 'task.failed', task: 'gate', reason: 'check_failed', text: 'lint failed'},
    {seq: 3, kind: 'task.submitted', task: 'a1b2c3d4-e5f6-4711-8000-000000000000', from: 'orchestrator', profile: 'analyst'},
    {seq: 4, kind: 'task.input_required', task: 'a1b2c3d4-e5f6-4711-8000-000000000000', questions: ['Which branch?']},
    {seq: 5, kind: 'main.requested', wake: true, time: '2026-11-11T22:00:00Z'},
    {seq: 6, kind: 'handoff', wake: true, actionIds: ['outcome:2', 'outcome:4'], outcomeSeqs: [2, 4], tasks: ['gate', 'a1b2c3d4-e5f6-4711-8000-000000000000'], text: 'Worker outcomes not yet handed to you…', time: '2026-11-11T22:00:00Z'},
    {seq: 7, kind: 'assistant', from: 'main', text: 'Resubmitting the gate.'},
    {seq: 8, kind: 'main.requested', wake: true, checkIn: true, time: '2026-11-11T22:15:00Z'},
    {seq: 9, kind: 'handoff', wake: true, checkIn: true, tasks: ['desk-plan'], actionIds: [], text: 'bounce check-in: …', time: '2026-11-11T22:15:00Z'},
  ];
  const status = conversationEvents(events).filter(row => row.kind === 'status').map(row => row.text);
  assert.deepEqual(status, [
    'bounce woke the orchestrator: gate failed (check_failed), a1b2c3d4 asks for input',
    'bounce checked in with the orchestrator: work waits on it and nothing had woken it',
  ]);
  assert.equal(conversationEvents(events).some(row => row.kind === 'handoff'), false);
});
