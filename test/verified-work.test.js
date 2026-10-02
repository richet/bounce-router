// Found live (ACE d1bc0206, task 99bd27ea, 2026-09-28): a local worker ended twice without an answer,
// bounce wrote its report from the file changes, the review objected both times, and after the one
// send-back the work was put into the checkout with nobody having verified it. Daniel, same day:
// a task can name a check that bounce runs in the worker's copy, and the work is integrated only
// if it passes; work that nothing verified is kept and handed to the orchestrator, not integrated;
// and a report bounce has to write carries what bounce saw the worker run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {defaultStrategy} from '../src/strategy.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {handoffBlock} from '../src/main-service.js';

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
const verdict = (value, findings = []) => [{kind: 'result', status: 'completed', text: JSON.stringify({verdict: value, findings})}];

// A project folder, a separate bounce home, a write worker that runs in its own copy, and a reviewer.
function setup(t, {worker, reviewer = () => verdict('accept')}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-verified-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), {recursive: true});
  fs.writeFileSync(path.join(project, 'src/x.js'), 'export const state = "old";\n');
  const session = new Session(project, {root: path.join(root, 'home')});
  // like OpenCode, this worker passes on the commands it runs
  const adapters = {worker: {...fakeAdapter(worker), capabilities: () => ({commands: true})}, reviewer: fakeAdapter(reviewer)};
  const profiles = {
    builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'},
    critic: {adapter: 'reviewer', model: 'r', mode: 'yolo', fallback: [], role: 'reviewer', policy: 'read-only'},
  };
  const scheduler = createScheduler({session, adapters, profiles, requireFinalReport: true, gitHead: () => null});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const submit = (extra = {}) => scheduler.submit({parent: null, profile: 'builder', orders: 'Make state "new" in src/x.js', owns: ['src/x.js'], deadline: null, review: {completion: 'critic'}, ...extra});
  const settled = task => waitFor(() => ['accepted', 'blocked', 'failed'].includes(scheduler.tasks()[task]?.state) && scheduler.tasks()[task].state);
  const inCheckout = () => fs.readFileSync(path.join(project, 'src/x.js'), 'utf8');
  const rows = (kind, task) => session.events.filter(e => e.kind === kind && e.task === task);
  const copyOf = task => session.events.findLast(e => e.kind === 'task.artifact' && e.task === task).cwd;
  return {session, scheduler, adapters, submit, settled, inCheckout, rows, copyOf};
}
const write = (cwd, text) => fs.writeFileSync(path.join(cwd, 'src/x.js'), text);
// a check that runs something: it passes when src/x.js says the word
const says = word => `node -e "process.exit(require('fs').readFileSync('src/x.js','utf8').includes('${word}')?(console.log('found'),0):1)"`;
const edited = {kind: 'activity', text: 'edit completed', call: 'edit src/x.js', change: true};
const ran = (command, exit, output) => ({kind: 'command', command, exit, output});

test('a report bounce has to write carries the commands bounce saw run after the last file change', async t => {
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "new";\n');
    return [ran('npm test', 1, '# fail 1'), edited, ran('npm test', 0, '# pass 3\n# fail 0'), ran('npm run lint', null, ''),
      {kind: 'result', status: 'completed', text: 'All done, the tests pass.'}];
  }});
  const {task} = f.submit({check: says('new')});
  assert.equal(await f.settled(task), 'accepted');

  const reported = f.rows('task.reported', task).at(-1);
  assert.equal(reported.summary, 'All done, the tests pass.');
  assert.deepEqual(reported.evidence, [
    'Seen by bounce, not reported by the worker: `npm test` ended with exit code 0. The end of its output:\n# pass 3\n# fail 0',
    'Seen by bounce, not reported by the worker: `npm run lint` ended (no exit code reported). It printed nothing.',
  ]);
  assert.deepEqual(f.rows('task.report.synthesized', task).at(-1).sources.evidence, 'observed');
  // the reviewer is given the same evidence
  assert.deepEqual(f.adapters.reviewer.calls.launch, 1);
});

test('a report bounce has to write says so when nothing was run after the last file change; the worker\'s own report is left as written', async t => {
  let round = 0;
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "new";\n');
    round += 1;
    return round === 1
      ? [ran('npm test', 0, '# pass 3'), edited, {kind: 'result', status: 'completed', text: 'Changed it.'}]
      : [ran('npm test', 0, '# pass 3'), {kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const first = f.submit({check: says('new')});
  assert.equal(await f.settled(first.task), 'accepted');
  assert.deepEqual(f.rows('task.reported', first.task).at(-1).evidence,
    ['Seen by bounce: the worker ran no command after its last file change, so nothing it ran checked the final state.']);

  const second = f.submit({orders: 'again', check: says('new')});
  assert.equal(await f.settled(second.task), 'accepted');
  assert.deepEqual(f.rows('task.reported', second.task).at(-1).evidence, ['npm test: 3 passed']);
  assert.equal(f.rows('task.report.synthesized', second.task).length, 0);
});

test('a worker sent back after a report bounce wrote is told it stopped without its report, not that its report is wrong', async t => {
  let round = 0;
  const f = setup(t, {
    worker: ({cwd}) => {
      write(cwd, 'export const state = "new";\n');
      round += 1;
      return [{kind: 'native', provider: 'worker', sessionId: 's1'}, {kind: 'result', status: 'completed', text: round === 1 ? 'Let me fix both properly:' : ownReport('state is now "new"')}];
    },
    reviewer: () => (round === 1 ? verdict('rework', ['The report asserts outcomes without evidence.']) : verdict('accept')),
  });
  const {task} = f.submit({check: says('new')});
  assert.equal(await f.settled(task), 'accepted');

  assert.equal(f.adapters.worker.resumeCalls[0].message.split('\n\n')[0], [
    'Rework round 1. Your last turn ended without your final report, so bounce wrote one from what it saw you do.',
    'Continue the task from where you stopped, run its checks, and end with your own report: what you did, and the output of the checks you ran.',
    'What was found in the meantime:',
    '- The report asserts outcomes without evidence.',
  ].join('\n'));
});

test('a task\'s check runs in the worker\'s copy: a pass is integrated, and the review is shown its output', async t => {
  let shown = null;
  const f = setup(t, {
    worker: ({cwd}) => {
      write(cwd, 'export const state = "new";\n');
      return [{kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
    },
    reviewer: ({review}) => { shown = review.report.evidence; return verdict('accept'); },
  });
  const {task} = f.submit({check: says('new')});
  assert.equal(await f.settled(task), 'accepted');
  assert.deepEqual(shown, ['npm test: 3 passed', `bounce ran the task's check \`${says('new')}\` in the worker's copy: exit code 0. The end of its output:\nfound`]);

  const [check] = f.rows('task.check', task);
  assert.deepEqual([check.command, check.exit, check.passed, check.output, check.weak ?? false], [says('new'), 0, true, 'found', false]);
  assert.equal(f.inCheckout(), 'export const state = "new";\n');
  assert.deepEqual(f.adapters.reviewer.calls.launch, 1);
  assert.equal(f.session.events.find(e => e.kind === 'task.submitted' && e.task === task).check, says('new'));
});

test('a failing check sends the work back once with what it printed; a pass after that is integrated', async t => {
  let round = 0;
  const f = setup(t, {worker: ({cwd}) => {
    round += 1;
    write(cwd, round === 1 ? 'export const state = "broken";\n' : 'export const state = "new";\n');
    return [{kind: 'native', provider: 'worker', sessionId: 's1'}, {kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: 'grep new src/x.js || { echo "src/x.js does not say new"; exit 3; }'});
  assert.equal(await f.settled(task), 'accepted');

  assert.deepEqual(f.rows('task.check', task).map(row => [row.exit, row.passed]), [[3, false], [0, true]]);
  assert.deepEqual(f.rows('task.rework', task).map(row => row.findings), [[
    'The task\'s check failed. bounce ran `grep new src/x.js || { echo "src/x.js does not say new"; exit 3; }` in your working copy: exit code 3. The end of its output:\nsrc/x.js does not say new\nFix what it reports, and run it yourself before you finish.',
  ]]);
  assert.equal(f.adapters.reviewer.calls.launch, 1, 'a failing check is not reviewed: the review judges work that passes');
  assert.equal(f.inCheckout(), 'export const state = "new";\n');
});

test('a check that still fails after the one send-back holds the work: kept, not integrated, handed to the orchestrator', async t => {
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "broken";\n');
    return [{kind: 'native', provider: 'worker', sessionId: 's1'}, {kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: 'grep new src/x.js'});
  assert.equal(await f.settled(task), 'blocked');

  const blocked = f.rows('task.blocked', task).at(-1);
  assert.equal(blocked.reason, 'check_failed');
  assert.equal(blocked.text, 'The task\'s check still fails after its one rework round, so the work was not put in the checkout. bounce ran `grep new src/x.js` in the worker\'s copy: exit code 1. It printed nothing. The work is kept. Decide: send it back (task.rework with what to fix), retry it on another AI (retryOf), or accept it as it is (task.accepted with what you checked).');
  assert.equal(f.rows('task.rework', task).length, 1);
  assert.equal(f.rows('task.integrated', task).length, 0);
  assert.equal(f.inCheckout(), 'export const state = "old";\n');
  assert.equal(f.adapters.reviewer.calls.launch, 0);
});

test('work nothing verified is held, and says all that is missing: bounce wrote the report, the task names no check, and the review still objects after the send-back', async t => {
  const f = setup(t, {
    worker: ({cwd}) => {
      write(cwd, 'export const state = "new";\n');
      return [{kind: 'native', provider: 'worker', sessionId: 's1'}, edited, {kind: 'result', status: 'failed', recoverable: true, text: 'opencode finished without an answer'}];
    },
    reviewer: () => verdict('rework', ['An acceptance criterion in the orders is not met.']),
  });
  const {task} = f.submit();
  assert.equal(await f.settled(task), 'blocked');

  const blocked = f.rows('task.blocked', task).at(-1);
  assert.equal(blocked.reason, 'unverified');
  assert.equal(blocked.text, `Nothing that runs this work has verified it, so it waits for you and is not in the checkout: the task names no check, and the worker wrote no report (bounce wrote one from what it saw). After the one rework round the review still found: An acceptance criterion in the orders is not met. The work is in ${f.copyOf(task)}. Decide: accept it (task.accepted with what you checked), send it back (task.rework with what to fix), or retry it on another AI (retryOf).`);
  assert.equal(f.rows('task.integrated', task).length, 0);
  assert.equal(f.inCheckout(), 'export const state = "old";\n');
});

test('the same work with a check that passes is accepted with the review\'s findings as advice', async t => {
  const f = setup(t, {
    worker: ({cwd}) => {
      write(cwd, 'export const state = "new";\n');
      return [{kind: 'native', provider: 'worker', sessionId: 's1'}, edited, {kind: 'result', status: 'failed', recoverable: true, text: 'opencode finished without an answer'}];
    },
    reviewer: () => verdict('rework', ['An acceptance criterion in the orders is not met.']),
  });
  const {task} = f.submit({check: says('new')});
  assert.equal(await f.settled(task), 'accepted');

  assert.equal(f.inCheckout(), 'export const state = "new";\n');
  assert.match(f.rows('task.accepted', task).at(-1).advice, /^Accepted after its one rework round; the review still found: An acceptance criterion in the orders is not met\./);
  assert.deepEqual(f.rows('task.check', task).map(row => row.passed), [true, true]);
});

test('a check must be a command of reasonable length', t => {
  const f = setup(t, {worker: () => []});
  assert.throws(() => f.submit({check: ''}), /check/);
  assert.throws(() => f.submit({check: 42}), /check/);
  assert.throws(() => f.submit({check: 'x'.repeat(2001)}), /check/);
});

// The decisions themselves, without a scheduler.
const api = ({check = null, byBounce = false, reworked = false, changes = true} = {}) => ({unverifiedChanges: () => changes && !(check?.passed && !check.weak), copyOf: () => '/w/1a2b3c4d', submittedRow: () => ({review: {completion: 'critic'}}), lastRework: () => (reworked ? {round: 1} : null),
  lastFired: () => null, roundsUsed: () => (reworked ? 1 : 0), roundsCap: () => 3, remainingOf: () => '', checkOf: () => check, reportByBounce: () => byBounce});
const failed = {command: 'npm test', exit: 1, passed: false, output: '# fail 2'};
const passed = {command: 'npm test', exit: 0, passed: true, output: '# pass 3'};
const objection = [{verdict: 'rework', findings: ['x is missing']}];

test('strategy: a failing check decides before any review; a passing one lets the review run', () => {
  const view = {t: {state: 'reviewing'}};
  assert.deepEqual(defaultStrategy.onCompleted('t', view, api({check: passed})), {action: 'review', stage: 'completion', reviewers: ['critic'], quorum: 1});
  assert.equal(defaultStrategy.onCompleted('t', view, api({check: failed})).action, 'rework');
  assert.deepEqual([defaultStrategy.onCompleted('t', view, api({check: failed, reworked: true})).action, defaultStrategy.onCompleted('t', view, api({check: failed, reworked: true})).reason], ['escalate', 'check_failed']);
});

test('strategy: after the send-back, an objection holds only work that no check verified', () => {
  const view = {t: {state: 'reviewing'}};
  const decide = options => defaultStrategy.onReviewVerdict('t', objection, view, api({reworked: true, ...options}));
  assert.deepEqual([decide({byBounce: true}).action, decide({byBounce: true}).reason], ['escalate', 'unverified']);
  assert.deepEqual([decide({byBounce: false}).action, decide({byBounce: false}).reason], ['escalate', 'unverified']);
  assert.deepEqual(decide({byBounce: true, check: passed}), {action: 'accept', advice: 'Accepted after its one rework round; the review still found: x is missing. Decide whether a follow-up task is needed.'});
  assert.equal(decide({byBounce: false, changes: false}).action, 'accept');
  assert.equal(defaultStrategy.onReviewVerdict('t', objection, view, api({byBounce: true})).action, 'rework');
});

test('held work the orchestrator accepts after checking it itself is put in the checkout', async t => {
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "newer";\n');
    return [{kind: 'native', provider: 'worker', sessionId: 's1'}, {kind: 'result', status: 'completed', text: ownReport('state is now "newer"')}];
  }});
  const {task} = f.submit({check: 'grep -x "export const state = .new.;" src/x.js'});
  assert.equal(await f.settled(task), 'blocked');
  assert.equal(f.inCheckout(), 'export const state = "old";\n');

  f.scheduler.acceptOverride({kind: 'task.accepted', task, stage: 'completion', by: 'orchestrator', overrides: 'blocked', text: 'The check was too strict; "newer" is what the user asked for.'});
  await waitFor(() => f.rows('task.integrated', task).length === 1);

  assert.equal(f.inCheckout(), 'export const state = "newer";\n');
  assert.equal(f.scheduler.tasks()[task].state, 'accepted');
});

test('the handoff of accepted work says its check passed, and with which command', async t => {
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "new";\n');
    return [{kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: says('new')});
  assert.equal(await f.settled(task), 'accepted');

  const lines = handoffBlock(f.session, [f.rows('task.accepted', task).at(-1)]).split('\n');
  assert.equal(lines.includes(`  check: passed (exit code 0) · ${says('new')}`), true, lines.join('\n'));
});

// Found on the real path (benchmark, 2026-09-28, 03:35): the orchestrator's check was `deno task check`
// and `deno` was not on the path. bounce read exit 127 as failing work and sent it back; the worker
// "fixed" it by prefixing every task in the project's deno.json with an export of PATH.
test('a check that cannot run is not the work\'s fault: nothing goes back to the worker, the orchestrator is told to fix the check', async t => {
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "new";\n');
    return [{kind: 'native', provider: 'worker', sessionId: 's1'}, {kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: 'no-such-tool-bounce-test check'});
  assert.equal(await f.settled(task), 'blocked');

  const [check] = f.rows('task.check', task);
  assert.deepEqual([check.exit, check.passed, check.unrunnable], [127, false, true]);
  assert.equal(f.rows('task.rework', task).length, 0);
  assert.equal(f.adapters.worker.calls.resume, 0);
  const blocked = f.rows('task.blocked', task).at(-1);
  assert.equal(blocked.reason, 'check_unrunnable');
  assert.match(blocked.text, /^The task's check could not be run, so nothing verified this work and it was not put in the checkout\. bounce ran `no-such-tool-bounce-test check` in the worker's copy: exit code 127\. The end of its output:\n.*no-such-tool-bounce-test.*not found\nThe check runs in a plain shell with bounce's own environment: name the tool by its full path, or set PATH inside the check\. The work is kept\. Decide: accept it with what you checked yourself \(task\.accepted\), or retry it with a check that runs \(retryOf\)\.$/);
  assert.equal(f.inCheckout(), 'export const state = "old";\n');
});

test('strategy: a check that cannot run is handed to the orchestrator at once', () => {
  const unrunnable = {command: 'deno task check', exit: 127, passed: false, unrunnable: true, output: '/bin/sh: deno: command not found'};
  const decision = defaultStrategy.onCompleted('t', {t: {state: 'reviewing'}}, api({check: unrunnable}));
  assert.deepEqual([decision.action, decision.reason], ['escalate', 'check_unrunnable']);
});

// Found live (ACE e3bd01d5, tasks b882c673 and 03437d4d): the check ran a script the task was to
// write, `sh scripts/install-smoke.sh`. The script was missing (exit 127, "No such file or
// directory"), bounce read that as a check that cannot run, and held the work for the orchestrator
// instead of telling the worker. Only a tool the shell cannot find is the check's own fault.
test('a check whose script is missing is failing work: it goes back to the worker', async t => {
  let round = 0;
  const f = setup(t, {worker: ({cwd}) => {
    round += 1;
    write(cwd, 'export const state = "new";\n');
    if (round === 2) fs.writeFileSync(path.join(cwd, 'src/smoke.sh'), 'grep -q new src/x.js\n');
    return [{kind: 'native', provider: 'worker', sessionId: 's1'}, {kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: 'sh src/smoke.sh', owns: ['src/x.js', 'src/smoke.sh']});
  assert.equal(await f.settled(task), 'accepted');

  assert.deepEqual(f.rows('task.check', task).map(row => [row.exit, row.passed, row.unrunnable ?? false]), [[127, false, false], [0, true, false]]);
  assert.equal(f.rows('task.rework', task).length, 1);
  assert.match(f.rows('task.rework', task)[0].findings[0], /^The task's check failed\. bounce ran `sh src\/smoke\.sh` in your working copy: exit code 127\. The end of its output:\n.*src\/smoke\.sh.*\nFix what it reports, and run it yourself before you finish\.$/);
});

// A check that only looks for files or text (see test/task-check.test.js) still runs, but passing it
// verifies nothing (Daniel, 2026-09-29).
const looksForNew = 'grep -q new src/x.js';

test('a weak check is taken, the orchestrator is told at once that passing it will not count, and the work waits for it', async t => {
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "new";\n');
    return [{kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: looksForNew});
  assert.equal(await f.settled(task), 'blocked');
  assert.equal(f.rows('task.blocked', task).at(-1).text, `Nothing that runs this work has verified it, so it waits for you and is not in the checkout: the task's check only looks for files or text. The review accepted it. The work is in ${f.copyOf(task)}. Decide: accept it (task.accepted with what you checked), send it back (task.rework with what to fix), or retry it on another AI (retryOf).`);
  f.scheduler.acceptOverride({kind: 'task.accepted', task, stage: 'completion', by: 'orchestrator', overrides: 'blocked', text: 'Ran the tests myself: 3 passed.'});
  await waitFor(() => f.rows('task.integrated', task).length === 1);

  assert.deepEqual(f.rows('task.corrected', task).map(row => row.text), [
    'check: `grep -q new src/x.js` only looks for files or text; it does not run the work, so passing it will not count as verification. Name a check that runs the work (its tests, its script) and fails when the result is wrong.',
  ]);
  const [check] = f.rows('task.check', task);
  assert.deepEqual([check.passed, check.weak], [true, true]);
  const lines = handoffBlock(f.session, [f.rows('task.accepted', task).at(-1)]).split('\n');
  assert.equal(lines.includes('  check: passed (exit code 0), but it only looks for files or text and did not run the work · grep -q new src/x.js'), true, lines.join('\n'));
});

test('a weak check that passes does not verify work whose report bounce wrote: it is held when the review objects', async t => {
  const f = setup(t, {
    worker: ({cwd}) => {
      write(cwd, 'export const state = "new";\n');
      return [{kind: 'native', provider: 'worker', sessionId: 's1'}, edited, {kind: 'result', status: 'failed', recoverable: true, text: 'opencode finished without an answer'}];
    },
    reviewer: ({review}) => { f.shown = review.report.evidence; return verdict('rework', ['An acceptance criterion in the orders is not met.']); },
  });
  const {task} = f.submit({check: looksForNew});
  assert.equal(await f.settled(task), 'blocked');

  assert.equal(f.rows('task.blocked', task).at(-1).reason, 'unverified');
  assert.equal(f.rows('task.blocked', task).at(-1).text, `Nothing that runs this work has verified it, so it waits for you and is not in the checkout: the task's check only looks for files or text, and the worker wrote no report (bounce wrote one from what it saw). After the one rework round the review still found: An acceptance criterion in the orders is not met. The work is in ${f.copyOf(task)}. Decide: accept it (task.accepted with what you checked), send it back (task.rework with what to fix), or retry it on another AI (retryOf).`);
  assert.equal(f.shown.at(-1), 'bounce ran the task\'s check `grep -q new src/x.js` in the worker\'s copy: exit code 0. It printed nothing. This check only looks for files or text; it did not run the work.');
  assert.equal(f.inCheckout(), 'export const state = "old";\n');
});

test('a worker sent back by a weak check is told to report what happened, not to write what the check looks for', async t => {
  let round = 0;
  const f = setup(t, {worker: ({cwd}) => {
    round += 1;
    write(cwd, round === 1 ? 'export const state = "broken";\n' : 'export const state = "new";\n');
    return [{kind: 'native', provider: 'worker', sessionId: 's1'}, {kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: looksForNew});
  assert.equal(await f.settled(task), 'blocked');

  assert.deepEqual(f.rows('task.check', task).map(row => [row.passed, row.weak]), [[false, true], [true, true]]);
  assert.deepEqual(f.rows('task.rework', task).map(row => row.findings), [[
    'The task\'s check failed. bounce ran `grep -q new src/x.js` in your working copy: exit code 1. It printed nothing. This check only looks for files or text, and only inside your working copy: what you saved elsewhere on disk does not count. Put the real results where it looks. If the work could not be done, or its result is a failure, say so in your report; never write what the check looks for to make it pass.',
  ]]);
});

// Found live (ACE e3bd01d5): of 21 first checks that failed, 6 (3 local, 3 Sonnet) failed because the
// worker had saved what the orders asked for outside its working copy, where the project's agent file
// sends evidence (/private/tmp/ace-work-<date>/evidence). Each cost a rework round.
test('a worker is told that what its orders ask it to deliver goes inside its working copy', async t => {
  let orders = null;
  const f = setup(t, {worker: args => {
    orders = args.orders;
    write(args.cwd, 'export const state = "new";\n');
    return [{kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: says('new')});
  assert.equal(await f.settled(task), 'accepted');

  assert.equal(orders.includes('so edit the copy, never the original. What your orders ask you to deliver, evidence and reports included, goes inside this copy at the path they name: a file saved anywhere else on disk is not delivered.'), true, orders);
});

// Found live (ACE e3bd01d5): the handoff carried a summary of at most 2,000 characters, and the
// orchestrator then asked for the whole answer 41 times out of 43. Answers were 1,140 characters at the
// median and 10,588 at most.
test('the handoff carries the worker\'s answer in full, and says how to get the rest of one that is too long', async t => {
  const long = `Summary of the change.\n\n${'A line of the full answer, with a result in it.\n'.repeat(120)}`;
  let text = '';
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "new";\n');
    return [{kind: 'result', status: 'completed', text}];
  }});

  text = JSON.stringify({op: 'final', phase: 'complete', text: long, next: '', evidence: [], outcome: 'completed', summary: 'Summary of the change.', remaining: ''});
  const first = f.submit({check: says('new')});
  assert.equal(await f.settled(first.task), 'accepted');
  const block = handoffBlock(f.session, [f.rows('task.accepted', first.task).at(-1)]);
  assert.equal(block.includes(`  answer, in the worker's words:\n    ${long.trim().replace(/\n/g, '\n    ')}`), true, block.slice(0, 600));

  text = JSON.stringify({op: 'final', phase: 'complete', text: 'x'.repeat(15000) + 'y'.repeat(900), next: '', evidence: [], outcome: 'completed', summary: 'Too long to hand over whole.', remaining: ''});
  const second = f.submit({orders: 'again', check: says('new')});
  assert.equal(await f.settled(second.task), 'accepted');
  const cut = handoffBlock(f.session, [f.rows('task.accepted', second.task).at(-1)]);
  assert.equal(cut.includes(`${'x'.repeat(12000)}\n    [… 3900 more characters: task_get with full: true]`), true);
  assert.equal(cut.includes('yyyy'), false);

  // an answer that says no more than its summary is not said twice
  text = JSON.stringify({op: 'final', phase: 'complete', text: 'Done.', next: '', evidence: [], outcome: 'completed', summary: 'Done.', remaining: ''});
  const third = f.submit({orders: 'once more', check: says('new')});
  assert.equal(await f.settled(third.task), 'accepted');
  assert.equal(handoffBlock(f.session, [f.rows('task.accepted', third.task).at(-1)]).includes('answer, in the worker'), false);
});

// Decided by Daniel on 2026-09-29. Found live (ACE e3bd01d5): 6 results that were wrong were put in the
// checkout as soon as their worker finished, and the orchestrator, who caught all 6 by reading them, had
// each one corrected afterwards. Work now reaches the checkout by itself only when a check that runs it
// has passed; anything else waits in the worker's copy for the orchestrator to accept it.
test('work that no check has run waits for the orchestrator: it is kept, named with its folder, and lands when accepted', async t => {
  const f = setup(t, {worker: ({cwd}) => {
    write(cwd, 'export const state = "new";\n');
    return [{kind: 'result', status: 'completed', text: ownReport('state is now "new"')}];
  }});
  const {task} = f.submit({check: undefined});
  assert.equal(await f.settled(task), 'blocked');

  const held = f.rows('task.blocked', task).at(-1);
  const copy = f.copyOf(task);
  assert.equal(held.reason, 'unverified');
  assert.equal(held.text, `Nothing that runs this work has verified it, so it waits for you and is not in the checkout: the task names no check. The review accepted it. The work is in ${copy}. Decide: accept it (task.accepted with what you checked), send it back (task.rework with what to fix), or retry it on another AI (retryOf).`);
  assert.equal(f.inCheckout(), 'export const state = "old";\n');
  assert.equal(f.rows('task.integrated', task).length, 0);

  f.scheduler.acceptOverride({kind: 'task.accepted', task, stage: 'completion', by: 'orchestrator', overrides: 'blocked', text: 'Read the diff; it is the one line asked for.'});
  await waitFor(() => f.rows('task.integrated', task).length === 1);
  assert.equal(f.inCheckout(), 'export const state = "new";\n');
});

test('a task that changed no file has nothing to hold: it is accepted as before', async t => {
  const f = setup(t, {worker: () => [{kind: 'result', status: 'completed', text: ownReport('read the file; it says old')}]});
  const {task} = f.submit({check: undefined, orders: 'Say what src/x.js holds'});
  assert.equal(await f.settled(task), 'accepted');
});

test('strategy: every way of accepting finished work holds it when it changed files that no real check verified', () => {
  const view = {t: {state: 'reviewing'}};
  const lean = {verdict: 'unavailable', choice: 'accept', confidence: 0.65, threshold: 0.8, probabilities: {accept: 0.83, rework: 0.17}, fired: []};
  const held = options => api(options);
  for (const verdicts of [[{verdict: 'accept'}], [lean], objection]) {
    const decision = defaultStrategy.onReviewVerdict('t', verdicts, view, held({reworked: true}));
    assert.deepEqual([decision.action, decision.reason], ['escalate', 'unverified'], JSON.stringify(verdicts));
  }
  assert.match(defaultStrategy.onReviewVerdict('t', [lean], view, held()).text, /: the task names no check\. Jev leaned accept \(probability 0\.83, confidence 0\.65 below the 0\.8 bar\)\. The work is in \/w\/1a2b3c4d\. Decide: /);
  assert.match(defaultStrategy.onReviewVerdict('t', objection, view, held({reworked: true, byBounce: true, check: {...passed, weak: true}})).text,
    /: the task's check only looks for files or text, and the worker wrote no report \(bounce wrote one from what it saw\)\. After the one rework round the review still found: x is missing\. The work is in /);
  // verified work is accepted whatever the review leans
  assert.equal(defaultStrategy.onReviewVerdict('t', [lean], view, api({check: passed})).action, 'accept');
  // a first objection still sends the work back before anything is held
  assert.equal(defaultStrategy.onReviewVerdict('t', objection, view, held()).action, 'rework');
});

// docs/plans/lessons-and-sweep.md §1: a worker reads the project's lessons for its job after its agent prompt —
// in the orders for a cloud worker, in the agent definition for a local one — and not another job's.
test('a worker is handed the project\'s lessons for its job with its agent prompt, and not another job\'s', async t => {
  let launched = null;
  const f = setup(t, {worker: args => { launched = args; write(args.cwd, 'export const state = "new";\n'); return [{kind: 'result', status: 'completed', text: ownReport('state is now "new"')}]; }});
  fs.mkdirSync(path.join(f.session.cwd, '.bounce'), {recursive: true});
  fs.writeFileSync(path.join(f.session.cwd, '.bounce', 'LESSONS.md'), '# Lessons\n\n- Put evidence inside the working copy. <!-- builder · 2026-09-29 · d1bc0206 -->\n- Say PASS or FAIL first. <!-- reviewer · 2026-09-30 · e3bd01d5 -->\n- A check must run the work. <!-- all · 2026-09-29 · d1bc0206 -->\n');
  f.scheduler.close();
  const profiles = {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write', agent: {name: 'builder', description: 'builds', policy: 'write', prompt: 'You are a builder.'}}};
  const scheduler = createScheduler({session: f.session, adapters: f.adapters, profiles, requireFinalReport: true, gitHead: () => null});
  t.after(() => scheduler.close());
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'Make state "new" in src/x.js', owns: ['src/x.js'], deadline: null, check: says('new')});
  await waitFor(() => ['completed', 'accepted', 'blocked', 'failed'].includes(scheduler.tasks()[task]?.state));

  const block = 'Lessons from earlier sessions in this project:\n- Put evidence inside the working copy.\n- A check must run the work.';
  assert.equal(launched.profile.agent.prompt, `You are a builder.\n\n${block}`, 'the agent definition a local worker runs as');
  assert.equal(launched.orders.startsWith(`You are a builder.\n\n${block}\n\n---\n\nMake state "new"`), true, launched.orders.slice(0, 300));
  assert.equal(launched.orders.includes('PASS or FAIL'), false, 'the reviewer\'s line is not the builder\'s');
});
