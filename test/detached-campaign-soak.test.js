import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {campaignCommand, campaigns} from '../src/orchestration.js';
import {createMainService} from '../src/main-service.js';
import {campaignContinuationState, installCampaignContinuation} from '../src/reload.js';

const CHILD = String.raw`
const payload = JSON.parse(process.env.BOUNCE_SOAK_PAYLOAD);
if (payload.crash) process.exit(17);
process.stdout.write(JSON.stringify(payload) + '\n');
`;

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('soak condition did not settle');
}

function detachedAdapter({decide, apply = () => {}}) {
  const children = new Set();
  const calls = [];
  const start = async args => {
    const payload = decide(args, calls.length + 1);
    calls.push(payload);
    const child = spawn(process.execPath, ['-e', CHILD], {detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, BOUNCE_SOAK_PAYLOAD: JSON.stringify(payload)}});
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); resolve({code, signal}); });
    });
    return {child, done, output: () => stdout, error: () => stderr};
  };
  return {
    calls,
    launch: start,
    resume: start,
    async *events(handle) {
      const exit = await handle.done;
      if (exit.code !== 0) {
        yield {kind: 'result', status: 'failed', recoverable: true,
          text: `detached provider exited ${exit.code ?? exit.signal}: ${handle.error()}`};
        return;
      }
      const payload = JSON.parse(handle.output().trim());
      for (const command of payload.commands ?? []) await apply(command);
      yield {kind: 'assistant', text: payload.text ?? 'provider completed'};
      yield {kind: 'result', status: 'completed', text: payload.text ?? 'provider completed'};
    },
    async cancel(handle) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGTERM');
      await handle.done.catch(() => {});
      return {verified: true};
    },
    async close() {
      for (const child of children) child.kill('SIGKILL');
      await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve))));
    },
  };
}

function fixture(t, {mainDecision}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-detached-campaign-'));
  const cwd = path.join(root, 'source');
  fs.mkdirSync(cwd);
  const session = new Session(cwd, {root});
  const worker = detachedAdapter({decide: () => ({text: 'worker gate complete'})});
  let scheduler;
  const mainAdapter = detachedAdapter({
    decide: mainDecision,
    apply(command) {
      if (command.kind === 'task') scheduler.submit({task: command.task, jobId: command.jobId,
        campaignId: command.campaignId, gate: command.gate, planId: command.planId, chunkId: command.chunkId,
        parent: null, from: 'orchestrator', profile: 'builder', orders: `Complete ${command.gate}`});
      else campaignCommand(session, {kind: `campaign.${command.kind}`, from: 'orchestrator',
        campaignId: command.campaignId, reason: command.reason});
    },
  });
  scheduler = createScheduler({session, adapters: {worker}, profiles: {builder: {adapter: 'worker', policy: 'read-only', fallback: []}},
    watchdog: {interval: null}});
  const main = createMainService({session, adapters: {main: mainAdapter}, profile: {adapter: 'main', mode: 'plan', fallback: []},
    profiles: {}, settings: {executables: {}, order: ['main'], models: {}, profiles: {orchestrator: {fallback: []}}, orchestrator: 'orchestrator'},
    handoffDelayMs: 5, watchdog: {startupMs: 1000, runningMs: 1000, retryDelayMs: 5, maxWakeAttempts: 2},
    continuationState: () => campaignContinuationState(session.events)});
  const stopCampaignContinuation = installCampaignContinuation({session});
  t.after(async () => {
    stopCampaignContinuation();
    await main.close();
    scheduler.close();
    await mainAdapter.close();
    await worker.close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {session, scheduler, mainAdapter};
}

test('detached providers automatically advance and close every gate of a multi-phase campaign', {timeout: 8000}, async t => {
  const f = fixture(t, {mainDecision: () => {
    const campaign = campaigns(f.session.events).release;
    if (campaign.remaining.length) {
      const gate = campaign.remaining[0];
      return {text: `dispatch ${gate}`, commands: [{kind: 'task', task: `release-${gate}`, jobId: `job-${gate}`,
        campaignId: 'release', gate}]};
    }
    return {text: 'close release', commands: [{kind: 'complete', campaignId: 'release'}]};
  }});
  campaignCommand(f.session, {kind: 'campaign.start', from: 'orchestrator', campaignId: 'release',
    objective: 'ship the detached soak', required: ['phase-1', 'phase-2', 'phase-3']});

  await waitFor(() => campaigns(f.session.events).release?.state === 'completed');
  const view = campaigns(f.session.events).release;
  assert.deepEqual(view.remaining, []);
  assert.deepEqual(f.session.events.filter(row => row.kind === 'task.submitted').map(row => row.gate), ['phase-1', 'phase-2', 'phase-3']);
  assert.equal(f.session.events.filter(row => row.kind === 'task.completed').length, 3);
  assert.equal(f.session.events.some(row => row.kind === 'main.blocked'), false);
  assert.deepEqual(f.session.events.filter(row => row.kind === 'main.disposition' && row.task).map(row => row.disposition),
    ['scheduled', 'scheduled', 'closed']);
  assert.equal(f.mainAdapter.calls.length, 4, 'initial dispatch, two successors, then campaign completion');
});

test('repeated detached main crashes replay twice then persist campaign needs-input without a prompt', {timeout: 8000}, async t => {
  const f = fixture(t, {mainDecision: () => ({crash: true})});
  campaignCommand(f.session, {kind: 'campaign.start', from: 'orchestrator', campaignId: 'faulted',
    objective: 'surface an unrecoverable detached-provider crash', required: ['phase-1', 'phase-2']});

  await waitFor(() => campaigns(f.session.events).faulted?.state === 'needs-input');
  assert.equal(f.mainAdapter.calls.length, 2, 'the unresolved action set has exactly two automatic attempts');
  assert.equal(f.session.events.filter(row => row.kind === 'user').length, 0, 'progress required no manual continue prompt');
  const blocked = f.session.events.findLast(row => row.kind === 'main.blocked');
  assert.equal(blocked.reason, 'campaign_blocked');
  assert.equal(blocked.attempts, 2);
  assert.match(campaigns(f.session.events).faulted.reason, /continuation attempts exhausted/i);
  assert.equal(f.session.events.filter(row => row.kind === 'task.submitted').length, 0);
});

test('journal reconstruction resumes remaining phases once, including detached fallback and accepted review', {timeout: 10000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-detached-reload-'));
  const cwd = path.join(root, 'source');
  fs.mkdirSync(cwd);
  const session = new Session(cwd, {root});
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes.reverse()) await runtime.close();
    fs.rmSync(root, {recursive: true, force: true});
  });

  const createRuntime = (activeSession, handoffDelayMs) => {
    const primary = detachedAdapter({decide: args => args.orders.includes('phase-2')
      ? {crash: true} : {text: 'primary worker complete'}});
    const recovery = detachedAdapter({decide: () => ({text: 'fallback worker complete'})});
    const reviewer = detachedAdapter({decide: () => ({text: '{"verdict":"accept"}'})});
    let scheduler;
    const mainAdapter = detachedAdapter({
      decide: () => {
        const campaign = campaigns(activeSession.events).reload;
        if (campaign.remaining.length) {
          const gate = campaign.remaining[0];
          return {text: `dispatch ${gate}`, commands: [{kind: 'task', task: `reload-${gate}`, jobId: `reload-job-${gate}`,
            campaignId: 'reload', gate, review: {completion: 'critic'}}]};
        }
        return {text: 'close reload campaign', commands: [{kind: 'complete', campaignId: 'reload'}]};
      },
      apply(command) {
        if (command.kind === 'task') scheduler.submit({task: command.task, jobId: command.jobId,
          campaignId: command.campaignId, gate: command.gate, planId: command.planId, chunkId: command.chunkId,
          review: command.review, parent: null, from: 'orchestrator', profile: 'builder', orders: `Complete ${command.gate}`});
        else campaignCommand(activeSession, {kind: `campaign.${command.kind}`, from: 'orchestrator', campaignId: command.campaignId});
      },
    });
    scheduler = createScheduler({session: activeSession, adapters: {primary, recovery, reviewer}, profiles: {
      builder: {adapter: 'primary', policy: 'read-only', fallback: ['recovery']},
      recovery: {adapter: 'recovery', policy: 'read-only', fallback: []},
      critic: {adapter: 'reviewer', policy: 'read-only', role: 'critic', fallback: []},
    }, watchdog: {interval: null}});
    const main = createMainService({session: activeSession, adapters: {main: mainAdapter},
      profile: {adapter: 'main', mode: 'plan', fallback: []}, profiles: {},
      settings: {executables: {}, order: ['main'], models: {}, profiles: {orchestrator: {fallback: []}}, orchestrator: 'orchestrator'},
      handoffDelayMs, watchdog: {startupMs: 1000, runningMs: 1000, retryDelayMs: 5, maxWakeAttempts: 2},
      continuationState: () => campaignContinuationState(activeSession.events)});
    const stopCampaignContinuation = installCampaignContinuation({session: activeSession});
    let closed = false;
    return {scheduler, mainAdapter, primary, recovery, reviewer, async close() {
      if (closed) return;
      closed = true;
      stopCampaignContinuation();
      await main.close();
      scheduler.close();
      await Promise.all([mainAdapter.close(), primary.close(), recovery.close(), reviewer.close()]);
    }};
  };

  const first = createRuntime(session, 250);
  runtimes.push(first);
  campaignCommand(session, {kind: 'campaign.start', from: 'orchestrator', campaignId: 'reload',
    objective: 'survive a daemon-equivalent reload', required: ['phase-1', 'phase-2', 'phase-3']});
  await waitFor(() => session.events.some(row => row.kind === 'task.accepted' && row.task === 'reload-phase-1'));
  assert.equal(session.events.some(row => row.kind === 'task.submitted' && row.gate === 'phase-2'), false);
  await first.close();

  const reopened = new Session(cwd, {root, id: session.id});
  const second = createRuntime(reopened, 5);
  runtimes.push(second);
  await second.scheduler.reconcile();
  await waitFor(() => campaigns(reopened.events).reload?.state === 'completed');

  const submissions = reopened.events.filter(row => row.kind === 'task.submitted' && row.campaignId === 'reload');
  assert.equal(submissions.filter(row => row.gate === 'phase-1').length, 1, 'accepted phase 1 is never launched again');
  assert.deepEqual(submissions.filter(row => row.gate === 'phase-2').map(row => row.profile), ['builder', 'recovery']);
  assert.equal(new Set(submissions.filter(row => row.gate === 'phase-2').map(row => row.jobId)).size, 1,
    'fallback remains an attempt of the same phase job');
  assert.equal(reopened.events.filter(row => row.kind === 'policy.fallback' && row.task === 'reload-phase-2').length, 1);
  const accepted = reopened.events.filter(row => row.kind === 'task.accepted' && row.campaignId === 'reload');
  assert.deepEqual(accepted.map(row => reopened.events.find(event => event.kind === 'task.submitted' && event.task === row.task)?.gate),
    ['phase-1', 'phase-2', 'phase-3']);
  assert.equal(new Set(accepted.map(row => row.task)).size, 3, 'each campaign phase has one accepted task');
  assert.deepEqual(campaigns(reopened.events).reload.remaining, []);
  assert.equal(reopened.events.filter(row => row.kind === 'user').length, 0);
});
