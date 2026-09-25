// Phase 2 (docs/plans/in-place-tasks.md §1/§3): task.submitted may carry `inPlace:
// {authorizedBy: <seq>}`. Structural check (the cited row exists and is a `user` row), the
// eligibility rule (a write-policy profile whose mode is not plan), and the workspace choice
// (no attempt workspace, cwd = session.cwd, no writeFence) — all through the real scheduler and
// a fake worker adapter, never the network or a real checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (predicate, timeout = 2_000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

function tmpSession(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {root, session: new Session(root, {root})};
}
const teardown = (t, scheduler, root) => t.after(async () => { await scheduler.stop(); scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });

const writer = {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'};
const planProfile = {adapter: 'worker', model: 'w', mode: 'plan', fallback: [], role: 'builder', policy: 'write'};
const readOnly = {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'critic', policy: 'read-only'};

test('an authorized in-place submit runs the worker with cwd = the session checkout and no attempt workspace or fence', async t => {
  const {root, session} = tmpSession('bounce-inplace-submit-');
  const launches = [];
  const adapter = fakeAdapter(args => { launches.push(args); return [{kind: 'result', status: 'completed', text: 'committed'}]; });
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null});
  teardown(t, scheduler, root);

  const user = session.append({kind: 'user', text: 'commit it', from: 'user'});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'git add -A && git commit -m done', deadline: null,
    requires: ['write', 'exec'], inPlace: {authorizedBy: user.seq}});
  assert.equal(row.inPlace.authorizedBy, user.seq);
  await waitFor(() => launches.length === 1);
  assert.equal(launches[0].cwd, session.cwd);
  assert.equal(launches[0].profile.writeFence, undefined);
  assert.equal(launches[0].profile.probeSource, undefined);
  // The orders reach the worker unrewritten: no working-copy path substitution, because there
  // is no copy — this is the real checkout.
  assert.equal(launches[0].orders, 'git add -A && git commit -m done');
  assert.equal(session.events.some(e => e.kind === 'task.workspace' && e.task === row.task), false);
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
});

test('an in-place submit citing a seq with no row is refused in_place_unauthorized', async t => {
  const {root, session} = tmpSession('bounce-inplace-missing-');
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null});
  teardown(t, scheduler, root);
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'git commit', deadline: null,
    requires: ['write', 'exec'], inPlace: {authorizedBy: 999}}), /in_place_unauthorized/);
});

test('an in-place submit citing a non-user row (e.g. a worker message) is refused in_place_unauthorized', async t => {
  const {root, session} = tmpSession('bounce-inplace-nonuser-');
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null});
  teardown(t, scheduler, root);
  const note = session.append({kind: 'message', text: 'commit it', from: 'orchestrator', to: 'user'});
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'git commit', deadline: null,
    requires: ['write', 'exec'], inPlace: {authorizedBy: note.seq}}), /in_place_unauthorized/);
});

test('an in-place submit whose requires omits write or exec is refused in_place_requires', async t => {
  const {root, session} = tmpSession('bounce-inplace-requires-');
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null});
  teardown(t, scheduler, root);
  const user = session.append({kind: 'user', text: 'commit it', from: 'user'});
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'git commit', deadline: null,
    requires: ['write'], inPlace: {authorizedBy: user.seq}}), /in_place_requires/);
});

for (const [name, profile] of [['a plan-mode profile', planProfile], ['a read-only profile', readOnly]]) {
  test(`an in-place submit against ${name} is refused in_place_ineligible_profile`, async t => {
    const {root, session} = tmpSession('bounce-inplace-eligible-');
    const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
    const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: profile}, gitHead: () => null});
    teardown(t, scheduler, root);
    const user = session.append({kind: 'user', text: 'commit it', from: 'user'});
    assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'git commit', deadline: null,
      requires: ['write', 'exec'], inPlace: {authorizedBy: user.seq}}), /in_place_ineligible_profile/);
  });
}
