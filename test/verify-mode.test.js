// Who verifies, set per session and changed live: some work is better verified by the orchestrator, to avoid
// collisions, and some by the worker. It changes the orchestrator's verifying orders
// only; in every mode the final head's gates pass and the result names the commit each gate ran on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseVerify, verifyMode, verifyingOrders, applyVerify} from '../src/verify-mode.js';
import {Session} from '../src/core.js';
import {createRunInbox} from '../src/run-inbox.js';

test('verify=MODE and /verify MODE are read, anything else is not; the mode is the last one set, else the config, else auto', () => {
  assert.deepEqual(['verify=worker', ' Verify = orchestrator ', '/verify auto', 'verify=both', 'please verify=worker', 'verify'].map(parseVerify),
    ['worker', 'orchestrator', 'auto', null, null, null]);
  assert.equal(verifyMode([]), 'auto');
  assert.equal(verifyMode([], 'worker'), 'worker');
  assert.equal(verifyMode([{kind: 'control.verify', mode: 'orchestrator'}, {kind: 'control.verify', mode: 'worker'}], 'auto'), 'worker');
});

test('each mode\'s orders say who runs the gates, and all keep the final head and the commit naming', () => {
  const common = ['see every gate pass on the final head', 'name the commit each gate ran on'];
  const orchestrator = verifyingOrders('orchestrator'), worker = verifyingOrders('worker'), auto = verifyingOrders('auto');
  for (const text of [orchestrator, worker, auto]) for (const part of common) assert.equal(text.includes(part), true, `${part} in ${text.slice(0, 60)}`);
  assert.match(orchestrator, /^Verifying work \(mode: orchestrator\): run the final gates yourself, in your own copy/);
  assert.match(worker, /^Verifying work \(mode: worker\): put every gate in the task's check .* accept on bounce's check when the delivery line says it passed on this tree; rerun only when it says NOT CHECKED AS DELIVERED/);
  assert.match(auto, /^Verifying work \(mode: auto\): put the gates in the task's check .* Before you accept the final head, run the final gates yourself on it/);
});

test('a sent verify=MODE is journaled, and the orchestrator\'s turn is told the new orders instead of the bare line', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-verify-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root: path.join(root, 'home')});
  assert.equal(applyVerify(session, 'not a mode line'), null);
  const text = applyVerify(session, 'verify=worker');
  assert.deepEqual(session.events.filter(e => e.kind === 'control.verify').map(e => e.mode), ['worker']);
  assert.equal(text, `The user set the verification mode to worker. From now on:\n${verifyingOrders('worker')}`);
  // A detached run's inbox takes it the same way.
  const inbox = createRunInbox({session});
  const sent = inbox.run({text: 'verify=orchestrator', via: 'send'});
  assert.equal(sent.accepted, true);
  assert.equal(session.events.findLast(e => e.kind === 'send.queued').text, `The user set the verification mode to orchestrator. From now on:\n${verifyingOrders('orchestrator')}`);
  assert.equal(verifyMode(session.events), 'orchestrator');
});
