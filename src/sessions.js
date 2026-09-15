// Sessions as things a person can name and come back to. The log is the source of truth: a
// session's name is a fold over its own rows (session.renamed, else its first prompt), and a
// reference typed by the user — a name, a full id or a unique id prefix — resolves against the
// listing. Pure over the filesystem it is given; no TUI, no daemon.
import fs from 'node:fs';
import path from 'node:path';
import {Session, pidAlive} from './core.js';
import * as reducers from './reducers.js';

// `bounce sessions` rows carry spend recomputed from the log — null for a session with no task rows.
export function sessionSpend(events) {
  if (!events.some(e => e.kind === 'task.submitted')) return null;
  const view = reducers.spend?.(events);
  if (!view) return null;
  const roots = Object.values(view.roots ?? {});
  const tokens = roots.reduce((sum, r) => sum + (r.tokens || 0), 0);
  const measured = roots.length > 0 && roots.every(r => r.measured);
  const tasks = Object.keys(view.tasks ?? {}).length;
  return {tokens, measured, tasks};
}

export function listSessions(root) {
  const dir = path.join(root, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(id => {
    try {
      // A listing is read-only: an empty journal (a crash before the first write) is skipped,
      // never opened — opening it would append a fresh session row into a foreign session.
      const file = path.join(dir, id, 'journal.jsonl');
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) return [];
      const s = new Session(process.cwd(), {root, id});
      let daemon = null;
      try { daemon = JSON.parse(fs.readFileSync(path.join(dir, id, 'daemon.json'), 'utf8')); } catch {}
      const live = !!(daemon && pidAlive(daemon.pid));
      // Which operation mode a session ran under is a fold over its own log, so it survives
      // the daemon that wrote it (daemon.json is removed on a clean exit).
      const operation = s.events.findLast(e => e.kind === 'operation');
      return [{id, name: reducers.sessionName(s.events), cwd: s.cwd, updated: s.events.at(-1)?.time, live, pid: live ? daemon.pid : undefined,
        operation: operation?.operation ?? 'classic', orchestrator: operation?.orchestrator ?? null,
        prompt: s.events.find(e => e.kind === 'user')?.text?.slice(0, 80) ?? '(empty)',
        spend: sessionSpend(s.events)}];
    }
    catch { return []; }
  }).sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
}

// A session reference as a person types it: the full id, a name (case-insensitive, must be
// unique), or a unique id prefix. Anything else is an error that names the alternatives.
export function resolveSessionRef(root, ref) {
  const wanted = String(ref ?? '').trim();
  if (!wanted) throw new Error('Which session? Give a name or id (bounce sessions lists them)');
  const rows = listSessions(root);
  if (rows.some(r => r.id === wanted)) return wanted;
  const short = r => r.id.slice(0, 8);
  const byName = rows.filter(r => r.name && r.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new Error(`Ambiguous session name "${wanted}": ${byName.map(short).join(', ')} — use the id`);
  const byPrefix = rows.filter(r => r.id.startsWith(wanted));
  if (byPrefix.length === 1) return byPrefix[0].id;
  if (byPrefix.length > 1) throw new Error(`Ambiguous session id "${wanted}": ${byPrefix.map(short).join(', ')}`);
  throw new Error(`No session matches "${wanted}" (bounce sessions lists them)`);
}

export function sessionAge(updated, now = Date.now()) {
  const ms = updated ? now - Date.parse(updated) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// The human listing: one line per session, newest first. Exact shape pinned by test/sessions.test.js.
export function sessionsTable(rows, {now = Date.now()} = {}) {
  if (!rows.length) return ['No sessions yet'];
  const lines = [`  ${'NAME'.padEnd(30)} ${'AGE'.padStart(4)}  ${'MODE'.padEnd(12)} ${'ID'.padEnd(8)}  WORKSPACE`];
  for (const r of rows) {
    const name = (r.name ?? '(unnamed)').slice(0, 30);
    lines.push(`${r.live ? '●' : ' '} ${name.padEnd(30)} ${sessionAge(r.updated, now).padStart(4)}  ${r.operation.padEnd(12)} ${r.id.slice(0, 8)}  ${r.cwd}`);
  }
  return lines;
}
