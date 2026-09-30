// `local.endpoints.<name>.maxConcurrent` was parsed and never enforced: bounce launched as many local
// workers as it had tasks, LM Studio ran them all at once, and the machine swapped (observed live:
// three models, 102 GB, two running together). Now it is the number of local workers the scheduler
// will run on that endpoint at once; the rest wait in the queue and start as slots free up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createMachineSlots} from '../src/machine-slots.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {hostless} from './helpers/local-fakes.js';

const waitFor = async fn => { const start = Date.now(); for (;;) { const value = fn(); if (value) return value; if (Date.now() - start > 8000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const local = name => ({adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model: 'm', mode: 'yolo', policy: 'write', fallback: [], role: name, agent: {name, description: 'x', policy: 'write', prompt: 'x'}, derived: true, localOptions: {}});

test('no more local workers run at once than the endpoint allows; the rest wait and start as slots free; cloud workers are never held', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-conc-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const gates = new Map(); let launched = [];
  const first = orders => orders.split('\n')[0]; // a local worker's orders carry a report line after them
  const opencode = fakeAdapter(({orders}) => { const gate = Promise.withResolvers(); gates.set(first(orders), gate); launched.push(first(orders)); return gate.promise; });
  // The cloud profile is write-policy too, so it now also runs in a fenced attempt workspace and its
  // orders carry the appended working-copy paragraph (src/scheduler.js inWorkingCopy) — take the first
  // line, same as the opencode adapter above, rather than the raw multi-line text.
  const claude = fakeAdapter(({orders}) => { launched.push(first(orders)); return [{kind: 'result', status: 'completed', text: 'cloud done'}]; });
  const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  const profiles = {a: local('a'), b: local('b'), c: local('c'), cloud: {adapter: 'claude', model: 's', mode: 'yolo', policy: 'write', fallback: [], role: 'builder'}};
  const scheduler = createScheduler({...hostless, session, adapters: {opencode, claude}, profiles, localResolver, gitHead: () => null,
    localSettings: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 2}}}});
  t.after(() => scheduler.close());
  const one = scheduler.submit({parent: null, profile: 'a', orders: 'one', deadline: null});
  const two = scheduler.submit({parent: null, profile: 'b', orders: 'two', deadline: null});
  const three = scheduler.submit({parent: null, profile: 'c', orders: 'three', deadline: null});
  const cloud = scheduler.submit({parent: null, profile: 'cloud', orders: 'cloud', deadline: null});
  await waitFor(() => launched.includes('cloud') && launched.filter(o => o !== 'cloud').length === 2);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(launched.filter(o => o !== 'cloud'), ['one', 'two'], 'only two local workers launched');
  assert.equal(scheduler.tasks()[three.task].state, 'queued');
  const waiting = session.events.find(e => e.kind === 'task.milestone' && e.task === three.task);
  assert.equal(waiting.text, 'Waiting for a local slot on lmstudio: 2 of 2 in use');
  await waitFor(() => scheduler.tasks()[cloud.task].state === 'completed');

  gates.get('one').resolve([{kind: 'result', status: 'completed', text: 'done one'}]);
  await waitFor(() => launched.includes('three'));
  assert.deepEqual(launched.filter(o => o !== 'cloud'), ['one', 'two', 'three']);
  gates.get('two').resolve([{kind: 'result', status: 'completed', text: 'done two'}]);
  gates.get('three').resolve([{kind: 'result', status: 'completed', text: 'done three'}]);
  await waitFor(() => ['completed', 'accepted'].includes(scheduler.tasks()[three.task]?.state));
  assert.equal(session.events.filter(e => e.kind === 'task.milestone' && /local slot/.test(e.text)).length, 1, 'said once, not on every reconcile');
});

// Found live: two builders on the 35B took both endpoint slots, and the reviewer — whose model, the
// 27B, sat idle with its own two slots — waited seven minutes. Slots are per MODEL: a worker waits
// only when its own model's slots are full; the endpoint's maxConcurrent stays as the ceiling.
test('slots are per model: a worker on an idle model starts while another model is full; the endpoint limit still caps the total', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-conc2-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const gates = new Map(); const launched = [];
  const first = orders => orders.split('\n')[0];
  const opencode = fakeAdapter(({orders}) => { const gate = Promise.withResolvers(); gates.set(first(orders), gate); launched.push(first(orders)); return gate.promise; });
  const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  const on = (name, model) => ({adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model, mode: 'yolo', policy: 'write', fallback: [], role: name, agent: {name, description: 'x', policy: 'write', prompt: 'x'}, derived: true, localOptions: {}});
  const profiles = {b1: on('b1', 'big'), b2: on('b2', 'big'), b3: on('b3', 'big'), r1: on('r1', 'reviewer-model'), r2: on('r2', 'reviewer-model'), r3: on('r3', 'reviewer-model')};
  const scheduler = createScheduler({...hostless, session, adapters: {opencode}, profiles, localResolver, gitHead: () => null,
    localSettings: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 4, slotsPerModel: 2}}}});
  t.after(() => scheduler.close());
  const wait = async fn => { const start = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - start > 8000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
  for (const [p, o] of [['b1', 'b-one'], ['b2', 'b-two'], ['b3', 'b-three'], ['r1', 'r-one']]) scheduler.submit({parent: null, profile: p, orders: o, deadline: null});
  await wait(() => launched.length === 3);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(launched, ['b-one', 'b-two', 'r-one'], 'two on the big model, the third big one waits, the reviewer starts on its idle model');
  const held = session.events.find(e => e.kind === 'task.milestone' && /local slot/.test(e.text));
  assert.equal(held.text, 'Waiting for a local slot on lmstudio for big: 2 of 2 in use');
  // the endpoint ceiling: with 3 running and a ceiling of 4, one more reviewer starts, the next one waits on the ceiling
  scheduler.submit({parent: null, profile: 'r2', orders: 'r-two', deadline: null});
  await wait(() => launched.length === 4);
  scheduler.submit({parent: null, profile: 'r3', orders: 'r-three', deadline: null});
  await new Promise(r => setTimeout(r, 150));
  assert.equal(launched.length, 4);
  assert.equal(session.events.filter(e => e.kind === 'task.milestone' && /local slot/.test(e.text)).at(-1).text, 'Waiting for a local slot on lmstudio: 4 of 4 in use');
  // drain: resolve every gate as it appears, until all six tasks have finished
  const done = () => Object.values(scheduler.tasks()).filter(t => ['completed', 'accepted'].includes(t.state)).length;
  const start = Date.now();
  while (done() < 6) { for (const g of gates.values()) g.resolve([{kind: 'result', status: 'completed', text: 'done'}]); if (Date.now() - start > 8000) throw new Error('drain timed out'); await new Promise(r => setTimeout(r, 20)); }
});

// Found live (ACE d1bc0206, 2026-09-28): a second bounce, started with another home, sent its worker
// to the same LM Studio while the first one's builder was running; the builder read as "stalled for
// 604 s". Daniel: this machine runs one local worker at a time, whoever started it.
test('two bounce processes share the machine\'s local slot: the second one\'s worker waits, says who has it, and starts when it is free', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-machine-conc-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const gates = new Map(), launched = [];
  const first = orders => orders.split('\n')[0];
  const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  const localSettings = {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 1, pollMs: 20}}};
  const bounce = (name, pid) => {
    const home = path.join(root, name);
    fs.mkdirSync(home);
    const session = new Session(home, {root: home});
    const opencode = fakeAdapter(({orders}) => { const gate = Promise.withResolvers(); gates.set(first(orders), gate); launched.push(first(orders)); return gate.promise; });
    const scheduler = createScheduler({...hostless, session, adapters: {opencode}, profiles: {a: local('a')}, localResolver, gitHead: () => null, localSettings,
      machineSlots: createMachineSlots({dir: path.join(root, 'machine'), pid, alive: () => true, clock: () => Date.parse('2026-09-28T07:00:00Z')})});
    t.after(() => scheduler.close());
    return {session, scheduler};
  };
  const one = bounce('one', 111), two = bounce('two', 222);

  const held = one.scheduler.submit({parent: null, profile: 'a', orders: 'first', deadline: null});
  await waitFor(() => launched.includes('first'));
  const waiting = two.scheduler.submit({parent: null, profile: 'a', orders: 'second', deadline: null});
  const said = await waitFor(() => two.session.events.find(e => e.kind === 'task.milestone' && e.task === waiting.task && e.phase === 'queued'));
  await new Promise(r => setTimeout(r, 100));

  assert.deepEqual(launched, ['first']);
  assert.equal(said.text, `Waiting for the local model on lmstudio: another bounce is using it (session ${one.session.id.slice(0, 8)}, task ${held.task.slice(0, 8)}, since 2026-09-28T07:00:00.000Z)`);

  gates.get('first').resolve([{kind: 'result', status: 'completed', text: 'done first'}]);
  await waitFor(() => launched.includes('second'));
  assert.deepEqual(launched, ['first', 'second']);
  gates.get('second').resolve([{kind: 'result', status: 'completed', text: 'done second'}]);
  await waitFor(() => ['completed', 'accepted'].includes(two.scheduler.tasks()[waiting.task]?.state));
  assert.equal(two.session.events.filter(e => e.kind === 'task.milestone' && /another bounce/.test(e.text)).length, 1, 'said once');

  // and the slot is free again for the first process
  const again = one.scheduler.submit({parent: null, profile: 'a', orders: 'third', deadline: null});
  await waitFor(() => launched.includes('third'));
  gates.get('third').resolve([{kind: 'result', status: 'completed', text: 'done third'}]);
  await waitFor(() => ['completed', 'accepted'].includes(one.scheduler.tasks()[again.task]?.state));
});

// Found live (ACE e3bd01d5, 2026-09-29, tasks 7106f34c and 9928ff78): a worker sent back by its check
// waited for the local model, which another task of the same session was using. Five minutes into the
// wait the watchdog called it silent, then cancelled it and started a cloud fallback. A task that is
// waiting for its turn is not a silent worker.
test('a task sent back and waiting for the local model is not cancelled as silent or stalled', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-wait-watchdog-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'file.txt'), 'old\n');
  const session = new Session(project, {root: path.join(root, 'home')});
  let round = 0;
  const opencode = fakeAdapter(({cwd}) => {
    round += 1;
    if (round === 2) fs.writeFileSync(path.join(cwd, 'done.txt'), 'done\n');
    return [{kind: 'native', provider: 'opencode', sessionId: 's1'}, {kind: 'result', status: 'completed', text: `round ${round}`}];
  });
  const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  // free for the first round; by the time the worker is sent back, another bounce has the model
  let free = false, claims = 0;
  const machineSlots = {
    acquire: () => { claims += 1; return round >= 1 && !free ? {ok: false, holders: [{pid: 1, session: 'other-session', task: 'other-task', since: '2026-09-29T05:06:00.000Z'}]} : {ok: true, token: `claim-${claims}`}; },
    release: () => true,
    releaseAll() {},
  };
  let now = Date.parse('2026-09-29T05:00:00Z');
  const reviewer = fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify({verdict: 'accept', findings: []})}]);
  const profiles = {a: local('a'), critic: {adapter: 'reviewer', model: 'r', mode: 'yolo', fallback: [], role: 'reviewer', policy: 'read-only'}};
  const scheduler = createScheduler({...hostless, session, adapters: {opencode, reviewer}, profiles, localResolver, gitHead: () => null, machineSlots,
    clock: () => now, watchdog: {interval: null},
    localSettings: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 1, pollMs: 20}}}});
  t.after(() => scheduler.close());

  const {task} = scheduler.submit({parent: null, profile: 'a', orders: 'write done.txt', owns: ['done.txt'], deadline: null, check: `node -e "require('fs').accessSync('done.txt')"`, review: {completion: 'critic'}});
  await waitFor(() => session.events.find(e => e.kind === 'task.milestone' && e.task === task && /another bounce is using it/.test(e.text)));
  now += 400_000;
  await scheduler.tick();
  now += 400_000;
  await scheduler.tick();

  assert.deepEqual(session.events.filter(e => e.kind === 'policy.escalated' && e.task === task).map(e => e.reason), []);
  assert.equal(scheduler.tasks()[task].state, 'running');

  free = true;
  await waitFor(() => scheduler.tasks()[task]?.state === 'accepted');
  assert.deepEqual(session.events.filter(e => e.kind === 'task.check' && e.task === task).map(e => e.passed), [false, true]);
});
