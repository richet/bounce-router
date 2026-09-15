import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {listSessions, resolveSessionRef, sessionsTable, sessionAge} from '../src/sessions.js';

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

test('sessionsTable and sessionAge: exact lines', () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  assert.equal(sessionAge('2026-09-13T11:59:30.000Z', now), '30s');
  assert.equal(sessionAge('2026-09-13T11:15:00.000Z', now), '45m');
  assert.equal(sessionAge('2026-09-13T03:00:00.000Z', now), '9h');
  assert.equal(sessionAge('2026-09-10T12:00:00.000Z', now), '3d');
  assert.equal(sessionAge(undefined, now), '?');
  const rows = [
    {id: 'abcdef12-0000', name: 'Billing arrangements', cwd: '/w/a', updated: '2026-09-13T11:15:00.000Z', live: true, operation: 'orchestrator'},
    {id: '12345678-0000', name: null, cwd: '/w/b', updated: '2026-09-10T12:00:00.000Z', live: false, operation: 'classic'},
  ];
  assert.deepEqual(sessionsTable(rows, {now}), [
    '  NAME                            AGE  MODE         ID        WORKSPACE',
    '● Billing arrangements            45m  orchestrator abcdef12  /w/a',
    '  (unnamed)                        3d  classic      12345678  /w/b',
  ]);
  assert.deepEqual(sessionsTable([]), ['No sessions yet']);
});
