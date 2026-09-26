// Jev judges a PLAN before any worker runs: per chunk, is it one bounded piece of work or a whole
// phase, does it say how it is accepted and verified, do its owned paths overlap another chunk's,
// does it depend on another chunk without saying so. Found live: a 40-minute "finish P2" task, two
// builders on git.ts at once, chunks with no acceptance criterion, a chunk run against a tree
// another chunk was still changing. Jev cannot write a plan; it can say whether one has these
// properties in ~300 ms, before a worker's slot is spent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planQuestions, decidePlan, judgePlan, PLAN_CHECKS} from '../src/jev.js';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createJevDecisions} from '../src/jev.js';

const plan = {phase: 'P2 gate', chunks: [
  {id: 'gate', profile: 'integrator', orders: 'Run the evidence gate and save raw output to evidence/. Acceptance: 78 passed, 0 failed, twice. Verify: paste the two summary lines.', owns: ['evidence/**'], deadline: 900000},
  {id: 'fix', profile: 'builder', orders: 'Make the one-line clone() change in src/infrastructure/git.ts. Acceptance: focused suite green. Verify: node --test output.', owns: ['src/infrastructure/git.ts'], deadline: 900000},
]};
const noul = (name, v) => ({[name]: {type: 'noul', noul: v}});
const answerFor = (chunkId, values) => Object.fromEntries(Object.keys(PLAN_CHECKS).map(c => [`${chunkId}.${c}`, {type: 'noul', noul: values[c] ?? 0.05}]));

test('the questions: one Noul per check per chunk, over a state that shows every chunk beside its siblings', () => {
  const q = planQuestions(plan);
  assert.deepEqual(Object.keys(PLAN_CHECKS), ['phase_sized', 'no_acceptance', 'overlapping_paths', 'hidden_dependency']);
  assert.deepEqual(Object.keys(q.questions).sort(), ['fix.hidden_dependency', 'fix.no_acceptance', 'fix.overlapping_paths', 'fix.phase_sized', 'gate.hidden_dependency', 'gate.no_acceptance', 'gate.overlapping_paths', 'gate.phase_sized']);
  assert.equal(q.questions['gate.phase_sized'].type, 'noul');
  assert.match(q.questions["fix.overlapping_paths"].instructions, /Chunk "fix"/);
  assert.equal(q.state.chunks.length, 2);
  assert.deepEqual(q.state.chunks[1].owns, ['src/infrastructure/git.ts']);
  assert.equal(q.state.chunks[0].deadline_minutes, 15);
});

test('decidePlan: a confident finding rejects the plan naming the chunk and the fix; a clean plan is accepted; findings under the threshold are noted, not acted on', () => {
  const clean = decidePlan({...answerFor('gate', {}), ...answerFor('fix', {})}, {plan, confidence: 0.8});
  assert.deepEqual([clean.verdict, clean.findings], ['accept', []]);
  const bad = decidePlan({...answerFor('gate', {phase_sized: 0.91}), ...answerFor('fix', {overlapping_paths: 0.85, no_acceptance: 0.6})}, {plan, confidence: 0.8});
  assert.equal(bad.verdict, 'reject');
  assert.deepEqual(bad.findings, [
    {chunk: 'gate', check: 'phase_sized', confidence: 0.91, fix: PLAN_CHECKS.phase_sized.fix},
    {chunk: 'fix', check: 'overlapping_paths', confidence: 0.85, fix: PLAN_CHECKS.overlapping_paths.fix},
  ]);
  assert.deepEqual(bad.noted, [{chunk: 'fix', check: 'no_acceptance', confidence: 0.6}]);
  // the structural checks bounce can make itself are made without Jev: overlapping owns, a missing chunk id, a deadline over the cap
  const overlap = {phase: 'x', chunks: [{id: 'a', profile: 'builder', orders: 'x', owns: ['src/git.ts']}, {id: 'b', profile: 'builder', orders: 'y', owns: ['src/**']}]};
  const structural = decidePlan({}, {plan: overlap, confidence: 0.8, ceilingMinutes: 60});
  assert.deepEqual(structural.findings.map(f => [f.chunk, f.check]), [['a', 'overlapping_paths'], ['b', 'overlapping_paths']]);
  // the structural size check is the ceiling, not the lease: 45 minutes is a long chunk, 61 is over the ceiling
  const timed = {phase: 'x', chunks: [{id: 'long', profile: 'reviewer', orders: 'x', owns: [], deadline: 45 * 60000}, {id: 'over', profile: 'reviewer', orders: 'y', owns: [], deadline: 61 * 60000}]};
  assert.deepEqual(decidePlan({}, {plan: timed, confidence: 0.8, ceilingMinutes: 60}).findings,
    [{chunk: 'over', check: 'phase_sized', confidence: 1, fix: 'this is a phase, not a chunk: split it into pieces with one owner and one acceptance each (deadline 61 min over the 60 min ceiling)'}]);
  assert.equal(PLAN_CHECKS.phase_sized.instructions('c'), 'Chunk "c" describes a whole phase or several independent pieces of work, not one bounded piece with a single owner and a single acceptance.');
});

// Reversed 2026-09-25: found live (ACE d1bc0206), Jev answered HTTP 403 for ~40 s and P4's plan sat
// `unavailable`, waiting on the user, with nothing retried. Jev is never a requirement: one retry, then
// the structural checks decide, and the reason says Jev was unavailable.
test('judgePlan retries a failing reviewer once, then falls back to the structural verdict', async () => {
  const off = await judgePlan({plan, settings: {enabled: false}, ask: async () => { throw new Error('no'); }});
  assert.deepEqual([off.verdict, off.reason], ['accept', 'jev disabled']);
  let calls = 0;
  const broken = await judgePlan({plan, settings: {enabled: true}, retryDelayMs: 0, ask: async () => { calls++; throw Object.assign(new Error('boom'), {code: 'http_403'}); }});
  assert.deepEqual([broken.verdict, broken.reason, calls], ['accept', 'jev unavailable (http_403); structural checks only', 2]);
  let first = true;
  const recovered = await judgePlan({plan, settings: {enabled: true}, retryDelayMs: 0, ask: async () => { if (first) { first = false; throw Object.assign(new Error('blip'), {code: 'http_403'}); } return {answers: {...answerFor('gate', {}), ...answerFor('fix', {})}, model: 'jev-1.13.0', latencyMs: 9}; }});
  assert.deepEqual([recovered.verdict, recovered.model], ['accept', 'jev-1.13.0']);
  const asked = [];
  const judged = await judgePlan({plan, settings: {enabled: true}, ask: async request => { asked.push(request); return {answers: {...answerFor('gate', {}), ...answerFor('fix', {phase_sized: 0.9})}, model: 'jev-1.13.0', latencyMs: 12}; }});
  assert.deepEqual([judged.verdict, judged.findings[0].chunk, judged.model], ['reject', 'fix', 'jev-1.13.0']);
  assert.equal(asked[0].state.phase, 'P2 gate');
});

test('scheduler: a plan.submitted row is judged and answered with plan.accepted or plan.rejected (findings named per chunk); the orders tell the orchestrator to plan first', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-plan-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  let verdict = {};
  const jev = createJevDecisions({readSettings: () => ({enabled: true, routing: true}), adapter: {ask: async () => ({answers: verdict, model: 'jev-1.13.0', latencyMs: 9})}});
  const scheduler = createScheduler({session, adapters: {}, profiles: {main: {adapter: 'claude', role: 'orchestrator'}, builder: {adapter: 'claude', role: 'builder', policy: 'write'}}, jev, gitHead: () => null});
  t.after(() => scheduler.close());
  verdict = {...answerFor('gate', {}), ...answerFor('fix', {})};
  session.append({kind: 'plan.submitted', plan: 'p1', from: 'orchestrator', ...plan});
  const accepted = await waitFor(() => session.events.find(e => e.kind === 'plan.accepted' && e.plan === 'p1'));
  assert.equal(accepted.text, 'P2 gate: plan.accepted');
  verdict = {...answerFor('gate', {phase_sized: 0.93}), ...answerFor('fix', {})};
  session.append({kind: 'plan.submitted', plan: 'p2', from: 'orchestrator', ...plan});
  const rejected = await waitFor(() => session.events.find(e => e.kind === 'plan.rejected' && e.plan === 'p2'));
  assert.equal(rejected.findings.length, 1);
  assert.equal(rejected.text, 'P2 gate: plan.rejected');
});
const waitFor = async fn => { const start = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - start > 8000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
