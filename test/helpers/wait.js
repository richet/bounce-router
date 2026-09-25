import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../../src/core.js';

export async function waitFor(predicate, {timeout = 2000, interval = 10} = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

export function tmpSession(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {root, session: new Session(root, {root})};
}

// Registered after-hooks run in order, so the scheduler stops before its tmp root is removed.
export const teardown = (t, scheduler, root) => t.after(async () => {
  await scheduler.stop();
  scheduler.close();
  fs.rmSync(root, {recursive: true, force: true});
});
