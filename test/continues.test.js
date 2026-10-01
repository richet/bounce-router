// docs/plans/standing-workers.md step 2 (Daniel, 2026-10-01): a task that continues an earlier one resumes
// that task's worker session into the new task's own copy instead of launching a stranger. Measured on ACE
// e3bd01d5: 21 of 54 local builder sessions were continuations, each re-reading 13 files and 1.4 minutes
// before its first edit. Probed 2026-10-01 with the real CLIs: OpenCode, Claude and Codex all edit the new
// copy when resumed into it and told where it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (fn, timeout = 5000) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const ownReport = summary => JSON.stringify({op: 'final', phase: 'complete', text: summary, next: '', evidence: ['npm test: 3 passed'], outcome: 'completed', summary, remaining: ''});
const says = word => `node -e "process.exit(require('fs').readFileSync('src/x.js','utf8').includes('${word}')?0:1)"`;

function setup(t, {worker, native = true}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-continues-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), {recursive: true});
  fs.writeFileSync(path.join(project, 'src/x.js'), 'export const state = "old";\n');
  const session = new Session(project, {root: path.join(root, 'home')});
  let turns = 0;
  // a resumed session keeps its id, as the real adapters' do; a fresh launch gets a new one
  const script = args => { turns += 1; const events = worker(args, turns); return native ? [{kind: 'native', provider: 'worker', sessionId: args.native?.sessionId ?? `s-${turns}`}, ...events] : events; };
  const adapters = {worker: {...fakeAdapter(script), capabilities: () => ({compacts: true})}, other: fakeAdapter(script), reviewer: fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify({verdict: 'accept', findings: []})}])};
  const profiles = {
    builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write', agent: {name: 'builder', description: 'builds', policy: 'write', prompt: 'You are a builder.'}},
    builder_other: {adapter: 'other', model: 'o', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'},
    critic: {adapter: 'reviewer', model: 'r', mode: 'yolo', fallback: [], role: 'reviewer', policy: 'read-only'},
  };
  const scheduler = createScheduler({session, adapters, profiles, requireFinalReport: true, gitHead: () => null});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const submit = (extra = {}) => scheduler.submit({parent: null, profile: 'builder', orders: 'Make state "new" in src/x.js', owns: ['src/x.js'], deadline: null, check: says('new'), review: {completion: 'critic'}, ...extra});
  const settled = task => waitFor(() => ['completed', 'accepted', 'blocked', 'failed'].includes(scheduler.tasks()[task]?.state) && scheduler.tasks()[task].state);
  const rows = (kind, task) => session.events.filter(e => e.kind === kind && e.task === task);
  const copyOf = task => session.events.findLast(e => e.kind === 'task.artifact' && e.task === task)?.cwd ?? null;
  return {session, scheduler, adapters, submit, settled, rows, copyOf};
}
const write = (cwd, word) => fs.writeFileSync(path.join(cwd, 'src/x.js'), `export const state = "${word}";\n`);

test('a task that continues an earlier one resumes that worker\'s session into its own new copy, told where it is', async t => {
  const seen = [];
  const f = setup(t, {worker: (args, turn) => { seen.push(args); write(args.cwd, turn === 1 ? 'new' : 'newer'); return [{kind: 'result', status: 'completed', text: ownReport(`state is now ${turn === 1 ? 'new' : 'newer'}`)}]; }});
  const first = f.submit();
  assert.equal(await f.settled(first.task), 'accepted');
  const second = f.submit({orders: 'Now make state "newer" in src/x.js', continues: first.task, check: says('newer')});
  assert.equal(await f.settled(second.task), 'accepted');

  assert.deepEqual([f.adapters.worker.calls.launch, f.adapters.worker.calls.resume], [1, 1], 'one launch for the first task, one resume for the continuation');
  const resumed = f.adapters.worker.resumeCalls[0];
  assert.equal(resumed.native.sessionId, 's-1', 'the first task\'s session is the one resumed');
  const copyA = f.copyOf(first.task), copyB = f.copyOf(second.task);
  assert.notEqual(copyA, copyB, 'the continuation has its own copy');
  assert.equal(resumed.cwd, copyB);
  assert.equal(resumed.message.startsWith(`You continue the task you did before; this is what happens next. Your working copy for this task is ${copyB} — the copy you worked in before is gone; nothing you did there is lost: what was accepted is in the project, and this copy was taken from it.\n\n`), true, resumed.message.slice(0, 400));
  assert.equal(resumed.message.includes('Now make state "newer"'), true);
  const launched = f.rows('task.launch.requested', second.task)[0];
  assert.deepEqual([launched.continued, launched.continues], [true, first.task]);
  assert.equal(f.session.events.find(e => e.kind === 'task.submitted' && e.task === second.task).continues, first.task);
  assert.equal(fs.readFileSync(path.join(f.session.cwd, 'src/x.js'), 'utf8'), 'export const state = "newer";\n');
});

test('a continuation launches fresh, and says why, when the earlier task ran on another profile or left no session', async t => {
  const f = setup(t, {worker: args => { write(args.cwd, 'new'); return [{kind: 'result', status: 'completed', text: ownReport('state is now new')}]; }});
  const first = f.submit();
  assert.equal(await f.settled(first.task), 'accepted');
  const other = f.submit({profile: 'builder_other', continues: first.task});
  assert.equal(await f.settled(other.task), 'accepted');
  assert.deepEqual([f.adapters.other.calls.launch, f.adapters.other.calls.resume], [1, 0]);
  assert.deepEqual([f.rows('task.launch.requested', other.task)[0].continued, f.rows('task.launch.requested', other.task)[0].reason], [false, `the earlier task ran as builder, this one as builder_other`]);

  const g = setup(t, {native: false, worker: args => { write(args.cwd, 'new'); return [{kind: 'result', status: 'completed', text: ownReport('state is now new')}]; }});
  const a = g.submit();
  assert.equal(await g.settled(a.task), 'accepted');
  const b = g.submit({continues: a.task});
  assert.equal(await g.settled(b.task), 'accepted');
  assert.deepEqual([g.adapters.worker.calls.launch, g.adapters.worker.calls.resume], [2, 0]);
  assert.equal(g.rows('task.launch.requested', b.task)[0].reason, 'the earlier task left no session to resume');
  assert.throws(() => g.submit({continues: 'no-such-task'}), /continues/);
});

// docs/plans/standing-workers.md step 3: a worker is a standing session per agent. A new task for the agent
// goes to its idle standing worker by itself (a continuation of that worker's last task); a busy standing
// worker means a second one is started, so parallel work stays parallel (deviation from the plan's "waits",
// 2026-10-01); `worker.retire` ends one, with an optional handoff that opens the next.
test('a new task for an agent continues its idle standing worker by itself, and a busy one gets a second worker', async t => {
  const gates = new Map();
  const f = setup(t, {worker: (args, turn) => { write(args.cwd, 'new'); const release = new Promise(resolve => gates.set(turn, resolve)); return [release.then(() => ({kind: 'result', status: 'completed', text: ownReport('state is now new')}))]; }});
  const first = f.submit();
  await waitFor(() => gates.has(1));
  // the standing worker is busy with the first task: the second task starts a second worker
  const second = f.submit({orders: 'another area'});
  await waitFor(() => gates.has(2));
  assert.deepEqual([f.adapters.worker.calls.launch, f.adapters.worker.calls.resume], [2, 0]);
  assert.deepEqual(f.rows('task.launch.requested', first.task)[0].worker, 'builder#1');
  assert.deepEqual(f.rows('task.launch.requested', second.task)[0].worker, 'builder#2');
  gates.get(1)(); gates.get(2)();
  assert.equal(await f.settled(first.task), 'accepted');
  assert.equal(await f.settled(second.task), 'accepted');

  // both idle: the third task continues the one that finished last (by journal order; which of the two that
  // is depends on how the two releases above raced), without the orchestrator asking
  const third = f.submit({orders: 'a follow-up'});
  await waitFor(() => gates.has(3));
  gates.get(3)();
  assert.equal(await f.settled(third.task), 'accepted');
  assert.equal(f.adapters.worker.calls.resume, 1);
  const launched = f.rows('task.launch.requested', third.task)[0];
  const lastAccepted = f.session.events.filter(e => e.kind === 'task.accepted' && [first.task, second.task].includes(e.task)).at(-1).task;
  const expected = lastAccepted === first.task ? 'builder#1' : 'builder#2';
  assert.deepEqual([launched.continued, launched.worker], [true, expected]);
  assert.equal(f.session.events.find(e => e.kind === 'task.submitted' && e.task === third.task).worker, expected);
  assert.equal(f.adapters.worker.resumeCalls[0].native.sessionId, expected === 'builder#1' ? 's-1' : 's-2');
  // and a task that names a worker goes to that one
  const fourth = f.submit({orders: 'back to the first', worker: 'builder#1'});
  await waitFor(() => gates.has(4));
  gates.get(4)();
  assert.equal(await f.settled(fourth.task), 'accepted');
  assert.deepEqual([f.rows('task.launch.requested', fourth.task)[0].continued, f.rows('task.launch.requested', fourth.task)[0].worker], [true, 'builder#1']);
  assert.equal(f.adapters.worker.resumeCalls.at(-1).native.sessionId, 's-1');
});

test('a retired worker is not continued: the next task starts a fresh worker, opened with the handoff if one was given', async t => {
  const seen = [];
  const f = setup(t, {worker: args => { seen.push(args); write(args.cwd, 'new'); return [{kind: 'result', status: 'completed', text: ownReport('state is now new')}]; }});
  const first = f.submit();
  assert.equal(await f.settled(first.task), 'accepted');
  const retired = await f.scheduler.retireWorker({worker: 'builder#1', handoff: 'The auth module is done; tests live under test/auth.', by: 'orchestrator'});
  assert.deepEqual([retired.kind, retired.worker, retired.handoff], ['worker.retired', 'builder#1', 'The auth module is done; tests live under test/auth.']);
  const next = f.submit({orders: 'Now the billing module'});
  assert.equal(await f.settled(next.task), 'accepted');
  assert.deepEqual([f.adapters.worker.calls.launch, f.adapters.worker.calls.resume], [2, 0]);
  const launched = f.rows('task.launch.requested', next.task)[0];
  assert.deepEqual([launched.worker, launched.continued], ['builder#2', undefined]);
  const orders = seen.at(-1).orders;
  assert.equal(orders.includes('From the worker before you, who was retired: The auth module is done; tests live under test/auth.'), true, orders.slice(0, 300));
  await assert.rejects(f.scheduler.retireWorker({worker: 'builder#9'}), /no such worker/);
  // and the orchestrator can ask for a fresh worker on purpose
  const fresh = f.submit({orders: 'start over', worker: 'new'});
  assert.equal(await f.settled(fresh.task), 'accepted');
  assert.deepEqual([f.rows('task.launch.requested', fresh.task)[0].worker, f.adapters.worker.calls.resume], ['builder#3', 0]);
});

// docs/plans/standing-workers.md §3, step 4 (Daniel, 2026-10-01: "introduce the handoff too and check on
// compact"). Probed with the real Claude CLI: `/compact` on a resumed session cut the next turn's context from
// ~173k to ~38k tokens and the worker still knew what it had done. A retiring worker can be asked for its own
// handoff: one more turn on its session, read-only, and its answer opens the next worker of that job.
test('a worker compacts on request through its own session, and a retiring worker asked for a handoff writes it', async t => {
  const seen = [];
  const f = setup(t, {worker: (args, turn) => {
    seen.push(args);
    if (args.message === '/compact') return [{kind: 'result', status: 'completed', text: ''}];
    if (/write the handoff/i.test(args.message ?? '')) return [{kind: 'result', status: 'completed', text: 'Handoff: state lives in src/x.js; the check is says(new); nothing is left open.'}];
    write(args.cwd, 'new'); return [{kind: 'result', status: 'completed', text: ownReport('state is now new')}];
  }});
  const first = f.submit();
  assert.equal(await f.settled(first.task), 'accepted');

  const compacted = await f.scheduler.compactWorker({worker: 'builder#1', by: 'orchestrator'});
  assert.deepEqual([compacted.kind, compacted.worker, compacted.status], ['worker.compacted', 'builder#1', 'completed']);
  assert.equal(seen.at(-1).message, '/compact');
  assert.equal(seen.at(-1).native.sessionId, 's-1');
  assert.equal(seen.at(-1).profile.policy, 'read-only', 'a side turn on a worker never writes');
  assert.equal(f.scheduler.tasks()[first.task].state, 'accepted', 'a side turn is not a task');

  const retired = await f.scheduler.retireWorker({worker: 'builder#1', ask: true, by: 'orchestrator'});
  assert.equal(retired.kind, 'worker.retired');
  assert.equal(retired.handoff, 'Handoff: state lives in src/x.js; the check is says(new); nothing is left open.');
  assert.equal(seen.at(-1).message.startsWith('You are being retired; a new worker takes over your job in this project. Write the handoff'), true, seen.at(-1).message.slice(0, 200));
  const next = f.submit({orders: 'carry on'});
  assert.equal(await f.settled(next.task), 'accepted');
  assert.equal(seen.at(-1).orders.includes('From the worker before you, who was retired: Handoff: state lives in src/x.js'), true);
  await assert.rejects(f.scheduler.compactWorker({worker: 'builder#1'}), /retired/);
});
