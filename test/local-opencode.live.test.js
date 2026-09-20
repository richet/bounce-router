import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createOpencodeLive} from '../src/adapters/opencode-live.js';
import {validateOrchestration} from '../src/profiles.js';
import {createLocalResolver} from '../src/local-resolve.js';

// The only cases that touch the REAL `opencode` binary and a REAL LM Studio model. Opt-in:
//   BOUNCE_LIVE_OPENCODE=1 node --test test/local-opencode.live.test.js
// This is the gate for anything that changes how local workers run: every defect that reached a
// user in 2026-09 passed the unit suite and failed here (docs/plans/local-design-v2.md).
const skip = process.env.BOUNCE_LIVE_OPENCODE === '1' ? false : 'set BOUNCE_LIVE_OPENCODE=1 to run';
const local = {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234'}}};

const project = t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-oc-live-')));
  const dir = path.join(cwd, '.task'); fs.mkdirSync(dir, {mode: 0o700});
  fs.writeFileSync(path.join(cwd, 'note.txt'), 'the word is guava\n');
  fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src/a.js'), 'export const x = 1;\n');
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  return {cwd, dir};
};
// The profile a real local worker gets: an agent's local backend, resolved by the real resolver —
// including the model resolution that must address the LOADED INSTANCE identifier.
const admit = async (t, over) => {
  const roles = new Map([['worker', {name: 'worker', description: 'Live test worker.', policy: over.policy ?? 'write', prompt: 'Do exactly what the orders say.', models: ['lmstudio/auto'], source: 'user'}]]);
  const view = validateOrchestration({operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', profiles: {main: {adapter: 'claude'}}}, undefined, {roles});
  return createLocalResolver({local}).resolve({profile: view.profiles.worker});
};
const handles = [];
const run = async (adapter, handle) => { handles.push([adapter, handle]); const events = []; for await (const event of adapter.events(handle)) events.push(event); return events; };
test.after(async () => { for (const [adapter, handle] of handles) await adapter.cancel(handle).catch(() => {}); });

test('live: a read-only worker answers from the project, reports real usage, resumes its session, and exits by itself', {skip, timeout: 300_000}, async t => {
  const {cwd, dir} = project(t);
  const profile = await admit(t, {policy: 'read-only'});
  const adapter = createOpencodeLive({});
  const first = await adapter.launch({peer: 'worker:live-ro', profile, cwd, dir, orders: 'Read note.txt and reply with only the word it names.'});
  assert.equal(first.cwd, cwd, 'the worker runs in the project itself');
  const events = await run(adapter, first);
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events.slice(-3)));
  assert.match(events.at(-1).text.toLowerCase(), /guava/);
  assert.equal(events.filter(e => e.kind === 'usage').reduce((sum, e) => sum + (e.usage.input ?? 0), 0) > 0, true);
  assert.throws(() => process.kill(first.pid, 0), {code: 'ESRCH'}, 'the process ended with the turn');
  const native = events.find(e => e.kind === 'native');
  const again = await run(adapter, await adapter.resume({peer: 'worker:live-ro', profile, native, cwd, dir, message: 'Reply with only that same word again, in capitals.'}));
  assert.match(again.at(-1).text, /GUAVA/, 'the resumed turn remembers the first');
  assert.equal(again.find(e => e.kind === 'native').sessionId, native.sessionId);
});

test('live: a read-only worker cannot change the project, and a path outside it is refused by opencode itself', {skip, timeout: 300_000}, async t => {
  const {cwd, dir} = project(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-oc-outside-')); fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  t.after(() => fs.rmSync(outside, {recursive: true, force: true}));
  const profile = await admit(t, {policy: 'read-only'});
  const adapter = createOpencodeLive({});
  // Asked for the impossible, a model may answer or may loop; either way the turn ends by itself,
  // well inside the step cap, and the file is untouched.
  const started = Date.now();
  const impossible = await run(adapter, await adapter.launch({peer: 'worker:live-ro2', profile, cwd, dir, orders: 'Use the write or edit tool to change src/a.js so that x is 2. Then say done.'}));
  assert.equal(impossible.at(-1).kind, 'result');
  assert.equal(Date.now() - started < 120_000, true, `the turn must not grind to the step cap: ${Date.now() - started}ms, ${impossible.at(-1).text}`);
  assert.equal(fs.readFileSync(path.join(cwd, 'src/a.js'), 'utf8'), 'export const x = 1;\n');
  const events = await run(adapter, await adapter.launch({peer: 'worker:live-ro3', profile, cwd, dir, orders: `Call the read tool on ${path.join(outside, 'secret.txt')} and tell me exactly what came back.`}));
  assert.equal(events.some(e => e.kind === 'diagnostic' && /rejected permission|auto-rejecting/i.test(e.text)), true, JSON.stringify(events.slice(-4)));
  assert.equal(events.some(e => e.kind === 'assistant' && e.text.includes('nope')), false, 'the outside file was never read');
});

test('live: a write worker edits the real file, and cancelling a turn is verified with nothing left running', {skip, timeout: 300_000}, async t => {
  const {cwd, dir} = project(t);
  const profile = await admit(t, {policy: 'write'});
  const adapter = createOpencodeLive({});
  const events = await run(adapter, await adapter.launch({peer: 'worker:live-w', profile, cwd, dir, orders: 'Edit src/a.js so that the constant x equals 2 instead of 1. Then reply with the single word done.'}));
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events.slice(-3)));
  assert.match(fs.readFileSync(path.join(cwd, 'src/a.js'), 'utf8'), /x = 2/);
  const long = await adapter.launch({peer: 'worker:live-c', profile, cwd, dir, orders: 'Write a 3000 word essay about rivers.'});
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.deepEqual(await adapter.cancel(long), {verified: true});
  assert.throws(() => process.kill(long.pid, 0), {code: 'ESRCH'});
});
