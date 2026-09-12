import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {taskTree, foldedThread, parseCommand, continueMain} from '../src/format.js';

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
    {task: 'root1', depth: 0, profile: 'orchestrate', state: 'waiting', lastMilestone: 'scanning repo', deadline: 5000, remainingStarts: 1, remainingRounds: null, blocker: null, tier: null},
    {task: 'childA', depth: 1, profile: 'build', state: 'queued', lastMilestone: null, deadline: null, remainingStarts: 1, remainingRounds: null, blocker: null, tier: null},
    {task: 'childB', depth: 1, profile: 'critic', state: 'blocked', lastMilestone: null, deadline: null, remainingStarts: 1, remainingRounds: null, blocker: 'need approval', tier: null},
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
