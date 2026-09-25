import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {taskTree, foldedThread, workerThread, agentsBoard, boardLayout, agentsWorkspace, paneGrid, withAsides, stateGlyph, failureHint, withoutBrief, parseCommand, continueMain} from '../src/format.js';

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
    {kind: 'task.fold', task: 'child1', state: 'running', reason: null, text: 'build · running · reading files'},
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
  assert.deepEqual(rows[0], {kind: 'task.fold', task: 'child1', state: 'blocked', reason: null, text: 'build · blocked · needs a decision'});
});

// U5: continue-main authority. Part 1 — driving message/task.blocked/policy.escalated rows
// through the session's own subscriber (scheduleRender, wired as session.onEvent in src/cli.js)
// can never enqueue a main turn: proven structurally, since scheduleRender's body never calls
// submit(...) or router.run(...), and the only two call sites of submit(...) in src/cli.js are
// inside handleKey's Enter branch and inside submit's own pending-turn continuation (itself
// only ever reached from that same handleKey-originated call). A real terminal/keyboard is
// needed to drive handleKey end-to-end, so per CONTRACT.md A4/U5 this is proven by (a) reading
// the source structurally, the way a grep-driven regression test does, and (b) exercising the
// pure decision unit (continueMain) that the keyboard's /continue handler calls, which nothing
// else in the file references.
test('U5a: no session subscriber can reach submit()/router.run() — scheduleRender never calls them, and submit is only called from the keyboard path', () => {
  const scheduleRenderBody = /function scheduleRender\(event\) \{[\s\S]*?\n  \}/.exec(cliSource)[0];
  assert.equal(/submit\(|router\.run\(/.test(scheduleRenderBody), false);
  const submitCallSites = [...cliSource.matchAll(/(^|[^.\w])submit\(/g)].map(m => m.index);
  assert.equal(submitCallSites.length, 5); // declaration, queued continuation, worker message, command and turn paths
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

// U6: /agents focus is TUI-local — taskTree/foldedThread take no focus argument, so selecting
// another pane cannot mutate the durable task view.
test('U6: taskTree/foldedThread have no focus parameter and /agents selection stays local', () => {
  assert.equal(taskTree.length, 1);
  assert.equal(foldedThread.length, 2);
  const events = [
    {kind: 'task.submitted', task: 'child1', context: 'ctx-root', time: 't0', parent: null, profile: 'build', deadline: null},
  ];
  // Calling the reducers twice, as if focus had toggled in between, gives byte-identical output:
  // nothing in their signature or body could have observed a focus change.
  assert.deepEqual(taskTree(events), taskTree(events));
  assert.deepEqual(foldedThread(events, 'ctx-root'), foldedThread(events, 'ctx-root'));

  assert.match(cliSource, /changePane\(terminal\.snapshot\(\)\.panes\.find\(pane => pane\.task === task\)\?\.id/);
  assert.match(cliSource, /let agentsOpen = false, selectedAgentPane = 'orchestrator'/);
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

// U9: typing in a worker pane steers that worker and cannot start a main provider turn.
test('U9: selected worker-pane input appends a worker message and never reaches router.run', () => {
  const workerText = cliSource.indexOf('} else if (agentsOpen && selectedWorker()) {');
  assert.notEqual(workerText, -1, 'expected the selected worker-pane plain-text branch');
  const workerTextBlock = cliSource.slice(workerText, cliSource.indexOf('} else {', workerText));
  assert.equal(/router\.run\(/.test(workerTextBlock), false);
  // A /NAME an agent owns is expanded for a worker too; anything else goes as typed.
  assert.match(workerTextBlock, /session\.append\(\{kind: 'message', to: `worker:\$\{task\}`, text: expandVendorCommand\(text, vendorOptions\(\)\)\?\.prompt \?\? text\}\)/);
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

test('U10b: a launch notice is visible but is not counted as genuine worker activity', () => {
  const events = [
    {kind: 'task.submitted', task: 'silent', context: 'c', time: 't0', parent: null, profile: 'build', deadline: null},
    {kind: 'task.started', task: 'silent', time: 't1', attempt: 1},
  ];
  const board = agentsBoard(events, new Map([['silent', [
    {time: 't2', text: 'Worker started · waiting for first activity', startup: true},
  ]]]));
  assert.deepEqual(board[0].lines, ['Worker started · waiting for first activity']);
  assert.equal(board[0].lastActivityAt, null);
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
  assert.deepEqual(foldedThread(events, 'c'), [{kind: 'task.fold', task: 'w1', state: 'failed', reason: 'size', text: 'build · failed · size: lines 400 exceeds limit 150'}]);
});

// U13: /steer — asides fold in front of the next prompt, exactly, and never start a turn: the
// /steer branch appends only the aside row, and both main-turn prompts pass through withAsides.
// /btw is a separate, side-only command (src/btw.js) and must add no submit(/router.run( site
// of its own (CONTRACT U5a) — see U13b.
test('U13: withAsides folds /steer notes in front of the next turn; /steer never runs a turn', () => {
  assert.equal(withAsides('fix the parser', []), 'fix the parser');
  assert.equal(withAsides('fix the parser', ['tests live in test/', 'skip docs']),
    'By the way — notes from the user while you were working:\n- tests live in test/\n- skip docs\n\nfix the parser');
  const runs = [...cliSource.matchAll(/router\.run\([^\n]+/g)].map(m => m[0]);
  assert.equal(runs.length, 3);
  assert.equal(runs.filter(r => r.includes('withAsides(')).length, 2, 'both TUI turns fold idle asides; only the one-shot run does not');
  const steer = cliSource.indexOf("command === 'steer'");
  assert.notEqual(steer, -1);
  const block = cliSource.slice(steer, cliSource.indexOf('} else if', steer + 1));
  assert.equal(/router\.run\(|pending\.push/.test(block), false);
  assert.match(cliSource, /session\.append\(\{kind: 'aside', text\}\)/);
});

// U13b: /btw is a side call, not a turn — it must not introduce a 6th submit(/router.run( site
// (CONTRACT U5a keeps this count at exactly 5: the definition plus its 4 keyboard call sites).
test('U13b: /btw adds no submit(/router.run( site of its own', () => {
  const btw = cliSource.indexOf("command === 'btw'");
  assert.notEqual(btw, -1);
  const block = cliSource.slice(btw, cliSource.indexOf('} else if', btw + 1));
  assert.equal(/router\.run\(|\bsubmit\(/.test(block), false);
  assert.equal([...cliSource.matchAll(/\bsubmit\(/g)].length, 5);
});

// U14: a malformed task row (no task id) never crashes a view — the real crash was
// `row.task.slice` in the AGENTS pane after such a row was journaled.
test('U14: task rows without a string task id are ignored by taskTree and foldedThread', () => {
  const events = [
    {kind: 'task.submitted', context: 'c', time: 't0', parent: null, profile: 'build', deadline: null},
    {kind: 'task.submitted', task: 'ok', context: 'c', time: 't1', parent: null, profile: 'build', deadline: null},
  ];
  assert.deepEqual(taskTree(events).map(r => r.task), ['ok']);
  assert.deepEqual(foldedThread(events, 'c').map(r => r.task), ['ok']);
});

// U15: /login re-asks the vendors for quota once the sign-in returns (the panel showed codex as
// "unavailable" after a successful sign-in until the next turn).
test('U15: the /login branch refreshes quota after the vendor login returns', () => {
  const login = cliSource.indexOf("command === 'login'");
  assert.notEqual(login, -1);
  const block = cliSource.slice(login, cliSource.indexOf('} else if', login + 1));
  assert.match(block, /await login\(provider, settings, session\.cwd\)/);
  assert.match(block, /refreshQuota\(settings, \{root, store: quotas, cwd: session\.cwd\}\)/);
});

// U16: the orchestrator's own vendor cannot spawn workers bounce does not see.
test('U16: in orchestrator mode the claude invocation disallows the Agent/Task tools', () => {
  assert.match(cliSource, /const noOwnSubagents = provider => provider === 'claude' \? \['--disallowedTools', 'Agent,Task'\] : \[\];/);
  assert.match(cliSource, /orchestrating \? \{runner: options => runProcess\(\{\.\.\.options, keepBus: true\}\), extraArgs: noOwnSubagents\}/);
});

// U17: presentation helpers — one glyph per state, a next step for every failure reason, and the
// orchestrator's brief line stripped from what the person typed.
test('U17: stateGlyph, failureHint and withoutBrief are exact', () => {
  assert.deepEqual(['queued', 'running', 'waiting', 'reviewing', 'blocked', 'input_required', 'completed', 'accepted', 'failed', 'timed_out', 'cancelled', 'rejected', 'weird'].map(stateGlyph),
    ['◌', '●', '●', '●', '◐', '◐', '✔', '✔', '✗', '✗', '✗', '✗', '·']);
  assert.equal(failureHint('missing'), "that vendor CLI is not installed or not signed in · /login <vendor>, or change the profile's adapter");
  assert.equal(failureHint('size'), 'the task exceeds a configured size limit · split it, or raise `limits` in the config');
  assert.equal(failureHint('orphaned'), 'the daemon restarted while it ran · resubmit the task');
  assert.equal(failureHint('error', 'Invalid request: invalid type: null, expected a string'), 'the vendor CLI speaks a different protocol version than bounce expects · update bounce (or the vendor), then resubmit');
  assert.equal(failureHint('error', 'spawn codex ENOENT'), 'the vendor executable could not be started · check `executables` in the config and /login');
  assert.equal(failureHint('error', 'something else'), 'see the full row with /agents <task>, then resubmit or /stop');
  assert.equal(withoutBrief('You are the orchestrator peer of session abc; see x.\ncontinue with the handoff'), 'continue with the handoff');
  assert.equal(withoutBrief('plain turn'), 'plain turn');
  assert.equal(withoutBrief('You are the orchestrator peer of session abc; see x.'), 'You are the orchestrator peer of session abc; see x.');
});

// U18: The /agents workspace always starts with the orchestrator, then has exactly one pane per
// worker. The worker pane preserves both task lifecycle information and the latest live lines.
test('U18: agentsWorkspace puts the orchestrator first and retains worker progress', () => {
  const events = [
    {kind: 'task.submitted', task: 'build-1', context: 'c', time: 't0', parent: null, profile: 'build', deadline: null},
    {kind: 'task.started', task: 'build-1', time: 't1', attempt: 1, requested: 'gpt-5-mini'},
    {kind: 'task.milestone', task: 'build-1', time: 't2', phase: 'implement', text: 'route implemented', next: 'run tests', evidence: 'src/routes.js'},
    {kind: 'task.blocked', task: 'build-1', time: 't3', text: 'need credentials'},
  ];
  const activity = new Map([['build-1', [
    {time: 't4', text: 'Running focused tests\nverbose output'},
    {time: 't5', text: 'Waiting for credentials'},
  ]]]);
  assert.deepEqual(agentsWorkspace(events, activity, {profile: 'main', state: 'waiting', lines: ['Waiting on build-1']}), {
    panes: [
      {id: 'orchestrator', kind: 'orchestrator', profile: 'main', state: 'waiting', lines: ['Waiting on build-1']},
      {id: 'worker:build-1', kind: 'worker', task: 'build-1', depth: 0, profile: 'build', state: 'blocked', lastMilestone: 'route implemented', deadline: null, remainingStarts: null, remainingRounds: null, blocker: 'need credentials', tier: null, adapter: null, model: 'gpt-5-mini', startedAt: 't1', outcome: null, lines: ['Running focused tests', 'Waiting for credentials'], lastActivityAt: 't5', phase: 'implement', next: 'run tests', evidence: 'src/routes.js', checkpointAt: 't2'},
    ],
  });
});

test('U18b: agentsWorkspace panes are ephemeral and exclude terminal workers', () => {
  const submitted = (task, profile) => ({kind: 'task.submitted', task, context: 'c', parent: null, profile, deadline: null});
  const events = [
    submitted('live', 'build'),
    {kind: 'task.started', task: 'live', attempt: 1},
    submitted('done', 'test'),
    {kind: 'task.started', task: 'done', attempt: 1},
    {kind: 'task.completed', task: 'done', summary: 'passed'},
    submitted('stopped', 'review'),
    {kind: 'task.started', task: 'stopped', attempt: 1},
    {kind: 'task.cancelled', task: 'stopped'},
  ];
  assert.deepEqual(agentsWorkspace(events).panes.map(pane => pane.id), ['orchestrator', 'worker:live']);
});

// U19: paneGrid reserves one cell for each divider, keeps all coordinates integral, and never
// makes a fifth pane unreadably small: it reports the overflow instead.
test('U19: paneGrid uses readable divider-aware layouts and reports overflow', () => {
  assert.deepEqual(paneGrid(1, 80, 24), {visible: 1, remaining: 0, panes: [{x: 0, y: 0, width: 80, height: 24}]});
  assert.deepEqual(paneGrid(2, 80, 24), {visible: 2, remaining: 0, panes: [
    {x: 0, y: 0, width: 39, height: 24}, {x: 40, y: 0, width: 40, height: 24},
  ]});
  assert.deepEqual(paneGrid(3, 80, 25), {visible: 3, remaining: 0, panes: [
    {x: 0, y: 0, width: 39, height: 25}, {x: 40, y: 0, width: 40, height: 12}, {x: 40, y: 13, width: 40, height: 12},
  ]});
  assert.deepEqual(paneGrid(4, 80, 25), {visible: 4, remaining: 0, panes: [
    {x: 0, y: 0, width: 39, height: 12}, {x: 40, y: 0, width: 40, height: 12}, {x: 0, y: 13, width: 39, height: 12}, {x: 40, y: 13, width: 40, height: 12},
  ]});
  assert.deepEqual(paneGrid(6, 80, 24), {visible: 4, remaining: 2, panes: [
    {x: 0, y: 0, width: 39, height: 11}, {x: 40, y: 0, width: 40, height: 11}, {x: 0, y: 12, width: 39, height: 12}, {x: 40, y: 12, width: 40, height: 12},
  ]});
});

// U20: command dispatch is classified before the busy gate. Commands own no main-turn state;
// only prompts and /continue may enter the turn queue while a provider is working.
test('U20: busy TUI input runs commands immediately and queues only turns', () => {
  assert.match(cliSource, /inputDisposition\(text, \{busy, vendorCommand\}\)/);
  assert.match(cliSource, /decision\.action === 'run-command'/);
  assert.match(cliSource, /decision\.action === 'queue-turn'/);
  assert.match(cliSource, /pendingTurns\.push\(text\)/);
  assert.equal(/busy && \/\^\\\/btw/.test(cliSource), false);
});

// U21: /agents is a real split-pane workspace, not the old single-worker transcript mode.
test('U21: the TUI renders and focuses the orchestrator plus worker pane grid', () => {
  assert.match(cliSource, /createInkTerminal\(/);
  assert.match(cliSource, /terminal\?\.ingest\(event\)/);
  assert.match(cliSource, /command === 'agents'/);
  assert.match(cliSource, /selectedAgentPane/);
});
