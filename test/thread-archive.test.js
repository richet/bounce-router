// Found live: every Codex worker and reviewer thread bounce ran stayed in ~/.codex, listed in Daniel's
// ChatGPT app. A task's vendor threads are archived once the task has a final outcome; a completed task
// may still be reworked on the same thread, so completion alone keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (check, ms = 3000) => { const start = Date.now(); for (;;) { const value = check(); if (value) return value; if (Date.now() - start > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };

test('a task\'s vendor thread is archived when the task is accepted, not when it merely completes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-thread-archive-'));
  const session = new Session(root, {root});
  const archived = [];
  const codex = fakeAdapter(() => [{kind: 'native', provider: 'codex', sessionId: 'thread-1'}, {kind: 'result', status: 'completed', text: 'done'}]);
  codex.archive = async ({native}) => { archived.push(native.sessionId); return true; };
  const scheduler = createScheduler({session, adapters: {codex}, profiles: {build: {adapter: 'codex', policy: 'read-only'}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const row = scheduler.submit({task: 'job', profile: 'build', orders: 'do it'});
  await waitFor(() => session.events.some(e => e.kind === 'task.completed' && e.task === row.task));
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(archived, [], 'completed but not final: the thread may still be reworked');
  session.append({kind: 'task.accepted', task: row.task, from: 'user', stage: 'completion'});
  await waitFor(() => session.events.some(e => e.kind === 'task.thread.archived' && e.task === row.task));
  assert.deepEqual(archived, ['thread-1']);
  assert.deepEqual(session.events.filter(e => e.kind === 'task.thread.archived').map(e => [e.provider, e.sessionId]), [['codex', 'thread-1']]);
});

// Found live (ACE d1bc0206): two workers dead since a daemon crash stayed "orphaned" and kept every
// orchestrator turn refused. A worker whose recorded process is gone is cancelled as lost on restart.
test('on restart a worker whose recorded process is gone is cancelled as lost; one with no record stays orphaned', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-worker-lost-'));
  const session = new Session(root, {root});
  session.append({kind: 'task.submitted', task: 'gone', profile: 'build', orders: 'x', parent: null});
  session.append({kind: 'task.started', task: 'gone', attempt: 1, pid: 2 ** 30});
  session.append({kind: 'task.submitted', task: 'legacy', profile: 'build', orders: 'y', parent: null});
  session.append({kind: 'task.started', task: 'legacy', attempt: 1});
  const scheduler = createScheduler({session, adapters: {codex: fakeAdapter(() => [])}, profiles: {build: {adapter: 'codex', policy: 'read-only'}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  await scheduler.reconcile?.();
  await waitFor(() => session.events.some(e => e.task === 'legacy' && e.kind === 'task.blocked'));
  const gone = session.events.findLast(e => e.task === 'gone' && ['task.cancelled', 'task.blocked'].includes(e.kind));
  assert.deepEqual([gone.kind, gone.reason, gone.text], ['task.cancelled', 'lost_in_restart', 'its worker process (pid 1073741824) ended with the previous daemon; resubmit what is left']);
  assert.equal(session.events.findLast(e => e.task === 'legacy' && e.kind === 'task.blocked').reason, 'orphaned');
});
