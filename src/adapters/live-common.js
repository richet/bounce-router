import {spawn as spawnProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {limitPattern} from '../providers.js';

// Shared by every live adapter: a vendor process must never block on an undrained pipe, never
// throw out of band, never see the bus, and always be cancellable within a bound.
// Provider children inherit a scrubbed environment. The daemon may supply only this fixed,
// explicit capability set for an orchestrator/report endpoint; arbitrary profile env is never
// forwarded.
const VENDOR_CAPS = new Set(['BOUNCE_BUS', 'BOUNCE_BUS_TOKEN_FILE', 'BOUNCE_ROLE', 'BOUNCE_ORCHESTRATOR_PROFILE', 'BOUNCE_REPORT_BUS', 'BOUNCE_REPORT_TOKEN_FILE']);
export const vendorEnv = (env = process.env, capabilities = {}) => ({
  ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('BOUNCE_BUS') && k !== 'BOUNCE_REMOTE_SESSION' && !VENDOR_CAPS.has(k))),
  ...Object.fromEntries(Object.entries(capabilities).filter(([k, value]) => VENDOR_CAPS.has(k) && typeof value === 'string')),
});

// Yields {kind:'line', text} per stdout line (the adapter normalizes), {kind:'diagnostic', text} per
// stderr line, then exactly one terminal event: {kind:'exit', code, signal, limited} or {kind:'error', code, text}.
// keepStdin: a persistent peer (an app-server) is fed requests for its whole life; one-shot CLIs get their prompt and EOF.
export function spawnLive({executable, args, cwd, env = vendorEnv(), stdin, keepStdin = false, spawn = spawnProcess}) {
  const child = spawn(executable, args, {cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
  const queue = []; let wake = null, done = false, tail = '';
  const push = e => { queue.push(e); const w = wake; wake = null; w?.(); };
  const end = e => { if (!done) { done = true; push(e); } };
  child.on('error', error => end({kind: 'error', code: error.code === 'ENOENT' ? 'missing' : error.code ?? 'error', text: error.message}));
  child.stdin?.on('error', () => {});
  if (!keepStdin) child.stdin?.end(stdin); else if (stdin !== undefined) child.stdin?.write(stdin);
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

// A worker's scoped report grant, shared by every adapter that can offer a report tool. The task is
// bound twice: derived from the worker peer here, and re-checked against the bus's own authenticated
// task list before anything is published.
export const peerTask = peer =>
  typeof peer === 'string' && peer.startsWith('worker:') ? peer.slice('worker:'.length) : null;

export const reportGrant = (profile, peer) => {
  const grant = profile?.report;
  const task = peerTask(peer);
  if (!task || !grant || typeof grant.BOUNCE_REPORT_BUS !== 'string' || !grant.BOUNCE_REPORT_BUS
    || typeof grant.BOUNCE_REPORT_TOKEN_FILE !== 'string' || !grant.BOUNCE_REPORT_TOKEN_FILE
    || (grant.task !== undefined && grant.task !== task)) return null;
  return grant;
};

// One iterable per handle, alive across turns: the reader pushes, the consumer pulls. No return() —
// a `break` in a for-await leaves the stream open for the next turn, which is what lets a worker be
// driven turn by turn from one handle.
export function makeStream() {
  const ready = [], waiting = [];
  let ended = false;
  const iterator = {
    [Symbol.asyncIterator]() { return iterator; },
    next() {
      if (ready.length) return Promise.resolve({value: ready.shift(), done: false});
      if (ended) return Promise.resolve({value: undefined, done: true});
      return new Promise(resolve => waiting.push(resolve));
    },
  };
  return {
    iterator,
    push(event) {
      if (ended) return;
      const waiter = waiting.shift();
      waiter ? waiter({value: event, done: false}) : ready.push(event);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiting.splice(0)) waiter({value: undefined, done: true});
    },
  };
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
