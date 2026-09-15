import test from 'node:test';
import assert from 'node:assert/strict';
import {createFormatter} from '../src/format.js';
import {conversationEvents} from '../src/tui/transcript.js';

const answer = '## LocalWorker bridge test — passed\n\n**Verified:** `cleartasks-web`\n\n- No edits\n- No version field';
const events = [
  {id: '1', kind: 'task.submitted', task: 'task-one', profile: 'LocalWorker'},
  {id: '2', kind: 'task.started', task: 'task-one', requested: 'qwen', time: '2026-09-14T00:00:00Z'},
  {id: '3', kind: 'task.observed', task: 'task-one', text: 'Using search'},
  {id: '4', kind: 'task.reported', task: 'task-one', summary: 'Worker report'},
  {id: '5', kind: 'task.completed', task: 'task-one', summary: 'Worker report', time: '2026-09-14T00:00:03.700Z'},
  {id: '6', kind: 'assistant', provider: 'claude', text: answer},
  {id: '7', kind: 'main.terminal', status: 'completed', text: answer},
];

test('conversation shows one answer and one worker outcome, with expandable mechanics', () => {
  const formatter = createFormatter({color: false, compact: true});
  const rows = conversationEvents(events);
  const text = rows.flatMap(row => formatter.event(row, 90)).join('\n');
  assert.equal(text.split('LocalWorker bridge test — passed').length - 1, 1);
  assert.doesNotMatch(text, /\*\*|##|Using search/);
  assert.match(text, /LocalWorker · completed · qwen · 3.7s/);
  assert.equal(rows.filter(row => row.kind === 'task.fold').length, 1);
  assert.equal(conversationEvents(events, {details: true}).some(row => row.kind === 'task.observed'), true);
  assert.equal(events[6].text, answer, 'journal content stays intact');
});

test('a terminal-only answer is retained and rendered as Markdown', () => {
  const rows = conversationEvents([events[6]]);
  const text = rows.flatMap(row => createFormatter({color: false}).event(row, 80)).join('\n');
  assert.match(text, /Verified: cleartasks-web/);
  assert.doesNotMatch(text, /\*\*|##/);
});

test('worker failures remain visible and separate turns may repeat the same answer', () => {
  const rows = conversationEvents([
    ...events,
    {kind: 'user', text: 'Repeat that'},
    {...events[6], id: '8'},
    {id: '9', kind: 'task.failed', task: 'bad', reason: 'missing', text: 'Worker executable missing'},
  ]);
  assert.equal(rows.filter(row => row.kind === 'assistant').length, 2);
  assert.match(rows.find(row => row.task === 'bad').preview, /Worker executable missing/);
});
