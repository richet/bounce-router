// The local model is one machine's resource, not one bounce home's. Found live (ACE d1bc0206,
// 2026-09-28): a second bounce, started with another home, queued its worker on the same LM Studio
// slot and the first one's builder sat "stalled for 604 s". Daniel: the machine runs one at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMachineSlots} from '../src/machine-slots.js';

const setup = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-machine-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
const url = 'http://127.0.0.1:1234';

test('one process holds the slot, the next is told who has it, and gets it once it is released', t => {
  const dir = setup(t);
  const alive = pid => [101, 202].includes(pid);
  const first = createMachineSlots({dir, pid: 101, alive, clock: () => Date.parse('2026-09-28T07:00:00Z')});
  const second = createMachineSlots({dir, pid: 202, alive, clock: () => Date.parse('2026-09-28T07:01:00Z')});

  const held = first.acquire({url, slots: 1, holder: {session: 'aaaa', task: 'one'}});
  const refused = second.acquire({url, slots: 1, holder: {session: 'bbbb', task: 'two'}});

  assert.equal(held.ok, true);
  assert.deepEqual(refused, {ok: false, holders: [{pid: 101, session: 'aaaa', task: 'one', since: '2026-09-28T07:00:00.000Z'}]});
  assert.equal(first.release(held.token), true);
  assert.equal(second.acquire({url, slots: 1, holder: {session: 'bbbb', task: 'two'}}).ok, true);
});

test('a slot whose holder is gone is taken over; a second slot is a second file; another endpoint is its own', t => {
  const dir = setup(t);
  const dead = createMachineSlots({dir, pid: 303, alive: () => true});
  assert.equal(dead.acquire({url, slots: 1, holder: {session: 'gone', task: 'lost'}}).ok, true);

  const next = createMachineSlots({dir, pid: 404, alive: pid => pid === 404});
  const taken = next.acquire({url, slots: 1, holder: {session: 'cccc', task: 'three'}});
  assert.equal(taken.ok, true);
  assert.equal(next.acquire({url, slots: 1, holder: {session: 'cccc', task: 'four'}}).ok, false);
  assert.equal(next.acquire({url, slots: 2, holder: {session: 'cccc', task: 'four'}}).ok, true);
  assert.equal(next.acquire({url: 'http://127.0.0.1:11434', slots: 1, holder: {session: 'cccc', task: 'five'}}).ok, true);
  // the same server, written differently, is the same slot
  assert.equal(next.acquire({url: 'http://127.0.0.1:1234/', slots: 2, holder: {session: 'cccc', task: 'six'}}).ok, false);
});

test('releasing twice, or what another process holds, changes nothing; releaseAll gives back only its own', t => {
  const dir = setup(t);
  const alive = () => true;
  const mine = createMachineSlots({dir, pid: 11, alive});
  const theirs = createMachineSlots({dir, pid: 22, alive});
  const a = mine.acquire({url, slots: 2, holder: {session: 's', task: 'a'}});
  const b = theirs.acquire({url, slots: 2, holder: {session: 't', task: 'b'}});

  assert.equal(theirs.release(a.token), false);
  assert.equal(mine.release(a.token), true);
  assert.equal(mine.release(a.token), false);
  mine.acquire({url, slots: 2, holder: {session: 's', task: 'c'}});
  mine.releaseAll();

  const third = createMachineSlots({dir, pid: 33, alive});
  assert.equal(third.acquire({url, slots: 2, holder: {session: 'u', task: 'd'}}).ok, true); // the one `mine` gave back
  const full = third.acquire({url, slots: 2, holder: {session: 'u', task: 'e'}});
  assert.deepEqual(full.holders.map(holder => [holder.pid, holder.task]), [[33, 'd'], [22, 'b']]);
  assert.equal(theirs.release(b.token), true);
});
