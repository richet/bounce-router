// Shared names reserved across parallel sessions of one project (src/reservations.js). Nirby control session,
// 2026-11-04: run A was given migration 0045, and run B's builder, which saw only its own copy, took 0045 too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createReservations, holderLive, projectKey} from '../src/reservations.js';

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-reservations-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
const clock = () => Date.parse('2026-11-04T12:00:00Z');

test('a value one session holds is refused to another, naming the holder; the next free value keeps its padding', t => {
  const dir = temp(t);
  const dead = new Set();
  const live = holder => !dead.has(holder.pid);
  const project = projectKey({repository: 'git@github.com:example/app.git', cwd: '/p/app'});
  assert.equal(project, projectKey({repository: 'git@github.com:example/app.git', cwd: '/elsewhere'}), 'the origin names the project, wherever it is checked out');
  const r = createReservations({dir, project, live, clock});
  const a = {session: 'aaaaaaaa-1', pid: 101};
  const b = {session: 'bbbbbbbb-2', pid: 202};
  assert.deepEqual(r.take({name: 'migration', value: '0045', holder: a}), {ok: true, reservation: {name: 'migration', value: '0045', session: 'aaaaaaaa-1', pid: 101, since: '2026-11-04T12:00:00.000Z'}});
  assert.equal(r.take({name: 'migration', value: '0045', holder: a}).already, true, 'the same session again: kept, not refused');
  const refused = r.take({name: 'migration', value: '0045', holder: b});
  assert.deepEqual([refused.ok, refused.reason], [false, 'migration 0045 is reserved by session aaaaaaaa since 2026-11-04T12:00:00.000Z']);
  assert.equal(r.next({name: 'migration', from: '0045', holder: b}).reservation.value, '0046');
  assert.equal(r.next({name: 'migration', from: '0045', holder: a}).reservation.value, '0047', 'next never hands back one this session already holds');
  assert.deepEqual(r.list().map(x => [x.value, x.session]), [['0045', 'aaaaaaaa-1'], ['0046', 'bbbbbbbb-2'], ['0047', 'aaaaaaaa-1']]);
  // Another project is another ledger.
  assert.equal(createReservations({dir, project: projectKey({cwd: '/p/other'}), live, clock}).take({name: 'migration', value: '0045', holder: b}).ok, true);
  // A session whose daemon is gone holds nothing.
  dead.add(101);
  assert.equal(r.take({name: 'migration', value: '0045', holder: b}).ok, true);
  assert.deepEqual(r.list().map(x => [x.value, x.session]), [['0045', 'bbbbbbbb-2'], ['0046', 'bbbbbbbb-2']], 'the dead holder\'s 0047 is cleared');
  // Release: only the holder, unless the holder is gone.
  assert.deepEqual(r.release({name: 'migration', value: '0046', session: 'cccccccc-3'}), {ok: false, reason: 'migration 0046 is reserved by session bbbbbbbb, not this one'});
  assert.equal(r.release({name: 'migration', value: '0046', session: 'bbbbbbbb-2'}).released, true);
  assert.deepEqual(r.take({name: 'Migration', value: '1', holder: a}), {ok: false, reason: 'name is one lowercase word, like migration, port or database'});
  assert.deepEqual(r.next({name: 'port', from: 'soon', holder: a}), {ok: false, reason: 'from is a number, like 0045'});
});

test('a reservation bound to a task ends when that task ends in its session\'s journal; only this session\'s can be bound', t => {
  const dir = temp(t);
  const journal = path.join(dir, 'journal.jsonl');
  const row = (seq, r) => JSON.stringify({seq, time: '2026-11-04T12:00:00.000Z', ...r});
  fs.writeFileSync(journal, `${row(1, {kind: 'session', cwd: '/p'})}\n${row(2, {kind: 'task.submitted', task: 't1', parent: null, profile: 'builder', orders: 'x'})}\n`);
  const r = createReservations({dir, project: 'p', live: holder => holderLive(holder, {alive: () => true}), clock});
  const a = {session: 'aaaaaaaa-1', pid: 101};
  r.take({name: 'migration', value: '0045', holder: a});
  assert.deepEqual(r.bind({session: 'bbbbbbbb-2', task: 't9', journal, names: ['migration:0045']}), {ok: false, reason: 'migration:0045 is not reserved by this session: reserve it first'});
  assert.equal(r.bind({session: 'aaaaaaaa-1', task: 't1', journal, names: ['migration:0045']}).ok, true);
  const b = {session: 'bbbbbbbb-2', pid: 202};
  assert.equal(r.take({name: 'migration', value: '0045', holder: b}).ok, false, 'its task is still open');
  fs.appendFileSync(journal, `${row(3, {kind: 'task.cancelled', task: 't1', reason: 'orchestrator'})}\n`);
  assert.equal(r.take({name: 'migration', value: '0045', holder: b}).ok, true, 'its task ended: free');
});

// The CLI, for a control session or a person: reserve for a running session, list, release.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('bounce reserve / reservations / release: held for a running session, refused to another, a stopped session refused', t => {
  const root = temp(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const env = {...process.env, BOUNCE_HOME: path.join(root, 'home'), BOUNCE_MACHINE_DIR: path.join(root, 'machine'), BOUNCE_NO_UPDATE_CHECK: '1'};
  const a = new Session(project, {root: env.BOUNCE_HOME});
  const b = new Session(project, {root: env.BOUNCE_HOME});
  const bounce = (...args) => spawnSync(process.execPath, [cliPath, ...args], {cwd: project, env, encoding: 'utf8', timeout: 15000});
  const stopped = bounce('reserve', 'migration', '0045', '--session', a.id);
  assert.deepEqual([stopped.status, stopped.stderr.trim()], [1, `bounce: session ${a.id.slice(0, 8)} is not running: a reservation lives with a running session`]);
  // This test's own pid stands in for both daemons.
  for (const s of [a, b]) fs.writeFileSync(path.join(s.dir, 'daemon.json'), JSON.stringify({pid: process.pid}));
  const taken = bounce('reserve', 'migration', '0045', '--session', a.id);
  assert.deepEqual([taken.status, taken.stdout], [0, 'reserved migration 0045\n']);
  const refused = bounce('reserve', 'migration', '0045', '--session', b.id);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`^bounce: migration 0045 is reserved by session ${a.id.slice(0, 8)} since `));
  assert.equal(bounce('reserve', 'migration', '--next', '0045', '--session', b.id).stdout, 'reserved migration 0046\n');
  const listed = JSON.parse(bounce('reservations', '--session', a.id, '--json').stdout);
  assert.deepEqual(listed.map(r => [r.name, r.value, r.session]), [['migration', '0045', a.id], ['migration', '0046', b.id]]);
  assert.equal(bounce('reservations', '--session', a.id).stdout, `migration 0045 · session ${a.id.slice(0, 8)}\nmigration 0046 · session ${b.id.slice(0, 8)}\n`);
  assert.deepEqual([bounce('release', 'migration', '0045', '--session', b.id).status], [1], 'only its holder releases it');
  assert.equal(bounce('release', 'migration', '0045', '--session', a.id).stdout, 'released migration 0045\n');
});
