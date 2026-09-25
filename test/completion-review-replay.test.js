import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {candidateResult} from '../src/task-result.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async predicate => {
  const until = Date.now() + 1000;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
};

test('restart applies a durable completion verdict for the same candidate without a third-party review', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-completion-replay-'));
  const first = new Session(root, {root});
  const task = 'replay';
  first.append({kind: 'task.submitted', task, profile: 'build', orders: 'implement', review: {completion: 'review'}});
  first.append({kind: 'task.started', task, attempt: 1});
  first.append({kind: 'task.reported', task, attempt: 1, outcome: 'completed', phase: 'done', text: 'implemented', next: 'review', summary: 'implemented', evidence: [], remaining: ''});
  first.append({kind: 'task.completed', task, attempt: 1, summary: 'implemented'});
  const candidate = candidateResult(first.events, task);
  first.append({kind: 'review.finished', task, stage: 'completion', round: 1, from: 'review:replay', candidateSeq: candidate.seq, candidateDigest: candidate.digest, verdict: 'accept', text: '{"verdict":"accept"}'});

  const restarted = new Session(root, {root, id: first.id});
  const reviewer = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  const scheduler = createScheduler({session: restarted, adapters: {worker: fakeAdapter(() => []), reviewer},
    profiles: {build: {adapter: 'worker', mode: 'yolo', policy: 'write', fallback: []}, review: {adapter: 'reviewer', mode: 'plan', policy: 'read-only', role: 'reviewer', fallback: []}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });

  await scheduler.reconcile();
  await waitFor(() => scheduler.tasks()[task]?.state === 'accepted');
  assert.equal(reviewer.calls.launch, 0, 'the durable matching verdict is replayed, not externally reviewed again');
  assert.equal(restarted.events.filter(row => row.kind === 'review.finished' && row.task === task).length, 1);
});
