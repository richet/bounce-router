import test from 'node:test';
import assert from 'node:assert/strict';
import {peers, tasks, budgets, cooldowns, watchdog} from '../src/reducers.js';

// F4/A7: the reducer's own row fields hold absolute timestamps (a moment), not durations —
// named lastActivityAt/lastProgressAt so nothing reads them as elapsed ms by mistake. The
// policy's own evidence object (src/scheduler.js) is the only place the duration names survive.
test('watchdog row fields lastActivityAt/lastProgressAt are absolute timestamps, not durations', () => {
  const events = [
    {kind: 'task.submitted', task: 't1', time: '1970-01-01T00:00:00.000Z', deadline: null},
    {kind: 'task.started', task: 't1', time: '1970-01-01T00:00:00.000Z', attempt: 1},
  ];
  const now = 130000; // 130s: past the 120s silence threshold with no activity/progress at all
  const rows = watchdog(events, now, {activity: new Map(), watchdog: {silence: 120000, stall: 600000, defaultDeadlineMs: 900000}});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastActivityAt, 0); // the task's own first task.started, in ms
  assert.equal(rows[0].lastProgressAt, 0);
  assert.equal('sinceActivity' in rows[0], false);
  assert.equal('sinceProgress' in rows[0], false);
  assert.deepEqual(rows[0].verdicts, ['silent']);
});

test('peers folds joined, native and left by peer name, later rows winning', () => {
  const events = [
    {kind: 'peer.joined', from: 'worker:parse', time: 't1', role: 'worker', adapter: 'claude', profile: 'default'},
    {kind: 'peer.native', from: 'worker:parse', time: 't2', provider: 'claude', sessionId: 'sess-1'},
    {kind: 'peer.joined', from: 'worker:parse', time: 't3', role: 'worker', adapter: 'claude', profile: 'fast'},
    {kind: 'peer.left', from: 'worker:parse', time: 't4'},
  ];
  assert.deepEqual(peers(events), {
    'worker:parse': {name: 'worker:parse', role: 'worker', adapter: 'claude', profile: 'fast', joined: 't3', left: 't4', native: {provider: 'claude', sessionId: 'sess-1'}},
  });
});

test('tasks fold state transitions and milestones, and stay terminal once completed', () => {
  const base = [
    {kind: 'task.submitted', task: 't1', context: 'ctx-1', time: 't0', parent: null, profile: 'default', deadline: 'd1', budget: {starts: 3}},
    {kind: 'task.started', task: 't1', time: 't1', attempt: 1},
  ];
  assert.equal(tasks(base).t1.state, 'running');
  const blocked = [...base, {kind: 'task.blocked', task: 't1', time: 't2', text: 'waiting on approval'}];
  const blockedView = tasks(blocked).t1;
  assert.equal(blockedView.state, 'blocked');
  assert.equal(blockedView.blocker, 'waiting on approval');
  const resumed = [...blocked, {kind: 'task.milestone', task: 't1', time: 't3', text: 'approved', evidence: 'log-1'}];
  const resumedView = tasks(resumed).t1;
  assert.equal(resumedView.state, 'running');
  assert.deepEqual(resumedView.lastMilestone, {time: 't3', text: 'approved', evidence: 'log-1'});
  const completed = [...resumed, {kind: 'task.completed', task: 't1', time: 't4', summary: 'done', artifacts: ['out.txt']}];
  const completedView = tasks(completed).t1;
  assert.equal(completedView.state, 'completed');
  assert.equal(completedView.summary, 'done');
  assert.deepEqual(completedView.artifacts, ['out.txt']);
  const lateMilestone = [...completed, {kind: 'task.milestone', task: 't1', time: 't5', text: 'ignored', evidence: null}];
  assert.equal(tasks(lateMilestone).t1.state, 'completed');
  assert.deepEqual(tasks(lateMilestone).t1.lastMilestone, {time: 't3', text: 'approved', evidence: 'log-1'});

  const failed = [{kind: 'task.submitted', task: 't2', context: 'ctx-1', time: 't0', parent: null, profile: 'default', deadline: 'd1', budget: {starts: 3}}, {kind: 'task.failed', task: 't2', time: 't1', reason: 'limited', text: 'quota exhausted'}];
  const failedView = tasks(failed).t2;
  assert.equal(failedView.state, 'failed');
  assert.equal(failedView.reason, 'limited');
  assert.equal(failedView.error, 'quota exhausted');
  const secondFailure = [...failed, {kind: 'task.failed', task: 't2', time: 't2', reason: 'tests', text: 'tests failed'}];
  assert.equal(tasks(secondFailure).t2.reason, 'limited');
  assert.equal(tasks(secondFailure).t2.error, 'quota exhausted');
  assert.equal(tasks(secondFailure).t2.state, 'failed');
});

test('tasks ignores any task.* row for an id that was never submitted', () => {
  const events = [{kind: 'task.usage', task: 'ghost', time: 't0', usage: {starts: 1}}];
  assert.deepEqual(tasks(events), {});
});

test('a parent waits for its children and returns to its prior state once they all terminate', () => {
  const events = [
    {kind: 'task.submitted', task: 'root', context: 'ctx', time: 't0', parent: null, profile: 'default', deadline: 'd', budget: {starts: 5}},
    {kind: 'task.started', task: 'root', time: 't1', attempt: 1},
    {kind: 'task.submitted', task: 'child-a', context: 'ctx', time: 't2', parent: 'root', profile: 'default', deadline: 'd', budget: {starts: 1}},
  ];
  assert.equal(tasks(events).root.state, 'waiting');
  assert.deepEqual(tasks(events).root.children, ['child-a']);
  const secondChild = [...events, {kind: 'task.submitted', task: 'child-b', context: 'ctx', time: 't3', parent: 'root', profile: 'default', deadline: 'd', budget: {starts: 1}}];
  assert.equal(tasks(secondChild).root.state, 'waiting');
  const oneDone = [...secondChild, {kind: 'task.completed', task: 'child-a', time: 't4', summary: 'a done', artifacts: []}];
  assert.equal(tasks(oneDone).root.state, 'waiting');
  const bothDone = [...oneDone, {kind: 'task.failed', task: 'child-b', time: 't5'}];
  assert.equal(tasks(bothDone).root.state, 'running');
});

test('a waiting parent keeps waiting through its own progress events and remembers to resume running', () => {
  const events = [
    {kind: 'task.submitted', task: 'root', context: 'ctx', time: 't0', parent: null, profile: 'default', deadline: 'd', budget: {starts: 5}},
    {kind: 'task.submitted', task: 'child', context: 'ctx', time: 't1', parent: 'root', profile: 'default', deadline: 'd', budget: {starts: 1}},
  ];
  assert.equal(tasks(events).root.state, 'waiting');
  const ownStarted = [...events, {kind: 'task.started', task: 'root', time: 't2', attempt: 1}];
  const startedView = tasks(ownStarted).root;
  assert.equal(startedView.state, 'waiting');
  assert.equal(startedView.attempt, 1);
  const ownMilestone = [...ownStarted, {kind: 'task.milestone', task: 'root', time: 't3', text: 'progress', evidence: 'log-1'}];
  const milestoneView = tasks(ownMilestone).root;
  assert.equal(milestoneView.state, 'waiting');
  assert.deepEqual(milestoneView.lastMilestone, {time: 't3', text: 'progress', evidence: 'log-1'});
  const childDone = [...ownMilestone, {kind: 'task.completed', task: 'child', time: 't4', summary: 'done', artifacts: []}];
  assert.equal(tasks(childDone).root.state, 'running');
});

test('a late parent submission joins an already-waiting state instead of overwriting it to queued', () => {
  const events = [
    {kind: 'task.submitted', task: 'child', context: 'ctx', time: 't0', parent: 'root', profile: 'default', deadline: 'd', budget: {starts: 1}},
  ];
  assert.equal(tasks(events).root.state, 'waiting');
  const parentSubmitted = [...events, {kind: 'task.submitted', task: 'root', context: 'ctx', time: 't1', parent: null, profile: 'default', deadline: 'd', budget: {starts: 5}}];
  assert.equal(tasks(parentSubmitted).root.state, 'waiting');
  const childDone = [...parentSubmitted, {kind: 'task.completed', task: 'child', time: 't2', summary: 'done', artifacts: []}];
  assert.equal(tasks(childDone).root.state, 'queued');
});

test('budgets sum reservations, releases and usage across a task tree, per root, with no orphans', () => {
  const events = [
    {kind: 'task.submitted', task: 'root', context: 'ctx', time: 't0', parent: null, profile: 'default', deadline: 'd', budget: {starts: 5}},
    {kind: 'task.submitted', task: 'child', context: 'ctx', time: 't1', parent: 'root', profile: 'default', deadline: 'd', budget: {starts: 1}},
    {kind: 'budget.reserved', task: 'root', time: 't2', amount: {starts: 2}},
    {kind: 'budget.reserved', task: 'child', time: 't3', amount: {starts: 1}},
    {kind: 'budget.released', task: 'child', time: 't4', amount: {starts: 1}},
    {kind: 'task.usage', task: 'root', time: 't5', usage: {starts: 1}},
  ];
  const view = budgets(events);
  assert.deepEqual(view.roots.root, {root: 'root', allowance: {starts: 5}, reserved: {starts: 3}, released: {starts: 1}, remaining: {starts: 3}, usage: {starts: 1}, measured: false});
  assert.deepEqual(view.orphans, {reserved: {}, released: {}, usage: {}, tasks: []});
  const withChildUsage = [...events, {kind: 'task.usage', task: 'child', time: 't6', usage: {starts: 2}}];
  const measuredView = budgets(withChildUsage).roots.root;
  assert.equal(measuredView.measured, true);
  assert.deepEqual(measuredView.usage, {starts: 3});
});

test('budgets tracks orphan budget/usage rows against ids that were never submitted', () => {
  const events = [{kind: 'budget.reserved', task: 'ghost', time: 't0', amount: {starts: 2}}];
  const view = budgets(events);
  assert.deepEqual(view.roots, {});
  assert.deepEqual(view.orphans, {reserved: {starts: 2}, released: {}, usage: {}, tasks: ['ghost']});
});

test('cooldowns track the latest row per provider and drop expired entries', () => {
  const events = [
    {kind: 'cooldown', provider: 'claude', time: 't0', until: 1000},
    {kind: 'cooldown', provider: 'codex', time: 't1', until: 500},
    {kind: 'cooldown', provider: 'claude', time: 't2', until: 2000},
  ];
  assert.deepEqual(cooldowns(events, 100), {claude: 2000, codex: 500});
  assert.deepEqual(cooldowns(events, 500), {claude: 2000});
  assert.deepEqual(cooldowns(events, 2000), {});
});

test('reducers are pure: the same event array yields deepEqual results every call and views never alias the log', () => {
  const events = [
    {kind: 'task.submitted', task: 't1', context: 'ctx', time: 't0', parent: null, profile: 'default', deadline: 'd', budget: {starts: 2}},
    {kind: 'task.completed', task: 't1', time: 't1', summary: 'done', artifacts: ['a.txt']},
    {kind: 'peer.joined', from: 'worker:parse', time: 't2', role: 'worker', adapter: 'claude', profile: 'default'},
    {kind: 'cooldown', provider: 'claude', time: 't3', until: 5000},
  ];
  const snapshot = structuredClone(events);
  assert.deepEqual(tasks(events), tasks(events));
  assert.deepEqual(peers(events), peers(events));
  assert.deepEqual(budgets(events), budgets(events));
  assert.deepEqual(cooldowns(events, 100), cooldowns(events, 100));
  const view = tasks(events);
  view.t1.budget.starts = 999;
  view.t1.artifacts.push('mutated');
  assert.deepEqual(events, snapshot);
});

test('a replacement task (replaces) draws on the replaced task root budget and is not a new root', () => {
  const ev = [
    {kind: 'task.submitted', task: 'r', parent: null, budget: {starts: 3}, time: 't0'},
    {kind: 'budget.reserved', task: 'r', amount: {starts: 1}},
    {kind: 'task.failed', task: 'r', reason: 'limited', time: 't1'},
    {kind: 'task.submitted', task: 'r2', parent: null, replaces: 'r', time: 't2'},
    {kind: 'budget.reserved', task: 'r2', amount: {starts: 1}},
  ];
  const view = budgets(ev);
  assert.deepEqual(Object.keys(view.roots), ['r']);
  assert.equal(view.roots.r.remaining.starts, 1);
  assert.equal(tasks(ev).r2.replaces, 'r');
  assert.deepEqual(view.orphans.tasks, []);
});

test('a self-referencing or cyclic parent/replaces chain never recurses forever', () => {
  const cyclic = [
    {kind: 'task.submitted', task: 'a', parent: 'a', time: 't0'},
    {kind: 'task.submitted', task: 'b', parent: 'c', time: 't1'},
    {kind: 'task.submitted', task: 'c', parent: 'b', time: 't2'},
    {kind: 'task.submitted', task: 'd', replaces: 'd', time: 't3'},
  ];
  const view = budgets(cyclic);
  // Each member of a mutual cycle resolves to itself: the chain stops at the first revisited id.
  assert.deepEqual(Object.keys(view.roots).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(view.orphans.tasks, []);
});
