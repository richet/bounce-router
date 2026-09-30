// The local model server is one machine's resource, not one bounce home's: every bounce process of
// this user, whatever its BOUNCE_HOME, shares these slots. Found live (ACE d1bc0206, 2026-09-28): a
// second bounce started with another home queued its worker inside LM Studio behind the first one's
// builder, which then read as "stalled for 604 s". A slot is a file naming its holder; it is taken by
// an exclusive link (complete content or nothing), and a slot whose holder process is gone is free.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pidAlive} from './core.js';

// Not under BOUNCE_HOME on purpose: two homes must meet in the same place.
export const machineDir = (env = process.env) => env.BOUNCE_MACHINE_DIR || path.join(os.homedir(), '.bounce', 'machine');

const serverKey = url => {
  const text = String(url ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
};

function readHolder(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function createMachineSlots({dir = machineDir(), pid = process.pid, alive = pidAlive, clock = () => Date.now()} = {}) {
  const held = new Map(); // token -> slot file

  function take(file, holder) {
    const record = {pid, ...holder, since: new Date(clock()).toISOString()};
    const draft = `${file}.${pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(draft, JSON.stringify(record), {mode: 0o600});
    try {
      fs.linkSync(draft, file);
      return record;
    } catch (error) {
      if (error.code === 'EEXIST') return null;
      throw error;
    } finally {
      fs.rmSync(draft, {force: true});
    }
  }

  // {ok: true, token} or {ok: false, holders}: who has the slots, for the line the waiting task shows.
  function acquire({url, slots = 1, holder = {}}) {
    const folder = path.join(dir, 'local', serverKey(url));
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    const holders = [];
    for (let index = 0; index < slots; index += 1) {
      const file = path.join(folder, `slot-${index}.json`);
      const current = readHolder(file);
      if (current && alive(current.pid)) {
        holders.push(current);
        continue;
      }
      // Its holder is gone (or the file never said who): the slot is free.
      if (fs.existsSync(file)) fs.rmSync(file, {force: true});
      if (!take(file, holder)) {
        holders.push(readHolder(file) ?? {pid: null});
        continue;
      }
      const token = crypto.randomUUID();
      held.set(token, file);
      return {ok: true, token};
    }
    return {ok: false, holders};
  }

  function release(token) {
    const file = held.get(token);
    if (!file) return false;
    held.delete(token);
    if (readHolder(file)?.pid === pid) fs.rmSync(file, {force: true});
    return true;
  }

  function releaseAll() {
    for (const token of [...held.keys()]) release(token);
  }

  return {acquire, release, releaseAll};
}
