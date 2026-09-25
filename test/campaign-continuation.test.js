import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {campaignCommand, campaigns} from '../src/orchestration.js';
import {createMainService} from '../src/main-service.js';
import {campaignContinuationState, installCampaignContinuation} from '../src/reload.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error('fixture did not settle');
};

test('restart continues unmet campaign gates, successful narration cannot close them, and late plan decisions wake', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-campaign-continuation-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  campaignCommand(session, {kind: 'campaign.start', from: 'orchestrator', campaignId: 'release',
    objective: 'Complete the reliability release', required: ['lock-repair', 'P2', 'P3']});
  session.append({kind: 'task.submitted', task: 'lock', jobId: 'lock-job', campaignId: 'release', gate: 'lock-repair',
    planId: 'phase-1', chunkId: 'lock', from: 'orchestrator', profile: 'builder', orders: 'repair locking'});
  session.append({kind: 'task.completed', task: 'lock', summary: 'lock repair complete'});
  assert.throws(() => campaignCommand(session, {kind: 'campaign.complete', from: 'orchestrator', campaignId: 'release'}),
    /campaign gates unmet: P2, P3/);

  const pendingBeforeRestart = campaignContinuationState(session.events);
  assert.equal(pendingBeforeRestart.length, 1);
  assert.equal(pendingBeforeRestart[0].campaignId, 'release');
  assert.equal(pendingBeforeRestart[0].revision, 1);
  assert.deepEqual(pendingBeforeRestart[0].remaining, ['P2', 'P3']);
  assert.equal(pendingBeforeRestart[0].seq, session.events.at(-1).seq, 'terminal task progress participates in action identity');

  const calls = [];
  const adapter = {
    async launch(args) { calls.push(args); return {}; },
    async resume(args) { calls.push(args); return {}; },
    async *events() { yield {kind: 'result', status: 'completed', text: 'Narrated current status'}; },
    async cancel() { return {verified: true}; },
  };
  const main = createMainService({session, adapters: {codex: adapter}, profile: {adapter: 'codex', mode: 'plan'},
    settings: {executables: {}}, handoffDelayMs: 5,
    watchdog: {startupMs: 100, runningMs: 100, retryDelayMs: 5, maxWakeAttempts: 2},
    continuationState: () => campaignContinuationState(session.events)});
  const stopCampaignContinuation = installCampaignContinuation({session});
  t.after(async () => { stopCampaignContinuation(); await main.close(); });

  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 1);
  assert.deepEqual(campaigns(session.events).release.remaining, ['P2', 'P3'], 'narration is not a disposition');
  assert.equal(campaigns(session.events).release.state, 'active');
  await until(() => campaigns(session.events).release.state === 'needs-input');
  assert.equal(calls.length, 2, 'campaign continuation uses the same bounded two-attempt policy');
  assert.match(campaigns(session.events).release.reason, /continuation attempts/i);

  session.append({kind: 'plan.submitted', plan: 'late-plan', planId: 'late-plan', phase: 'P2', from: 'orchestrator', chunks: []});
  session.append({kind: 'plan.accepted', plan: 'late-plan', planId: 'late-plan', phase: 'P2', chunks: 0});
  await until(() => calls.length === 3);
  assert.equal(session.events.some(row => row.kind === 'main.disposition' && row.planId === 'late-plan'), true);
});
