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
  // /details reads them as one block too (real-console pass 2026-10-21): deltas are live-only since
  // interactive-polish step 11, so one row per delta was never the record, only "codex · Response / the" noise.
  assert.deepEqual(conversationEvents([{id: 'd1', kind: 'delta', provider: 'muse', text: 'Hi'}, {id: 'd2', kind: 'delta', provider: 'muse', text: '!'}], {details: true}).map(row => row.text), ['Hi!']);
  assert.deepEqual(conversationEvents([{id: 'd1', kind: 'delta', provider: 'muse', text: 'Hi'}, {id: 'a', kind: 'assistant', provider: 'muse', text: 'Hi', streamed: true}], {details: true}).map(row => row.id), ['a']);
  // Rows bounce journals while the answer streams (seen live: the session title, a native id, a status)
  // do not cut the answer in two, and the result that repeats the whole of it is still dropped.
  const interleaved = conversationEvents([
    {id: 'u1', kind: 'user', text: 'hi'},
    {id: 'd1', kind: 'delta', provider: 'claude', text: 'Hi there. '}, {id: 'd2', kind: 'delta', provider: 'claude', text: "I'm in "},
    {id: 't1', kind: 'session.titled', name: 'greeting', source: 'model'},
    {id: 'n1', kind: 'peer.native', provider: 'claude', sessionId: 'sid'},
    {id: 's1', kind: 'status', provider: 'claude', text: 'status'},
    {id: 'd3', kind: 'delta', provider: 'claude', text: 'bounce-router.'},
    {id: 'r1', kind: 'result', provider: 'claude', success: true, text: "Hi there. I'm in bounce-router."},
  ]);
  assert.deepEqual(interleaved.filter(row => ['delta', 'result'].includes(row.kind)).map(row => [row.kind, row.id, row.text]), [['delta', 'd1+3', "Hi there. I'm in bounce-router."]]);
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

// Found live (bounce live check, scenario 1): the reply to "reply with exactly: ok" opened with the
// orchestrator's own narration before its tool call, "Trivial request; answer directly and write the
// state note.", rendered as if it were the answer.
test('text written just before a tool call reads as a muted thought, and the answer after it stays the answer', () => {
  const formatter = createFormatter({color: false, compact: true});
  const rows = conversationEvents([
    {id: 'u', kind: 'user', text: 'reply with exactly: ok'},
    {id: 'a1', kind: 'assistant', provider: 'claude', from: 'main', text: 'Trivial request; answer directly and write the state note.'},
    {id: 't1', kind: 'tool', provider: 'claude', from: 'main', text: 'mcp__bounce__state: {"text":"answered ok"}'},
    {id: 'a2', kind: 'assistant', provider: 'claude', from: 'main', text: 'ok'},
    {id: 'm', kind: 'main.terminal', status: 'completed', text: 'ok'},
  ]);
  const said = rows.filter(row => row.kind === 'assistant');
  assert.deepEqual(said.map(row => [row.text, row.narration ?? false]), [['Trivial request; answer directly and write the state note.', true], ['ok', false]]);
  assert.deepEqual(formatter.event(said[0], 90), ['∴ Trivial request; answer directly and write the state note.', '']);
  assert.deepEqual(formatter.event(said[1], 90), ['● ok', '']);
});

// /config's listing is a `settings` row: kept in the default view, folded to its latest copy like /help.
test('a settings row is shown, and a repeated listing folds to the latest', () => {
  const rows = conversationEvents([
    {id: 's1', kind: 'settings', text: 'Settings (a):\n  order = ["codex"]'},
    {id: 'u', kind: 'user', text: '/config sweepMinutes 25'},
    {id: 's2', kind: 'settings', text: 'Settings (a):\n  order = ["codex"]\n  sweepMinutes = 25'},
  ]);
  assert.deepEqual(rows.map(row => row.id), ['u', 's2']);
});

test('the route row shows when the provider, model or mode changes, not at every turn (interactive-polish step 1)', async () => {
  const {conversationEvents} = await import('../src/tui/transcript.js');
  const route = (id, provider, model = 'sonnet', mode = 'yolo') => ({kind: 'route', id, provider, model, mode, text: `Using ${provider} / ${model} / ${mode}`});
  const events = [route('r1', 'claude'), {kind: 'user', id: 'u1', text: 'one'}, route('r2', 'claude'), {kind: 'user', id: 'u2', text: 'two'},
    route('r3', 'claude', 'opus'), route('r4', 'codex'), route('r5', 'codex', 'sonnet', 'plan')];
  assert.deepEqual(conversationEvents(events).filter(e => e.kind === 'route').map(e => e.id), ['r1', 'r3', 'r4', 'r5']);
  assert.equal(conversationEvents(events, {details: true}).filter(e => e.kind === 'route').length, 5, '/details keeps every one');
});

test('each finished turn ends with a footer: how long it took and the tokens it read and wrote (interactive-polish step 6)', async () => {
  const {conversationEvents} = await import('../src/tui/transcript.js');
  const {createFormatter} = await import('../src/format.js');
  const events = [
    {kind: 'user', id: 'u1', text: 'hi', time: '2026-10-21T10:00:00.000Z'},
    {kind: 'assistant', id: 'a1', text: 'Hello.', provider: 'claude'},
    {kind: 'usage', id: 'g1', provider: 'claude', usage: {input_tokens: 1200, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0, output_tokens: 214}},
    {kind: 'turn', id: 't1', text: 'completed', time: '2026-10-21T10:00:12.400Z'},
    {kind: 'user', id: 'u2', text: 'again', time: '2026-10-21T10:01:00.000Z'},
    {kind: 'usage', id: 'g2', provider: 'opencode', usage: {input: 500, output: 20}},
    {kind: 'usage', id: 'g3', provider: 'opencode', usage: {input: 700, output: 30}},
    {kind: 'turn', id: 't2', text: 'cancelled', time: '2026-10-21T10:01:03.200Z'},
  ];
  const footers = conversationEvents(events).filter(e => e.kind === 'turn.footer');
  assert.deepEqual(footers.map(e => e.text), ['12.4 s · in 31.2k (30.0k cached) · out 214', 'cancelled after 3.2 s · in 1.2k · out 50']);
  const plain = createFormatter({color: false, compact: true});
  assert.equal(plain.event(footers[0], 80)[0].trim(), '12.4 s · in 31.2k (30.0k cached) · out 214');
  assert.equal(conversationEvents(events, {details: true}).filter(e => e.kind === 'turn.footer').length, 0, '/details shows the raw rows instead');
});

test('a finished turn leaves no live progress rows or bare vendor status behind; a running one still shows them', async () => {
  const {conversationEvents} = await import('../src/tui/transcript.js');
  const running = [
    {kind: 'user', id: 'u1', text: 'hi', time: '2026-10-21T10:00:00.000Z'},
    {kind: 'progress', id: 'p1', provider: 'claude', text: 'Ready · 88 tools'},
    {kind: 'status', id: 's1', provider: 'claude', text: 'status'},
    {kind: 'progress', id: 'p2', provider: 'claude', text: 'Thinking · ~218 tokens'},
  ];
  assert.deepEqual(conversationEvents(running).map(e => e.kind), ['user', 'progress', 'progress']);
  const finished = [...running, {kind: 'assistant', id: 'a1', provider: 'claude', text: 'Hello.'}, {kind: 'turn', id: 't1', text: 'completed', time: '2026-10-21T10:00:05.000Z'}];
  assert.deepEqual(conversationEvents(finished).map(e => e.kind), ['user', 'assistant', 'turn.footer']);
});

test('the journaled assistant row of a streamed block takes the place of its live deltas, not a second copy', async () => {
  const {conversationEvents} = await import('../src/tui/transcript.js');
  const events = [
    {kind: 'user', id: 'u1', text: 'hi'},
    {kind: 'delta', id: 'd1', provider: 'claude', text: 'Hel'},
    {kind: 'delta', id: 'd2', provider: 'claude', text: 'lo.'},
    {kind: 'assistant', id: 'a1', provider: 'claude', text: 'Hello.', streamed: true},
  ];
  assert.deepEqual(conversationEvents(events).map(e => [e.kind, e.text]), [['user', 'hi'], ['assistant', 'Hello.']]);
  assert.deepEqual(conversationEvents(events.filter(e => e.kind !== 'delta')).map(e => [e.kind, e.text]), [['user', 'hi'], ['assistant', 'Hello.']], 'a replay from the journal alone shows it once too');
  const titled = [...events.slice(0, 3), {kind: 'session.titled', id: 's1', text: 'Greeting'}, events[3]];
  assert.deepEqual(conversationEvents(titled).filter(e => ['delta', 'assistant'].includes(e.kind)).map(e => e.text), ['Hello.'], 'a row journaled mid-stream does not cause a second copy');
});

// Found live 2026-10-21: a worker's second lifecycle row in the same turn left a hole where its first was, and the
// end of the turn crashed on it; removing progress also shifted the row a worker's next update replaces.
test('the end of a turn with a worker that updated twice keeps one block for it, and the footer', () => {
  const rows = conversationEvents([
    {id: 'u', kind: 'user', text: 'go', time: '2026-10-21T00:00:00Z'},
    {id: 'p', kind: 'progress', text: 'Thinking', time: '2026-10-21T00:00:00.500Z'},
    {id: 's', kind: 'task.submitted', task: 'task-one', profile: 'builder', time: '2026-10-21T00:00:01Z'},
    {id: 'r', kind: 'task.started', task: 'task-one', profile: 'builder', time: '2026-10-21T00:00:01Z'},
    {id: 't', kind: 'turn', text: 'Turn completed', time: '2026-10-21T00:00:02Z'},
    {id: 'c', kind: 'task.completed', task: 'task-one', summary: 'done', time: '2026-10-21T00:00:05Z'},
  ]);
  assert.deepEqual(rows.map(row => row.kind), ['user', 'turn.footer', 'task.fold']);
  assert.equal(rows[2].state, 'completed');
});

test('a streamed answer after a worker updated twice still replaces its own deltas', () => {
  const rows = conversationEvents([
    {id: 'u', kind: 'user', text: 'go', time: '2026-10-21T00:00:00Z'},
    {id: 'd', kind: 'delta', provider: 'claude', text: 'Sending', time: '2026-10-21T00:00:00.200Z'},
    {id: 's', kind: 'task.submitted', task: 'task-one', profile: 'builder', time: '2026-10-21T00:00:01Z'},
    {id: 'r', kind: 'task.started', task: 'task-one', profile: 'builder', time: '2026-10-21T00:00:01Z'},
    {id: 'a', kind: 'assistant', provider: 'claude', text: 'Sending a builder.', streamed: true, time: '2026-10-21T00:00:02Z'},
  ]);
  assert.deepEqual(rows.map(row => `${row.kind}:${row.id}`), ['user:u', 'assistant:a', 'task.fold:r']);
});

test('a turn the orchestrator starts on worker outcomes, with no typed prompt, ends with its own footer', () => {
  const rows = conversationEvents([
    {id: 'u', kind: 'user', text: 'go', time: '2026-10-21T00:00:00Z'},
    {id: 't1', kind: 'turn', text: 'Turn completed', time: '2026-10-21T00:00:02Z'},
    {id: 'w', kind: 'main.requested', wake: true, time: '2026-10-21T00:01:00Z'},
    {id: 'g', kind: 'usage', provider: 'claude', usage: {input_tokens: 1200, output_tokens: 40}, time: '2026-10-21T00:01:03Z'},
    {id: 'a', kind: 'assistant', provider: 'claude', text: 'Builder done.', time: '2026-10-21T00:01:04Z'},
    {id: 't2', kind: 'turn', text: 'Turn completed', time: '2026-10-21T00:01:04.500Z'},
  ]);
  const footers = rows.filter(row => row.kind === 'turn.footer').map(row => row.text);
  assert.deepEqual(footers, ['Turn completed after 2.0 s', 'Turn completed after 4.5 s · in 1.2k · out 40']);
});
