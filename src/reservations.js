// Names that parallel sessions of one project share (a migration number, a port, a database name), reserved before
// they are used. Found live, 2026-11-04: run A was given migration 0045, and run B's builder, which saw only
// its own copy, took 0045 too. A reservation is a file under the machine directory (shared by every BOUNCE_HOME, like
// machine-slots.js), taken by an exclusive link, so it is whole or absent. It is free again when it is released, when
// its session's daemon is gone, or when the task it was bound to has ended.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pidAlive, readJournal} from './core.js';
import {tasks as taskStates, TERMINAL} from './reducers.js';
import {machineDir} from './machine-slots.js';

export const reservationsDir = (env = process.env) => path.join(machineDir(env), 'reservations');
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_VALUE = 120;
const NEXT_TRIES = 1000;

const key = text => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 24);
// The project is its origin URL when it has one (item 4's `repository`), else the checkout's path.
export const projectKey = ({repository, cwd}) => key(repository || cwd);

export function validName(name, value) {
  if (!NAME.test(String(name ?? ''))) return 'name is one lowercase word, like migration, port or database';
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_VALUE || /[\n\r]/.test(value)) return `value is one line of at most ${MAX_VALUE} characters`;
  return null;
}

// The holder still holds it: its daemon runs, and the task it is bound to (if any) has not ended in its journal.
export function holderLive(holder, {alive = pidAlive} = {}) {
  if (!holder || !Number.isSafeInteger(holder.pid) || !alive(holder.pid)) return false;
  if (!holder.task || !holder.journal) return true;
  try { return !TERMINAL.has(taskStates(readJournal(holder.journal).events)[holder.task]?.state); } catch { return true; }
}

const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export function createReservations({dir = reservationsDir(), project, live = holderLive, clock = () => Date.now()}) {
  const root = path.join(dir, project);
  const fileOf = (name, value) => path.join(root, `${key(`${name}:${value}`)}.json`);

  function link(file, record) {
    fs.mkdirSync(root, {recursive: true, mode: 0o700});
    const draft = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(draft, JSON.stringify(record), {mode: 0o600});
    try { fs.linkSync(draft, file); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; } finally { fs.rmSync(draft, {force: true}); }
  }

  // One exact value: {ok, reservation} or {ok: false, holder} naming who has it.
  function take({name, value, holder}) {
    const invalid = validName(name, value);
    if (invalid) return {ok: false, reason: invalid};
    const file = fileOf(name, value);
    const record = {name, value, ...holder, since: new Date(clock()).toISOString()};
    for (let attempt = 0; attempt < 2; attempt++) {
      if (link(file, record)) return {ok: true, reservation: record};
      const current = read(file);
      if (current && current.session === holder.session) return {ok: true, reservation: current, already: true};
      if (current && live(current)) return {ok: false, holder: current, reason: `${name} ${value} is reserved by session ${String(current.session).slice(0, 8)}${current.task ? ` for task ${String(current.task).slice(0, 8)}` : ''} since ${current.since}`};
      fs.rmSync(file, {force: true}); // its holder is gone: free
    }
    return {ok: false, reason: `${name} ${value} is being taken by another session; try again`};
  }

  // The first free value counting up from `from`, keeping its zero padding (0045, 0046, ...).
  function next({name, from, holder}) {
    const text = String(from ?? '');
    if (!/^\d{1,12}$/.test(text)) return {ok: false, reason: 'from is a number, like 0045'};
    let refused = 0;
    for (let n = Number(text); refused < NEXT_TRIES; n++, refused++) {
      const value = String(n).padStart(text.length, '0');
      const taken = take({name, value, holder});
      if (taken.ok && !taken.already) return taken;
    }
    return {ok: false, reason: `no free ${name} in ${NEXT_TRIES} values from ${text}`};
  }

  function release({name, value, session}) {
    const file = fileOf(name, value);
    const current = read(file);
    if (!current) return {ok: true, released: false};
    if (current.session !== session && live(current)) return {ok: false, reason: `${name} ${value} is reserved by session ${String(current.session).slice(0, 8)}, not this one`};
    fs.rmSync(file, {force: true});
    return {ok: true, released: true, reservation: current};
  }

  // Bind this session's reservations to the task whose orders carry them: they end when it ends.
  function bind({session, task, journal, names}) {
    const bound = [];
    for (const entry of names) {
      const at = String(entry).indexOf(':');
      const [name, value] = at > 0 ? [entry.slice(0, at), entry.slice(at + 1)] : [entry, ''];
      const file = fileOf(name, value);
      const current = read(file);
      if (!current || current.session !== session) return {ok: false, reason: `${entry} is not reserved by this session: reserve it first`};
      bound.push({file, record: {...current, task, journal}});
    }
    for (const {file, record} of bound) {
      const draft = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(draft, JSON.stringify(record), {mode: 0o600});
      fs.renameSync(draft, file);
    }
    return {ok: true, bound: bound.map(({record}) => record)};
  }

  // What is held now; a record whose holder is gone is cleared on the way.
  function list() {
    let names;
    try { names = fs.readdirSync(root).filter(name => name.endsWith('.json')); } catch { return []; }
    const held = [];
    for (const name of names) {
      const file = path.join(root, name);
      const record = read(file);
      if (record && live(record)) held.push(record);
      else fs.rmSync(file, {force: true});
    }
    return held.sort((a, b) => `${a.name}:${a.value}`.localeCompare(`${b.name}:${b.value}`));
  }

  return {take, next, release, bind, list};
}

// One session's view: it holds what it takes, with its daemon's pid, so its reservations end with it.
export function sessionReservations(session, {dir = reservationsDir(), pid = process.pid, live = holderLive, clock} = {}) {
  const row = session.events.find(event => event.kind === 'session');
  const ledger = createReservations({dir, project: projectKey({repository: row?.repository, cwd: session.cwd}), live, ...(clock ? {clock} : {})});
  const holder = {session: session.id, pid};
  return {
    take: ({name, value}) => ledger.take({name, value: typeof value === 'number' ? String(value) : value, holder}),
    next: ({name, from}) => ledger.next({name, from, holder}),
    release: ({name, value}) => ledger.release({name, value: String(value ?? ''), session: session.id}),
    bind: ({task, names}) => ledger.bind({session: session.id, task, journal: session.file, names}),
    list: () => ledger.list(),
  };
}
