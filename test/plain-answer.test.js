// Decided by Daniel on 2026-09-29, to be measured on real sessions: a worker ends with a plain answer
// and bounce makes the report from it, instead of asking for a report in a fixed format. Found live
// (ACE e3bd01d5): of 67 reports 18 were rejected as invalid and 19 rewritten by bounce. `reports:
// "structured"` in config.json brings the fixed format back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session, config} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createBus} from '../src/bus.js';
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

async function setup(t, {worker, reportFormat = 'plain'}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-plain-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), {recursive: true});
  fs.writeFileSync(path.join(project, 'src/x.js'), 'export const state = "old";\n');
  const session = new Session(project, {root: path.join(root, 'home')});
  const seen = [];
  let bus = null;
  const base = fakeAdapter(args => { seen.push(args); return worker(args); });
  // The fake files a final report by itself when it has a report endpoint. This worker does as it is
  // asked: it answers in plain words and files nothing at the end.
  const plainly = start => async args => Object.assign(await start(args), {report: null});
  const adapters = {worker: {...base, launch: plainly(base.launch), resume: plainly(base.resume), capabilities: () => ({commands: true})}};
  const profiles = {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}, reviewer: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'reviewer', policy: 'read-only'}};
  const scheduler = createScheduler({session, adapters, profiles, requireFinalReport: true, reportFormat, gitHead: () => null,
    // a worker with a report endpoint, as in the daemon: that is what puts the reporting instructions in its orders
    reportGrant: ({task, attempt, context}) => ({BOUNCE_REPORT_BUS: bus.path, BOUNCE_REPORT_TOKEN_FILE: bus.grant({peer: `report:${task}:${attempt}`, tasks: [task], context, report: {task, attempt}}).file})});
  bus = await createBus({session, dir: session.dir, report: scheduler.report});
  t.after(async () => { scheduler.close(); await bus.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const submit = (extra = {}) => scheduler.submit({parent: null, profile: 'builder', orders: 'Make state "new" in src/x.js', requires: ['read', 'write'], deadline: null, ...extra});
  const settled = task => waitFor(() => ['completed', 'accepted', 'blocked', 'failed'].includes(scheduler.tasks()[task]?.state) && scheduler.tasks()[task].state);
  const rows = (kind, task) => session.events.filter(e => e.kind === kind && e.task === task);
  return {session, scheduler, seen, submit, settled, rows};
}
const change = cwd => fs.writeFileSync(path.join(cwd, 'src/x.js'), 'export const state = "new";\n');
const ENDING = 'End your last turn with a plain answer in your own words: what you did, each check you ran with the last lines it printed, and what is left of this assignment. No JSON and no report call for the end. If you could not finish, begin the answer with "Blocked:" or "Failed:" and say why.';

test('a worker is asked for a plain answer, and that answer is its report', async t => {
  const answer = 'State is now "new" in src/x.js.\n\nI ran the tests: ok | 3 passed | 0 failed.\n\n## Remaining\nNothing.';
  const f = await setup(t, {worker: ({cwd}) => {
    change(cwd);
    return [{kind: 'activity', text: 'edit completed', call: 'edit src/x.js', change: true}, {kind: 'command', command: 'npm test', exit: 0, output: 'ok | 3 passed | 0 failed'},
      {kind: 'result', status: 'completed', text: answer}];
  }});
  const {task} = f.submit();
  assert.equal(await f.settled(task), 'completed');

  const orders = f.seen[0].orders;
  assert.equal(orders.includes(ENDING), true, orders);
  assert.equal(orders.includes('"final"'), false, 'the fixed format is not asked for');
  assert.equal(orders.includes('op ("milestone" | "blocked" | "input_required")'), true, 'progress reports stay');
  const [reported] = f.rows('task.reported', task);
  assert.deepEqual([reported.outcome, reported.phase, reported.summary, reported.text, reported.remaining],
    ['completed', 'answer', 'State is now "new" in src/x.js.', answer, 'Nothing.']);
  assert.deepEqual(reported.evidence, ['Seen by bounce, not reported by the worker: `npm test` ended with exit code 0. The end of its output:\nok | 3 passed | 0 failed']);
  // a plain answer is what was asked for: nothing about it is invalid, and bounce did not have to make it up
  assert.equal(f.rows('task.report.invalid', task).length, 0);
  assert.equal(f.rows('task.report.synthesized', task).length, 0);
});

test('a plain answer that begins with Blocked or Failed ends the task that way', async t => {
  let text = 'Blocked: the fixture needs Docker, which these orders do not grant.';
  const f = await setup(t, {worker: () => [{kind: 'result', status: 'completed', text}]});
  const blocked = f.submit();
  assert.equal(await f.settled(blocked.task), 'blocked');
  assert.equal(f.rows('task.blocked', blocked.task).at(-1).reason, 'worker_blocked');

  text = 'Failed: the suite has 7 failures I could not repair.';
  const failed = f.submit({orders: 'again'});
  assert.equal(await f.settled(failed.task), 'failed');
  assert.equal(f.rows('task.failed', failed.task).at(-1).reason, 'reported_failure');
});

test('a worker that gave no answer still has its report made up by bounce, and the journal says so', async t => {
  const f = await setup(t, {worker: ({cwd}) => {
    change(cwd);
    return [{kind: 'result', status: 'failed', recoverable: true, text: 'opencode finished without an answer'}];
  }});
  const {task} = f.submit();
  assert.equal(await f.settled(task), 'completed');
  assert.deepEqual(f.rows('task.report.synthesized', task).map(row => row.rule), ['from_changes']);
});

test('reports: "structured" keeps the fixed format, and only the two values are accepted', async t => {
  const f = await setup(t, {reportFormat: 'structured', worker: ({cwd}) => { change(cwd); return [{kind: 'result', status: 'completed', text: 'Done, in plain words.'}]; }});
  const {task} = f.submit();
  assert.equal(await f.settled(task), 'completed');
  assert.equal(f.seen[0].orders.includes('A final report additionally requires outcome'), true);
  assert.equal(f.seen[0].orders.includes(ENDING), false);
  assert.equal(f.rows('task.report.invalid', task).length, 1);
  assert.equal(f.rows('task.report.synthesized', task).length, 1);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-plain-config-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const saved = value => { fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(value)); return config(home); };
  assert.equal(saved({}).reports, undefined); // the daemon takes that as plain
  assert.equal(saved({reports: 'structured'}).reports, 'structured');
  assert.throws(() => saved({reports: 'json'}), /reports must be "plain" or "structured"/);
  assert.throws(() => createScheduler({session: f.session, adapters: {}, profiles: {}, reportFormat: 'json'}), /reportFormat/);
});

// Found live (ACE e3bd01d5, task p7_stack_ergonomics_review, 2026-09-30): a reviewer wrote a proper review
// ending "**FAIL** — 3 blockers and 4 majors", and bounce marked the task failed (reported_failure): the
// verdict was read as the worker's own status. For a reviewer the verdict is the deliverable; the review
// itself succeeded. Only "Blocked:" about the reviewing still ends the task that way.
test('a reviewer whose verdict is FAIL has done its job: the task completes, it does not fail', async t => {
  let text = 'Reviewed the candidate against the orders.\n\n## Summary\n\n**FAIL** — 3 blockers and 4 majors.\n\nVerdict: FAIL\n\nBlockers:\n1. stdin is not inherited.';
  const f = await setup(t, {worker: () => [{kind: 'result', status: 'completed', text}]});
  const review = f.submit({profile: 'reviewer', orders: 'Review the candidate. Report PASS or FAIL first.', requires: ['read']});
  assert.equal(await f.settled(review.task), 'completed'); // no completion review in this harness: it waits for the orchestrator, as any finished task
  assert.equal(f.rows('task.reported', review.task).at(-1).outcome, 'completed');
  assert.equal(f.rows('task.failed', review.task).length, 0);

  text = 'Blocked: the candidate folder does not exist, nothing to review.';
  const blocked = f.submit({profile: 'reviewer', orders: 'Review again', requires: ['read']});
  assert.equal(await f.settled(blocked.task), 'blocked');

  // a builder saying FAIL still fails, as before
  text = 'Verdict: FAIL — the suite has 7 failures I could not repair.';
  const builder = f.submit({orders: 'build'});
  assert.equal(await f.settled(builder.task), 'failed');
});
