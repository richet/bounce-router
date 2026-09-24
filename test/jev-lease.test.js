// Jev as the lease judge (docs/plans/task-leases.md §4): one Choice over the worker's recent work
// against its orders, asked at a lease end. It may only add to bounce's own progress rule, never be
// required by it: off, failing or unsure, it answers `verdict: null` and the rule decides.
import test from 'node:test';
import assert from 'node:assert/strict';
import {leaseQuestions, decideLease, judgeLease, LEASE_CRITERIA, createJevDecisions} from '../src/jev.js';

const request = {orders: 'review the P2 tree', observed: ['Reading create.ts', 'Now the tests'], calls: ['read src/create.ts', 'grep journal'], minutes: 15, lease: 1};

test('leaseQuestions: one choice over on_track/drifting/stuck, with the orders, recent work and time used as state', () => {
  const {state, questions} = leaseQuestions(request);
  assert.deepEqual(Object.keys(LEASE_CRITERIA), ['on_track', 'drifting', 'stuck']);
  assert.deepEqual(Object.keys(questions), ['progress']);
  assert.equal(questions.progress.type, 'choice');
  assert.deepEqual(questions.progress.criteria, LEASE_CRITERIA);
  assert.deepEqual(state, {orders: 'review the P2 tree', recent_text: ['Reading create.ts', 'Now the tests'], recent_calls: ['read src/create.ts', 'grep journal'], minutes_used: 15, lease: 1});
});

test('decideLease: a verdict only at or above the threshold; anything else is no verdict', () => {
  assert.deepEqual(decideLease({progress: {choice: 'stuck', confidence: 0.9}}, {confidence: 0.8}), {verdict: 'stuck', confidence: 0.9});
  assert.deepEqual(decideLease({progress: {choice: 'drifting', confidence: 0.79}}, {confidence: 0.8}), {verdict: null, confidence: 0.79});
  assert.deepEqual(decideLease({progress: {choice: 'sideways', confidence: 0.99}}, {confidence: 0.8}), {verdict: null, confidence: 0.99});
  assert.deepEqual(decideLease({}, {confidence: 0.8}), {verdict: null, confidence: 0});
});

test('judgeLease never throws and never blocks: off, no client or a failure is verdict null with the reason', async () => {
  const off = await judgeLease({...request, settings: {enabled: false}, ask: async () => { throw new Error('no'); }});
  assert.deepEqual(off, {verdict: null, confidence: 0, reason: 'jev disabled', model: null});
  const noClient = await judgeLease({...request, settings: {enabled: true}});
  assert.deepEqual(noClient, {verdict: null, confidence: 0, reason: 'jev unavailable', model: null});
  const broken = await judgeLease({...request, settings: {enabled: true}, ask: async () => { throw Object.assign(new Error('x'), {code: 'missing_key'}); }});
  assert.deepEqual(broken, {verdict: null, confidence: 0, reason: 'missing_key', model: null});
  const asked = [];
  const judged = await judgeLease({...request, settings: {enabled: true, confidence: 0.8}, ask: async r => { asked.push(r); return {answers: {progress: {choice: 'on_track', confidence: 0.93}}, model: 'jev-1.13.0'}; }});
  assert.deepEqual(judged, {verdict: 'on_track', confidence: 0.93, reason: null, model: 'jev-1.13.0'});
  assert.equal(asked[0].model, 'jev-1.13.0');
  assert.equal(asked[0].state.orders, 'review the P2 tree');
});

test('the daemon seam exposes lease with settings read at use time', async () => {
  let enabled = false;
  const jev = createJevDecisions({readSettings: () => ({enabled}), adapter: {ask: async () => ({answers: {progress: {choice: 'stuck', confidence: 0.95}}, model: 'jev-1.13.0'})}});
  assert.equal((await jev.lease(request)).reason, 'jev disabled');
  enabled = true;
  assert.deepEqual(await jev.lease(request), {verdict: 'stuck', confidence: 0.95, reason: null, model: 'jev-1.13.0'});
});
