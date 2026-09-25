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

test('a result that repeats the answer, or only says the turn completed, is not shown twice', () => {
  const rows = conversationEvents([
    events[5], {id: 'r1', kind: 'result', success: true, text: answer},
    {kind: 'user', text: 'Again'}, {id: 'a2', kind: 'assistant', provider: 'codex', text: 'Sure.'}, {id: 'r2', kind: 'result', success: true, text: 'Turn completed'},
    {id: 'r3', kind: 'result', success: false, text: 'protocol error: claude exited without result'},
  ]);
  assert.deepEqual(rows.map(row => row.kind), ['assistant', 'user', 'assistant', 'result']);
  assert.equal(conversationEvents([events[5], {id: 'r1', kind: 'result', success: true, text: answer}], {details: true}).length, 2);
});

test('streamed deltas read as one answer block and the result that repeats them is dropped', () => {
  const rows = conversationEvents([
    {id: 'd1', kind: 'delta', provider: 'muse', text: 'Hi'}, {id: 'd2', kind: 'delta', provider: 'muse', text: ' — picked'}, {id: 'd3', kind: 'delta', provider: 'muse', text: ' up'},
    {id: 'r', kind: 'result', success: true, text: 'Hi — picked up'},
  ]);
  assert.deepEqual(rows.map(row => [row.kind, row.id, row.text]), [['delta', 'd1+3', 'Hi — picked up']]);
  assert.equal(conversationEvents([{id: 'd1', kind: 'delta', provider: 'muse', text: 'Hi'}, {id: 'd2', kind: 'delta', provider: 'muse', text: '!'}], {details: true}).length, 2);
});

test('a run of progress readings for the same thing collapses to its latest value', () => {
  const tick = (id, text, provider = 'claude') => ({id, kind: 'progress', provider, text});
  const rows = conversationEvents([
    tick('p1', 'Thinking · ~50 tokens'), tick('p2', 'Thinking · ~150 tokens'),
    {id: 'm1', kind: 'model', provider: 'claude', model: 'claude-opus-5'},
    tick('p3', 'Thinking · ~265 tokens'),
    tick('p4', 'Bash · 2s'), tick('p5', 'Bash · 5s'),
    tick('p6', 'Thinking · ~40 tokens'),
    tick('p7', 'Thinking · ~90 tokens', 'codex'),
  ]);
  // Same label, same provider → one row in the first reading's place, id moving with each tick
  // so the cached rendering is replaced; a model report between readings does not split the run.
  assert.deepEqual(rows.map(row => [row.id, row.text]), [
    ['p1+3', 'Thinking · ~265 tokens'], ['p4+2', 'Bash · 5s'], ['p6', 'Thinking · ~40 tokens'], ['p7', 'Thinking · ~90 tokens'],
  ]);
  assert.equal(conversationEvents([tick('p1', 'Thinking · ~50 tokens'), tick('p2', 'Thinking · ~150 tokens')], {details: true}).length, 1);
});

test('a terminal-only answer is retained and rendered as Markdown', () => {
  const rows = conversationEvents([events[6]]);
  const text = rows.flatMap(row => createFormatter({color: false}).event(row, 80)).join('\n');
  assert.match(text, /Verified: cleartasks-web/);
  assert.doesNotMatch(text, /\*\*|##/);
});

// The routine "your own copy is kept" skill-sync line is a no-op, not something to surface as
// top-level Activity — but it stays in /details and in the journal (session.events unchanged).
test('a skills-sync status row that is entirely routine no-ops is folded out of the default view but kept in /details', () => {
  const quiet = {id: 's1', kind: 'status', text: 'agent-orchestrator: your own copy is kept (bounce does not manage it)'};
  assert.deepEqual(conversationEvents([quiet]), []);
  assert.deepEqual(conversationEvents([quiet], {details: true}), [quiet]);
  // A batch that also reports something that needs attention is not swallowed.
  const mixed = {id: 's2', kind: 'status', text: 'agent-orchestrator: your own copy is kept (bounce does not manage it)\nother-skill: could not be seeded — permission denied'};
  assert.deepEqual(conversationEvents([mixed]), [mixed]);
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

// The pre-rename skill-sync wording ("left alone: not the copy bounce installed") is what older,
// already-journaled sessions have on disk — the journal is append-only, so the filter must still
// catch it alongside the current "your own copy is kept" wording.
test('a skills-sync status row using the pre-rename wording is also folded out of the default view', () => {
  const quiet = {id: 's1', kind: 'status', text: 'agent-orchestrator: left alone: not the copy bounce installed'};
  assert.deepEqual(conversationEvents([quiet]), []);
  assert.deepEqual(conversationEvents([quiet], {details: true}), [quiet]);
});

// /tasks, /review and /help each journal their output every time they're used (cli.js), so
// re-running one mid-session leaves several permanent copies of the same list. Only the latest
// of each view earns a spot in the default transcript; earlier ones are folded out (still in
// /details and the journal).
test('repeated /tasks, /review and /help output collapses to the latest of each in the default view', () => {
  const rows = conversationEvents([
    {id: 't1', kind: 'status', view: 'tasks', text: 'LocalWorker aaaaaaaa · running'},
    {id: 'rv1', kind: 'review', text: 'Review v1'},
    {id: 'h1', kind: 'help', text: 'Help v1'},
    {id: 't2', kind: 'status', view: 'tasks', text: 'LocalWorker aaaaaaaa · completed'},
    {id: 'rv2', kind: 'review', text: 'Review v2'},
    {id: 'h2', kind: 'help', text: 'Help v2'},
    {id: 'q1', kind: 'quota', text: 'claude · 7d 1% used'},
    {id: 'q2', kind: 'quota', text: 'claude · 7d 2% used'},
  ]);
  assert.deepEqual(rows.map(row => row.id), ['t2', 'rv2', 'h2', 'q2']);
  // Older journals never set `view` on a /tasks status row — those are ordinary status rows and
  // are left alone (can't be told apart from any other status text).
  const unmarked = conversationEvents([
    {id: 'u1', kind: 'status', text: 'LocalWorker aaaaaaaa · running'},
    {id: 'u2', kind: 'status', text: 'LocalWorker aaaaaaaa · completed'},
  ]);
  assert.deepEqual(unmarked.map(row => row.id), ['u1', 'u2']);
  // /details keeps every copy.
  const detailRows = conversationEvents([
    {id: 't1', kind: 'status', view: 'tasks', text: 'a'}, {id: 't2', kind: 'status', view: 'tasks', text: 'b'},
  ], {details: true});
  assert.deepEqual(detailRows.map(row => row.id), ['t1', 't2']);
});

// reload.js appends an {kind: 'operation'} row on every daemon resume so the transcript keeps
// showing "Operation: orchestrator on main (multi-provider)" once per restart; only the first
// belongs in the default view. main.disposition and main.wake.scheduled carry no text/status/
// state, so format.js renders them as an empty "Orchestrator · " row — pure noise once filtered
// through to the transcript.
test('a repeated operation row folds to its first, and textless main.* bookkeeping rows are dropped', () => {
  const rows = conversationEvents([
    {id: 'o1', kind: 'operation', operation: 'orchestrator', text: 'Operation: orchestrator on main (multi-provider)'},
    {id: 'd1', kind: 'main.disposition', actionId: 'outcome:1', disposition: 'dispatched'},
    {id: 'w1', kind: 'main.wake.scheduled', actionKey: 'k1', dueAt: 1},
    {id: 'c1', kind: 'main.cancelled', reason: 'user_cancelled', text: 'Automatic main continuation cancelled by user'},
    {id: 'o2', kind: 'operation', operation: 'orchestrator', text: 'Operation: orchestrator on main (multi-provider)'},
  ]);
  assert.deepEqual(rows.map(row => row.id), ['o1', 'c1']);
});

test('a queued prompt the user withdrew is dropped from the default view, kept in /details', () => {
  const rows = [
    {id: 'u1', kind: 'user', text: 'never sent', queued: true, requestId: 'req-1'},
    {id: 'w1', kind: 'main.withdrawn', from: 'user', requestId: 'req-1', text: 'never sent'},
    {id: 'u2', kind: 'user', text: 'kept', queued: true, requestId: 'req-2'},
  ];
  assert.deepEqual(conversationEvents(rows).map(row => row.id), ['u2']);
  assert.deepEqual(conversationEvents(rows, {details: true}).map(row => row.id), ['u1', 'w1', 'u2']);
});
