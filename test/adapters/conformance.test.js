import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Session} from '../../src/core.js';
import {createScheduler} from '../../src/scheduler.js';
import {createClaudeLive} from '../../src/adapters/claude-live.js';
import {createCodexLive} from '../../src/adapters/codex-live.js';
import {createMuseLive} from '../../src/adapters/muse-live.js';

// The adapter interface (docs/local-orchestration.md "Peers and adapters") as an executable contract: every live
// adapter is driven through the REAL scheduler with its fake CLI. Phase 3's wide critic found three blockers that
// only a composed test can catch — launch's return shape, the task dir, and the native session id reaching the log.
const helper = name => fileURLToPath(new URL(`../helpers/${name}`, import.meta.url));
const adapters = {
  claude: {make: () => createClaudeLive({}), executable: helper('fake-claude.js'), env: {FAKE_SESSION: 'sess-conf'}},
  codex: {make: () => createCodexLive({}), executable: helper('fake-codex-app-server.js'), env: {}},
  muse: {make: () => createMuseLive({}), executable: helper('fake-muse.js'), env: {}},
};
const setup = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-')); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return {root, session: new Session(root, {root})}; };
const waitFor = async (cond, ms = 8000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

for (const [name, {make, executable, env}] of Object.entries(adapters)) {
  test(`${name}: launch returns a bare handle, the scheduler passes a per-task dir, and the worker completes`, async t => {
    const {session} = setup(t);
    const saved = {...process.env}; Object.assign(process.env, env); t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; Object.assign(process.env, saved); });
    const adapter = make();
    const scheduler = createScheduler({session, adapters: {[name]: adapter}, profiles: {p: {adapter: name, model: '', mode: 'yolo', fallback: [], executables: {[name]: executable}}}});
    t.after(async () => { await scheduler.cancel(row.task); scheduler.close(); }); // a persistent fake must never hang the suite
    const row = scheduler.submit({parent: null, profile: 'p', orders: 'say hello'});
    await waitFor(() => ['completed', 'failed'].includes(scheduler.tasks()[row.task].state));
    const task = scheduler.tasks()[row.task];
    assert.equal(task.state, 'completed', JSON.stringify(session.events.filter(e => e.task === row.task).map(e => [e.kind, e.reason, e.text])));
    assert.equal(fs.existsSync(path.join(session.dir, 'tasks', row.task)), true, 'scheduler owns <session.dir>/tasks/<task> and passes it as dir');
    const native = session.events.find(e => e.kind === 'peer.native' && e.from === `worker:${row.task}`);
    assert.equal(typeof native?.sessionId, 'string', 'the native session id must reach the journal');
    assert.equal(session.events.some(e => e.kind === 'peer.joined' && e.from === `worker:${row.task}`), true);
  });
  test(`${name}: deliver contract — non-string text is coerced, oversize text is queued, launch result is the handle itself`, async t => {
    const {root} = setup(t);
    const adapter = make();
    const handle = await adapter.launch({peer: {}, profile: {mode: 'yolo', executables: {[name]: executable}}, orders: 'x', cwd: root, dir: path.join(root, 'd')});
    assert.equal(typeof handle?.pid === 'number' || typeof handle?.child?.pid === 'number', true, 'launch resolves to the handle, not {handle}');
    assert.equal(['live', 'next-turn', 'queued'].includes(await adapter.deliver(handle, {text: 42})), true);
    assert.equal(await adapter.deliver(handle, {text: 'x'.repeat(1_000_001)}), 'queued');
    assert.deepEqual(await adapter.cancel(handle), {verified: true});
  });

  // Phase 4: resume is scheduler-driven exactly like launch (docs/local-orchestration.md "Peers
  // and adapters") — src/scheduler.js's resumeWorker() is the real caller now; this test stands
  // in for it here, creating the task dir before calling resume the same way the scheduler does;
  // the adapter must never create it itself, and must resolve to the bare handle with events
  // ending in a result{status}, same as launch.
  test(`${name}: resume resolves to the bare handle with a caller-created dir, and its events end with a result`, async t => {
    const {root} = setup(t);
    const saved = {...process.env}; Object.assign(process.env, env); t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; Object.assign(process.env, saved); });
    const adapter = make();
    const dir = path.join(root, 'resume-d');
    fs.mkdirSync(dir, {recursive: true, mode: 0o700}); // stands in for the scheduler's own pre-creation
    const handle = await adapter.resume({
      peer: {}, profile: {mode: 'yolo', executables: {[name]: executable}},
      native: {sessionId: 'sess-conf'}, message: 'continue', cwd: root, dir,
    });
    assert.equal(typeof handle?.pid === 'number' || typeof handle?.child?.pid === 'number', true, 'resume resolves to the handle, not {handle}');
    const events = [];
    for await (const event of adapter.events(handle)) { events.push(event); if (event.kind === 'result') break; }
    t.after(async () => { try { await adapter.cancel(handle); } catch {} });
    assert.equal(events.at(-1)?.kind, 'result');
    assert.equal(typeof events.at(-1)?.status, 'string');
  });
}

// muse's resume used to re-create the task dir itself ("dir may not exist" — Phase 3 leftover,
// since resume was not yet scheduler-driven). Phase 4 makes resume scheduler-driven like launch,
// so that workaround must be gone: resume must fail rather than silently paper over a missing dir.
test('muse: resume never creates the task dir itself — a missing dir is the caller\'s bug, not papered over', async t => {
  const {root} = setup(t);
  const adapter = createMuseLive({});
  const dir = path.join(root, 'never-created');
  assert.equal(fs.existsSync(dir), false);
  await assert.rejects(adapter.resume({
    peer: {}, profile: {mode: 'yolo', executables: {muse: helper('fake-muse.js')}},
    native: null, message: 'continue', cwd: root, dir,
  }));
  assert.equal(fs.existsSync(dir), false, 'resume must not have created the dir as a side effect of failing');
});
