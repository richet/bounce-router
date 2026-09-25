import test from 'node:test';
import assert from 'node:assert/strict';
import {supervisePlan} from '../src/plan-supervision.js';

test('a hanging plan attempt is aborted at its startup allowance and becomes unavailable once', {timeout: 100}, async () => {
  const events = [];
  const append = row => events.push(row);
  let signal;
  const result = await supervisePlan({
    events, append, plan: 'plan-1', startupMs: 10,
    run: ({signal: supplied}) => { signal = supplied; return new Promise(() => {}); },
  });
  assert.equal(signal.aborted, true);
  assert.equal(result.status, 'unavailable');
  assert.equal(events.filter(event => event.kind === 'plan.unavailable').length, 1);
});

test('a late accepted result cannot reverse an unavailable timeout', async () => {
  const events = [];
  const append = row => events.push(row);
  const late = Promise.withResolvers();
  const result = await supervisePlan({events, append, plan: 'plan-1', startupMs: 10, run: () => late.promise});
  assert.deepEqual(result, {status: 'unavailable', reason: 'startup_timeout'});
  late.resolve({verdict: 'accept'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(event => event.kind === 'plan.unavailable').length, 1);
  assert.equal(events.some(event => event.kind === 'plan.accepted'), false);
});

test('an external scheduler abort cancels the plan call without recording unavailable', {timeout: 100}, async () => {
  const events = [];
  const append = row => events.push(row);
  const scheduler = new AbortController();
  const running = Promise.withResolvers();
  const pending = supervisePlan({events, append, plan: 'plan-1', startupMs: 500, signal: scheduler.signal,
    run: ({signal}) => { running.resolve(signal); return new Promise(() => {}); }});
  const planSignal = await running.promise;
  scheduler.abort(new Error('scheduler closed'));
  assert.deepEqual(await pending, {status: 'cancelled'});
  assert.equal(planSignal.aborted, true);
  assert.equal(events.some(event => event.kind === 'plan.unavailable'), false);
});

test('restart attempts preserve the absolute deadline and stop after the third journaled attempt', async () => {
  const events = [
    {kind: 'plan.attempt', plan: 'plan-1', attempt: 1, dueAt: 110},
    {kind: 'plan.attempt', plan: 'plan-1', attempt: 2, dueAt: 110},
  ];
  const append = row => events.push(row);
  let calls = 0;
  const third = await supervisePlan({events, append, plan: 'plan-1', now: () => 100, startupMs: 120,
    run: async () => { calls++; return {verdict: 'accept'}; }});
  assert.deepEqual(third, {status: 'decision', decision: {verdict: 'accept'}});
  assert.deepEqual(events.at(-1), {kind: 'plan.attempt', plan: 'plan-1', attempt: 3, dueAt: 110});
  const exhausted = await supervisePlan({events, append, plan: 'plan-1', now: () => 105, startupMs: 120,
    run: async () => { calls++; return {verdict: 'accept'}; }});
  assert.deepEqual(exhausted, {status: 'unavailable', reason: 'attempts_exhausted'});
  assert.equal(calls, 1);
  assert.equal(events.filter(event => event.kind === 'plan.unavailable').length, 1);
});
