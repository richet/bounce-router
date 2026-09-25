import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {listSessions, resolveSessionRef, sessionsTable, sessionAge} from '../src/sessions.js';
import {deriveSessionName} from '../src/session-names.js';

const tmpRoot = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('resolveSessionRef: full id, unique name (case-insensitive), unique id prefix; ambiguity and misses name the alternatives', t => {
  const root = tmpRoot('bounce-sessions-'), cwd = tmpRoot('bounce-sessions-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const a = new Session(cwd, {root}); a.append({kind: 'user', text: 'first prompt'}); a.append({kind: 'session.renamed', name: 'Billing'});
  const b = new Session(cwd, {root}); b.append({kind: 'user', text: 'second prompt'}); b.append({kind: 'session.renamed', name: 'billing'});
  const c = new Session(cwd, {root}); c.append({kind: 'user', text: 'third prompt'});
  assert.equal(resolveSessionRef(root, a.id), a.id);
  assert.equal(resolveSessionRef(root, 'third prompt'), c.id);
  assert.equal(resolveSessionRef(root, 'THIRD PROMPT'), c.id);
  assert.throws(() => resolveSessionRef(root, 'billing'), {message: new RegExp(`^Ambiguous session name "billing": .*${a.id.slice(0, 8)}|${b.id.slice(0, 8)}`)});
  const unique = [a, b, c].map(s => s.id).find(id => [a, b, c].filter(s => s.id.startsWith(id.slice(0, 8))).length === 1);
  assert.equal(resolveSessionRef(root, unique.slice(0, 8)), unique);
  assert.throws(() => resolveSessionRef(root, 'nope-nope'), {message: 'No session matches "nope-nope" (bounce sessions lists them)'});
  assert.throws(() => resolveSessionRef(root, ''), {message: 'Which session? Give a name or id (bounce sessions lists them)'});
  const rows = listSessions(root);
  assert.deepEqual(rows.map(r => r.name).sort(), ['Billing', 'billing', 'third prompt']);
});

test('resolveSessionRef: a session with no name at all resolves by its derived adjective-noun name', t => {
  const root = tmpRoot('bounce-sessions-'), cwd = tmpRoot('bounce-sessions-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  // The orchestrator-brief-only first prompt leaves reducers.sessionName null — the true
  // "unnamed" case (see sessions.js `explicitName`/`name` vs `derivedName`).
  const a = new Session(cwd, {root});
  a.append({kind: 'user', text: 'You are the orchestrator peer of session abc; see ORDERS.md.'});
  const derived = deriveSessionName(a.id);
  assert.equal(listSessions(root).find(r => r.id === a.id).name, null);
  assert.equal(resolveSessionRef(root, derived), a.id);
  assert.equal(resolveSessionRef(root, derived.toUpperCase()), a.id);
});

test('resolveSessionRef: two sessions sharing a derived name refuse and list the candidates', t => {
  const root = tmpRoot('bounce-sessions-'), cwd = tmpRoot('bounce-sessions-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  // Brute-forced fixture ids that both derive to "scarlet-finch" (src/session-names.js).
  // Session() only accepts an explicit id for an existing journal, so seed empty ones first.
  for (const id of ['fixture-42', 'fixture-140']) {
    fs.mkdirSync(path.join(root, 'sessions', id), {recursive: true});
    fs.writeFileSync(path.join(root, 'sessions', id, 'journal.jsonl'), '');
  }
  const a = new Session(cwd, {root, id: 'fixture-42'}); a.append({kind: 'user', text: 'You are the orchestrator peer of session abc; see x.'});
  const b = new Session(cwd, {root, id: 'fixture-140'}); b.append({kind: 'user', text: 'You are the orchestrator peer of session abc; see x.'});
  assert.equal(deriveSessionName(a.id), 'scarlet-finch');
  assert.equal(deriveSessionName(b.id), 'scarlet-finch');
  assert.throws(() => resolveSessionRef(root, 'scarlet-finch'), {message: 'Ambiguous session name "scarlet-finch": fixture-, fixture- — use the id'});
});

test('resolveSessionRef: an explicit rename wins over another session\'s derived name', t => {
  const root = tmpRoot('bounce-sessions-'), cwd = tmpRoot('bounce-sessions-cwd-');
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const unnamed = new Session(cwd, {root}); unnamed.append({kind: 'user', text: 'You are the orchestrator peer of session abc; see x.'});
  const claimed = deriveSessionName(unnamed.id);
  const renamed = new Session(cwd, {root}); renamed.append({kind: 'user', text: 'first'}); renamed.append({kind: 'session.renamed', name: claimed});
  assert.equal(resolveSessionRef(root, claimed), renamed.id);
});

test('sessionsTable and sessionAge: exact lines', () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  assert.equal(sessionAge('2026-09-13T11:59:30.000Z', now), '30s');
  assert.equal(sessionAge('2026-09-13T11:15:00.000Z', now), '45m');
  assert.equal(sessionAge('2026-09-13T03:00:00.000Z', now), '9h');
  assert.equal(sessionAge('2026-09-10T12:00:00.000Z', now), '3d');
  assert.equal(sessionAge(undefined, now), '?');
  const rows = [
    {id: 'abcdef12-0000', name: 'Billing arrangements', cwd: '/w/a', updated: '2026-09-13T11:15:00.000Z', live: true, operation: 'orchestrator'},
    {id: '12345678-0000', name: null, derivedName: deriveSessionName('12345678-0000'), cwd: '/w/b', updated: '2026-09-10T12:00:00.000Z', live: false, operation: 'classic'},
  ];
  assert.deepEqual(sessionsTable(rows, {now}), [
    '  NAME                            AGE  MODE         ID        WORKSPACE',
    '● Billing arrangements            45m  orchestrator abcdef12  /w/a',
    `  ${deriveSessionName('12345678-0000').padEnd(30)} ${'3d'.padStart(4)}  classic      12345678  /w/b`,
  ]);
  assert.deepEqual(sessionsTable([]), ['No sessions yet']);
});
