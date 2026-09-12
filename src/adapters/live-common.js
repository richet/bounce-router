import {spawn as spawnProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {limitPattern} from '../providers.js';

// Shared by every live adapter: a vendor process must never block on an undrained pipe, never
// throw out of band, never see the bus, and always be cancellable within a bound.
export const vendorEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('BOUNCE_BUS') && k !== 'BOUNCE_REMOTE_SESSION'));

// Yields {kind:'line', text} per stdout line (the adapter normalizes), {kind:'diagnostic', text} per
// stderr line, then exactly one terminal event: {kind:'exit', code, signal, limited} or {kind:'error', code, text}.
export function spawnLive({executable, args, cwd, env = vendorEnv(), stdin, spawn = spawnProcess}) {
  const child = spawn(executable, args, {cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
  const queue = []; let wake = null, done = false, tail = '';
  const push = e => { queue.push(e); const w = wake; wake = null; w?.(); };
  const end = e => { if (!done) { done = true; push(e); } };
  child.on('error', error => end({kind: 'error', code: error.code === 'ENOENT' ? 'missing' : error.code ?? 'error', text: error.message}));
  child.stdin?.on('error', () => {});
  child.stdin?.end(stdin);
  if (child.stdout) createInterface({input: child.stdout}).on('line', text => push({kind: 'line', text}));
  if (child.stderr) createInterface({input: child.stderr}).on('line', text => { tail = (tail + '\n' + text).slice(-16000); push({kind: 'diagnostic', text}); });
  child.on('close', (code, signal) => end({kind: 'exit', code, signal, limited: limitPattern.test(tail)}));
  const events = (async function* () {
    for (;;) {
      while (queue.length) { const e = queue.shift(); yield e; if (e.kind === 'exit' || e.kind === 'error') return; }
      if (done) return;
      await new Promise(r => { wake = r; });
    }
  })();
  return {child, events, exited: () => done};
}

export const PENDING_MAX = 50, TEXT_MAX = 1_000_000;
const rawLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
// A torn line (a crash mid-append) is skipped on read but still occupies its slot, so the cap cannot be bypassed by corruption.
export const readPending = file => rawLines(file).flatMap(l => { try { const t = JSON.parse(l).text; return typeof t === 'string' ? [t] : []; } catch { return []; } });
export function appendPending(file, text) {
  if (typeof text !== 'string' || text.length > TEXT_MAX || rawLines(file).length >= PENDING_MAX) return false;
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.appendFileSync(file, JSON.stringify({text}) + '\n', {mode: 0o600});
  return true;
}
export function takePending(file) { const texts = readPending(file); try { fs.truncateSync(file, 0); } catch {} return texts; }
// Peer-supplied text that lands inside a prompt template must not be able to forge the template's line structure.
export const promptSafe = text => String(text).replace(/[\r\n]+/g, ' ').slice(0, 1000);

export async function verifiedCancel(child, {kill = process.kill, termWait = 1500, killWait = 1500} = {}) {
  const pid = child?.pid;
  if (!pid) return {verified: true};
  const gone = () => { try { kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
  const group = sig => { try { process.platform === 'win32' ? kill(pid, sig) : kill(-pid, sig); } catch {} };
  const closed = ms => new Promise(r => { const done = () => { clearTimeout(timer); r(true); }; const timer = setTimeout(() => { child.off('close', done); r(false); }, ms); child.once('close', done); });
  if (gone()) return {verified: true};
  group('SIGTERM');
  if (await closed(termWait) || gone()) return {verified: true};
  group('SIGKILL');
  await closed(killWait);
  return {verified: gone()};
}
