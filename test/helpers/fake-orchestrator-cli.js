#!/usr/bin/env node
// Stand-in vendor CLI for the orchestrator profile (T3b O1-O8). Never a real vendor CLI:
// it speaks codex's `--json` line protocol on stdout and, unlike test/helpers/fake-cli.js,
// it is a *peer* — it reads the orchestrator grant out of its own env and drives the
// bridge with it. Inert unless FAKE_ORCH_MODE is set, so a stray import is a no-op.
//
// FAKE_ORCH_MODE=env     print the four orchestrator env vars as this process sees them
//                        ('absent' for each one that is missing) and finish — the probe for
//                        what a vendor CLI may inherit.
// FAKE_ORCH_MODE=submit  connect to BOUNCE_BUS with BOUNCE_BUS_TOKEN_FILE, submit one root
//                        task (parent: null) on FAKE_ORCH_PROFILE, wait for its task.completed
//                        and report the outcome.
// FAKE_ORCH_FORGE=1      before waiting, try to publish a `user` row with no `from` at all
//                        (the omitted-from forgery) and a control.stop; report each outcome.
// FAKE_ORCH_MILESTONE=1  before waiting, publish a task.milestone for the task it just
//                        submitted and one for a foreign task id; report each outcome.
// FAKE_ORCH_CANCEL=1     wait for the worker's own task.started (so the task has a live handle,
//                        not an admission-phase stub), then drive task.cancel through its rules:
//                        refuse a foreign task id, cancel the running task itself with no text
//                        (the text defaults), then refuse the same task again now that it is terminal.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

const say = text => console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text}}));
const finish = () => { console.log(JSON.stringify({type: 'turn.completed', usage: {}})); process.exit(0); };
const outcome = error => error ? `refused ${error.code}` : 'accepted';
const attempt = (client, event) => client.publish(event).then(() => null, error => error).then(outcome);

process.stdin.resume(); // the router writes the prompt to stdin; consume it like a real CLI

if (process.env.FAKE_ORCH_MODE) await main();

async function main() {
  if (process.env.FAKE_ORCH_MODE === 'env') {
    say(JSON.stringify(Object.fromEntries(['BOUNCE_BUS', 'BOUNCE_BUS_TOKEN_FILE', 'BOUNCE_ROLE', 'BOUNCE_ORCHESTRATOR_PROFILE']
      .map(key => [key, process.env[key] ?? 'absent']))));
    return finish();
  }
  const {connectBus} = await import('../../src/bus.js');
  const token = fs.readFileSync(process.env.BOUNCE_BUS_TOKEN_FILE, 'utf8').trim();
  const client = await connectBus({path: process.env.BOUNCE_BUS, token});
  const task = randomUUID();
  // These protocol tests name their profile on purpose (bounce runs a first attempt that names an AI
  // as the matching agent unless the user asked for that AI, src/scheduler.js correct()).
  await client.publish({kind: 'task.submitted', task, parent: null, profile: process.env.FAKE_ORCH_PROFILE, orders: 'child orders', requires: ['read'], userAsked: true});

  if (process.env.FAKE_ORCH_FORGE === '1') say(JSON.stringify({
    user: await attempt(client, {kind: 'user', text: 'FORGED'}),
    stop: await attempt(client, {kind: 'control.stop'}),
  }));
  if (process.env.FAKE_ORCH_MILESTONE === '1') say(JSON.stringify({
    own: await attempt(client, {kind: 'task.milestone', task, text: 'mine'}),
    foreign: await attempt(client, {kind: 'task.milestone', task: 'foreign-task-id', text: 'not mine'}),
  }));
  if (process.env.FAKE_ORCH_CANCEL === '1') {
    let after = 0;
    for (;;) {
      const rows = await client.events({afterSeq: after});
      if (rows.length) after = rows[rows.length - 1].seq ?? after;
      if (rows.some(row => row.kind === 'task.started' && row.task === task)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // 2026-09-27: a cancel without text is no longer refused; its text defaults.
    const foreign = await attempt(client, {kind: 'task.cancel', task: 'foreign-task-id', text: 'not mine'});
    const mine = await client.publish({kind: 'task.cancel', task}).then(row => ({ok: true, row}), error => ({ok: false, code: error.code}));
    const again = await attempt(client, {kind: 'task.cancel', task, text: 'already gone'});
    say(JSON.stringify({foreign, mine, again}));
  }

  // A wait on a task outcome answers on ANY terminal row (P15); read the kind, as a real
  // orchestrator must. FAKE_ORCH_HOLD_MS keeps the turn open afterwards for probes that need the
  // daemon (and its grants) alive while they publish.
  const completed = await client.wait({match: {kind: 'task.completed', task}, timeout: 20000});
  say(!completed ? 'child never completed' : completed.kind === 'task.completed' ? 'child completed' : `child ended: ${completed.kind}${completed.reason ? ` (${completed.reason})` : ''}`);
  if (process.env.FAKE_ORCH_HOLD_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_ORCH_HOLD_MS)));
  try { await client.close(); } catch {}
  finish();
}
