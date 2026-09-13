import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {taskTree, foldedThread, workerThread, agentsBoard, boardLayout, parseCommand, continueMain} from '../src/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliSource = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');

// U1: taskTree exact rows for a two-level tree — a root running with a milestone and a
// deadline, one child queued, one child blocked with a blocker, budgets with remaining starts.
test('U1: taskTree reports exact rows, order and budget remainders for a two-level tree', () => {
  const events = [
    {kind: 'task.submitted', task: 'root1', context: 'ctx-1', time: 't0', parent: null, profile: 'orchestrate', deadline: 5000, budget: {starts: 3}},
    {kind: 'task.started', task: 'root1', time: 't1', attempt: 1},
    {kind: 'task.milestone', task: 'root1', time: 't2', text: 'scanning repo', evidence: null},
    {kind: 'budget.reserved', task: 'root1', time: 't2b', amount: {starts: 1}},
    {kind: 'task.submitted', task: 'childA', context: 'ctx-1', time: 't3', parent: 'root1', profile: 'build', deadline: null},
    {kind: 'task.submitted', task: 'childB', context: 'ctx-1', time: 't4', parent: 'root1', profile: 'critic', deadline: null},
    {kind: 'budget.reserved', task: 'childB', time: 't4b', amount: {starts: 1}},
    {kind: 'task.started', task: 'childB', time: 't5', attempt: 1},
    {kind: 'task.blocked', task: 'childB', time: 't6', text: 'need approval'},
  ];
  assert.deepEqual(taskTree(events), [
    {task: 'root1', depth: 0, profile: 'orchestrate', state: 'waiting', lastMilestone: 'scanning repo', deadline: 5000, remainingStarts: 1, remainingRounds: null, blocker: null, tier: null, adapter: null, model: null, startedAt: 't1', outcome: null},
    {task: 'childA', depth: 1, profile: 'build', state: 'queued', lastMilestone: null, deadline: null, remainingStarts: 1, remainingRounds: null, blocker: null, tier: null, adapter: null, model: null, startedAt: null, outcome: null},
    {task: 'childB', depth: 1, profile: 'critic', state: 'blocked', lastMilestone: null, deadline: null, remainingStarts: 1, remainingRounds: null, blocker: 'need approval', tier: null, adapter: null, model: null, startedAt: 't5', outcome: null},
  ]);
});

// A session with no task.submitted at all yields an empty tree.
test('U1b: taskTree on a session with no task rows is empty', () => {
  assert.deepEqual(taskTree([{kind: 'user', text: 'hi'}, {kind: 'assistant', text: 'hello'}]), []);
});

// U2: tier is the LATEST task.delivered tier for a task, or null when none was ever delivered.
test('U2: taskTree tier reflects the latest task.delivered row only', () => {
  const events = [
    {kind: 'task.submitted', task: 't1', context: 'ctx-1', time: 't0', parent: null, profile: 'build', deadline: null},
    {kind: 'task.delivered', task: 't1', time: 't1', tier: 'queued', message: 'm1', text: null},
    {kind: 'task.delivered', task: 't1', time: 't2', tier: 'next-turn', message: 'm2', text: null},
    {kind: 'task.submitted', task: 't2', context: 'ctx-1', time: 't3', parent: null, profile: 'critic', deadline: null},
  ];
  const rows = taskTree(events);
  assert.equal(rows.find(r => r.task === 't1').tier, 'next-turn');
  assert.equal(rows.find(r => r.task === 't2').tier, null);
});

// U3: foldedThread excludes child transcripts — a parent context with 2 legacy rows plus a
// child task (submitted in that context) whose own assistant/tool activity carries a DIFFERENT
// context, contributes exactly 1 task.fold row at the child's submit position, never its own
// assistant/tool rows.
test('U3: foldedThread folds a child task into one row and excludes its transcript', () => {
  const events = [
    {kind: 'user', context: 'ctx-root', time: 't0', text: 'please build the thing'},
    {kind: 'assistant', context: 'ctx-root', time: 't1', text: 'Delegating to a worker.'},
    {kind: 'task.submitted', task: 'child1', context: 'ctx-root', time: 't2', parent: null, profile: 'build', deadline: null},
    {kind: 'task.started', task: 'child1', time: 't3', attempt: 1},
    {kind: 'assistant', task: 'child1', context: 'ctx-child', time: 't4', text: 'Looking at the repo'},
    {kind: 'tool', task: 'child1', context: 'ctx-child', time: 't5', text: 'read: src/index.js'},
    {kind: 'task.activity', task: 'child1', context: 'ctx-child', time: 't6', text: 'still working'},
    {kind: 'task.milestone', task: 'child1', time: 't7', text: 'reading files', evidence: null},
  ];
  assert.deepEqual(foldedThread(events, 'ctx-root'), [
    {kind: 'user', context: 'ctx-root', time: 't0', text: 'please build the thing'},
    {kind: 'assistant', context: 'ctx-root', time: 't1', text: 'Delegating to a worker.'},
    {kind: 'task.fold', task: 'child1', state: 'running', text: 'build · running · reading files'},
  ]);
});

// U4: A3 flooding case — 50 task.activity rows plus one task.blocked contribute exactly one
// fold row to the parent thread, carrying the blocker text, not one row per activity.
test('U4: fifty activity rows plus a blocker still fold to exactly one row', () => {
  const events = [
    {kind: 'task.submitted', task: 'child1', context: 'ctx-root', time: 't0', parent: null, profile: 'build', deadline: null},
    {kind: 'task.started', task: 'child1', time: 't1', attempt: 1},
    ...Array.from({length: 50}, (_, i) => ({kind: 'task.activity', task: 'child1', context: 'ctx-child', time: `a${i}`, text: `working ${i}`})),
    {kind: 'task.blocked', task: 'child1', time: 't2', text: 'needs a decision'},
  ];
  const rows = foldedThread(events, 'ctx-root');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {kind: 'task.fold', task: 'child1', state: 'blocked', text: 'build · blocked · needs a decision'});
});

// U5: continue-main authority. Part 1 — driving message/task.blocked/policy.escalated rows
// through the session's own subscriber (scheduleRender, wired as session.onEvent in src/cli.js)
// can never enqueue a main turn: proven structurally, since scheduleRender's body never calls
// submit(...) or router.run(...), and the only two call sites of submit(...) in src/cli.js are
// inside handleKey's Enter branch and inside submit's own pending-queue continuation (itself
// only ever reached from that same handleKey-originated call). A real terminal/keyboard is
// needed to drive handleKey end-to-end, so per CONTRACT.md A4/U5 this is proven by (a) reading
// the source structurally, the way a grep-driven regression test does, and (b) exercising the
// pure decision unit (continueMain) that the keyboard's /continue handler calls, which nothing
// else in the file references.
test('U5a: no session subscriber can reach submit()/router.run() — scheduleRender never calls them, and submit is only called from the keyboard path', () => {
  const scheduleRenderBody = /function scheduleRender\(event\) \{[\s\S]*?\n  \}/.exec(cliSource)[0];
  assert.equal(/submit\(|router\.run\(/.test(scheduleRenderBody), false);
  const submitCallSites = [...cliSource.matchAll(/(^|[^.\w])submit\(/g)].map(m => m.index);
  assert.equal(submitCallSites.length, 3); // the declaration `async function submit(` + 2 call sites
  // Every session.onEvent assignment in the file is either the bare `scheduleRender` reference
  // (the TUI) or a one-line logger for `bounce run` — never a function whose body could call
  // submit(...)/router.run(...).
  const onEventLines = cliSource.split('\n').filter(l => l.includes('session.onEvent ='));
  assert.equal(onEventLines.length, 3);
  assert.equal(onEventLines.every(l => !/submit\(|router\.run\(/.test(l)), true);
  assert.equal(onEventLines.some(l => l.trim() === 'session.onEvent = scheduleRender;'), true);
});

test('U5b: /continue is gated by the pure continueMain unit — unknown/read-only profiles refuse, a known write profile enqueues one turn', () => {
  const profiles = {
    build: {adapter: 'claude', model: '', mode: 'yolo', policy: 'write', fallback: [], role: 'builder'},
    critic: {adapter: 'claude', model: '', mode: 'yolo', policy: 'read-only', fallback: [], role: 'critic'},
  };
  assert.deepEqual(continueMain(profiles, 'build'), {ok: true, profile: 'build'});
  assert.deepEqual(continueMain(profiles, 'critic'), {ok: false, error: 'no such profile'});
  assert.deepEqual(continueMain(profiles, 'nope'), {ok: false, error: 'no such profile'});
  assert.deepEqual(continueMain(profiles, ''), {ok: false, error: 'no such profile'});
  assert.deepEqual(continueMain({}, 'build'), {ok: false, error: 'no such profile'});
  // The command handler in cli.js is the only caller: continueMain never appears inside
  // scheduleRender or any session.subscribe(...) callback (grep over the whole file).
  const referencing = [...cliSource.matchAll(/continueMain/g)];
  assert.equal(referencing.length >= 1, true);
  assert.equal(/session\.subscribe\([^)]*continueMain/.test(cliSource), false);
});

test('parseCommand parses a slash command into command/parts/arg, and returns null for plain text', () => {
  assert.deepEqual(parseCommand('/continue build'), {command: 'continue', parts: ['build'], arg: 'build'});
  assert.deepEqual(parseCommand('/tasks'), {command: 'tasks', parts: [], arg: ''});
  assert.deepEqual(parseCommand('/attach child-7'), {command: 'attach', parts: ['child-7'], arg: 'child-7'});
  assert.equal(parseCommand('hello there'), null);
});

// U6: /attach focus is TUI-local — taskTree/foldedThread take no focus argument (so nothing
// about focus can flow into them), and the /attach command handler in src/cli.js never journals
// a row except the documented 'no such task' status error for an unknown id.
test('U6: taskTree/foldedThread have no focus parameter, and /attach never appends an event on the happy path', () => {
  assert.equal(taskTree.length, 1);
  assert.equal(foldedThread.length, 2);
  const events = [
    {kind: 'task.submitted', task: 'child1', context: 'ctx-root', time: 't0', parent: null, profile: 'build', deadline: null},
  ];
  // Calling the reducers twice, as if focus had toggled in between, gives byte-identical output:
  // nothing in their signature or body could have observed a focus change.
  assert.deepEqual(taskTree(events), taskTree(events));
  assert.deepEqual(foldedThread(events, 'ctx-root'), foldedThread(events, 'ctx-root'));

  const markerIndex = cliSource.indexOf("command === 'attach'");
  assert.notEqual(markerIndex, -1, "expected a command === 'attach' branch in src/cli.js");
  const braceStart = cliSource.indexOf('{', markerIndex);
  let depth = 0, i = braceStart;
  for (; i < cliSource.length; i++) {
    if (cliSource[i] === '{') depth++;
    else if (cliSource[i] === '}' && --depth === 0) { i++; break; }
  }
  const attachBlock = cliSource.slice(braceStart, i);
  const appends = [...attachBlock.matchAll(/session\.append\(\{[^}]*\}\)/g)].map(m => m[0]);
  assert.equal(appends.length, 1);
  assert.match(appends[0], /no such task/);
});

test('U7: taskTree carries the worker adapter, model and start time for the AGENTS pane', () => {
  const events = [
    {kind: 'task.submitted', task: 't1', parent: null, profile: 'build', context: 'c', deadline: null},
    {kind: 'peer.joined', name: 'worker:t1', role: 'worker', adapter: 'codex', context: 'c'},
    {kind: 'task.started', task: 't1', attempt: 1, requested: 'o4-mini', time: '2026-09-13T00:00:00.000Z', context: 'c'},
  ];
  const [row] = taskTree(events);
  assert.equal(row.adapter, 'codex');
  assert.equal(row.model, 'o4-mini');
  assert.equal(row.startedAt, '2026-09-13T00:00:00.000Z');
});

// U8: workerThread — one worker's own thread: lifecycle rows, messages to it as `user` rows,
// live activity merged by time, other tasks and the main transcript excluded.
test('U8: workerThread yields exactly one worker\'s lifecycle, messages and live activity, merged by time', () => {
  const events = [
    {kind: 'user', context: 'ctx-1', time: '2026-09-13T10:00:00.000Z', text: 'main turn'},
    {kind: 'task.submitted', task: 'w1', context: 'ctx-1', time: '2026-09-13T10:00:01.000Z', parent: null, profile: 'build', orders: 'write the parser'},
    {kind: 'task.submitted', task: 'w2', context: 'ctx-1', time: '2026-09-13T10:00:01.500Z', parent: null, profile: 'critic', orders: 'review it'},
    {kind: 'task.started', task: 'w1', time: '2026-09-13T10:00:02.000Z', attempt: 1, requested: 'sonnet'},
    {kind: 'task.milestone', task: 'w2', time: '2026-09-13T10:00:02.500Z', text: 'not mine'},
    {kind: 'task.milestone', task: 'w1', time: '2026-09-13T10:00:04.000Z', text: 'parser scaffolded'},
    {kind: 'message', to: 'worker:w1', from: 'user', time: '2026-09-13T10:00:05.000Z', text: 'use recursive descent'},
    {kind: 'message', to: 'worker:w2', from: 'user', time: '2026-09-13T10:00:05.500Z', text: 'not for w1'},
    {kind: 'task.delivered', task: 'w1', time: '2026-09-13T10:00:05.100Z', tier: 'live'},
    {kind: 'task.usage', task: 'w1', time: '2026-09-13T10:00:06.000Z', usage: {input: 1}},
    {kind: 'task.completed', task: 'w1', time: '2026-09-13T10:00:07.000Z', summary: 'parser done'},
  ];
  const activity = [
    {time: '2026-09-13T10:00:03.000Z', text: 'Reading src/parse.js'},
    {time: '2026-09-13T10:00:06.500Z', text: 'Running tests'},
  ];
  assert.deepEqual(workerThread(events, 'w1', activity), [
    {kind: 'note', provider: 'build', time: '2026-09-13T10:00:01.000Z', text: 'Task submitted · build\nwrite the parser'},
    {kind: 'status', provider: 'build', time: '2026-09-13T10:00:02.000Z', text: 'started · attempt 1 · model sonnet'},
    {kind: 'status', provider: 'build', time: '2026-09-13T10:00:03.000Z', text: 'Reading src/parse.js'},
    {kind: 'note', provider: 'build', time: '2026-09-13T10:00:04.000Z', text: 'milestone · parser scaffolded'},
    {kind: 'user', time: '2026-09-13T10:00:05.000Z', text: 'use recursive descent'},
    {kind: 'status', provider: 'build', time: '2026-09-13T10:00:05.100Z', text: 'delivered (live)'},
    {kind: 'status', provider: 'build', time: '2026-09-13T10:00:06.500Z', text: 'Running tests'},
    {kind: 'assistant', provider: 'build', time: '2026-09-13T10:00:07.000Z', text: 'parser done'},
  ]);
  assert.deepEqual(workerThread(events, 'nope'), []);
  assert.equal(workerThread.length, 2, 'activity is an optional third argument; no focus parameter');
});

// U9: the zoom view steers, never drives — typed text while zoomed becomes a message to that
// worker; nothing in the zoom paths can start a main turn, and /zoom appends no event on its
// happy path (only the 'no such task' status).
test('U9: zoomed plain text appends a worker message and never reaches router.run; /zoom appends nothing on the happy path', () => {
  const zoomText = cliSource.indexOf('} else if (zoomTask) {');
  assert.notEqual(zoomText, -1, 'expected the zoomed plain-text branch in src/cli.js');
  const zoomTextBlock = cliSource.slice(zoomText, cliSource.indexOf('} else {', zoomText));
  assert.equal(/router\.run\(/.test(zoomTextBlock), false);
  assert.match(zoomTextBlock, /session\.append\(\{kind: 'message', to: `worker:\$\{zoomTask\}`, text\}\)/);

  const markerIndex = cliSource.indexOf("command === 'zoom'");
  assert.notEqual(markerIndex, -1);
  const braceStart = cliSource.indexOf('{', markerIndex);
  let depth = 0, i = braceStart;
  for (; i < cliSource.length; i++) {
    if (cliSource[i] === '{') depth++;
    else if (cliSource[i] === '}' && --depth === 0) { i++; break; }
  }
  const zoomBlock = cliSource.slice(braceStart, i);
  const appends = [...zoomBlock.matchAll(/session\.append\(\{[^}]*\}\)/g)].map(m => m[0]);
  assert.equal(appends.length, 1);
  assert.match(appends[0], /no such task/);
  assert.equal(/router\.run\(/.test(zoomBlock), false);
});

// U10: agentsBoard — every agent with its last live activity lines (first line of each) and,
// once terminal, its outcome as the final line; workers with no activity have no lines.
test('U10: agentsBoard lists every agent with its tail of live activity and a terminal outcome line', () => {
  const events = [
    {kind: 'task.submitted', task: 'w1', context: 'c', time: 't0', parent: null, profile: 'build', deadline: null},
    {kind: 'task.submitted', task: 'w2', context: 'c', time: 't1', parent: 'w1', profile: 'critic', deadline: null},
    {kind: 'task.started', task: 'w1', time: 't2', attempt: 1, requested: 'sonnet'},
    {kind: 'task.milestone', task: 'w1', time: 't3', text: 'scaffolded'},
    {kind: 'task.completed', task: 'w1', time: 't4', summary: 'parser done'},
  ];
  const activity = new Map([['w1', [
    {time: 'a1', text: 'Reading src/parse.js'},
    {time: 'a2', text: 'Running tests\nsecond line dropped'},
  ]]]);
  const board = agentsBoard(events, activity, {tail: 1});
  assert.deepEqual(board.map(a => [a.task, a.profile, a.state, a.lines, a.lastActivityAt]), [
    ['w1', 'build', 'completed', ['Running tests', '→ completed · parser done'], 'a2'],
    ['w2', 'critic', 'queued', [], null],
  ]);
  assert.equal(board[0].model, 'sonnet');
  assert.deepEqual(agentsBoard([], new Map()), []);
});

// U11: boardLayout — exact line shares: even split, yielded rows go to agents with more lines,
// and when agents outnumber the rows the lead ones are drawn with a "+ more" row reserved.
test('U11: boardLayout shares the board height exactly', () => {
  assert.deepEqual(boardLayout([10, 10], 12), {shown: 2, lines: [5, 5], more: 0});         // 2 headers + 10 rows
  assert.deepEqual(boardLayout([1, 10, 10], 15), {shown: 3, lines: [1, 7, 4], more: 0});   // 3 headers + 12 rows; agent 1 yields 3
  assert.deepEqual(boardLayout([0, 0], 6), {shown: 2, lines: [0, 0], more: 0});
  assert.deepEqual(boardLayout([5, 5, 5, 5, 5], 6), {shown: 2, lines: [2, 1], more: 3});   // 2 headers + the "+3 more" row leave 3 activity rows
  assert.deepEqual(boardLayout([], 10), {shown: 0, lines: [], more: 0});
  assert.deepEqual(boardLayout([3], 0), {shown: 0, lines: [], more: 1});
});

// U12: a scheduler refusal is visible: taskTree carries the failure as `outcome`, and the fold row
// shows it instead of 'queued' (the real incident: two size refusals the TUI never surfaced).
test('U12: a refused task shows its reason in taskTree.outcome and in the fold row', () => {
  const events = [
    {kind: 'task.submitted', task: 'w1', context: 'c', time: 't0', parent: null, profile: 'build', deadline: null},
    {kind: 'task.failed', task: 'w1', time: 't1', reason: 'size', text: 'lines 400 exceeds limit 150'},
  ];
  assert.equal(taskTree(events)[0].outcome, 'size: lines 400 exceeds limit 150');
  assert.deepEqual(foldedThread(events, 'c'), [{kind: 'task.fold', task: 'w1', state: 'failed', text: 'build · failed · size: lines 400 exceeds limit 150'}]);
});
