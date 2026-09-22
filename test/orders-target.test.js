// Found live: Jev on, local on, every agent file on `auto`, three local models loaded — and the
// orchestrator sent all five tasks to cloud profiles BY NAME, which skips Jev and the local models
// entirely. Its orders listed agents, worker profiles and `auto` side by side with no default, the
// profile list advertised tiers (so it picked the tier itself), the submit example named a cloud
// profile, and one sentence said local workers are for when the user asks.
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {choosingOrders, defaultTarget} from '../src/reload.js';

const agent = name => ({derived: true, adapter: 'claude', role: name, agent: {name}});
const profiles = {main: {adapter: 'claude', role: 'orchestrator'}, build: {adapter: 'codex', role: 'builder'}, claude_haiku: {adapter: 'claude', role: 'builder'},
  analyst: agent('analyst'), 'analyst~2': {...agent('analyst')}, builder: agent('builder'), jev: {adapter: 'typesafe', role: 'critic'}};

test('the example and the default point at a job, never at a cloud profile, while there is a job to point at', () => {
  assert.equal(defaultTarget(profiles, 'main', {routingOn: true}), 'analyst');
  assert.equal(defaultTarget(profiles, 'main', {routingOn: false}), 'analyst');
  const {analyst, builder, 'analyst~2': hidden, ...noAgents} = profiles;
  assert.equal(defaultTarget(noAgents, 'main', {routingOn: true}), 'auto');
  assert.equal(defaultTarget(noAgents, 'main', {routingOn: false}), 'build');
  assert.equal(defaultTarget({main: profiles.main}, 'main', {routingOn: false}), 'build', 'the historical placeholder when the roster is empty');
});

test('the orders say who to submit to: the job first, auto next, a named AI only when the user asks for it', () => {
  const lines = choosingOrders({agents: true, routingOn: true, localOn: true});
  assert.equal(lines[0], 'Who to submit to — the job, not the AI:');
  const text = lines.join('\n');
  for (const part of [
    '1. An agent, by the job the task is',
    '2. `auto` when no agent is clearly the job',
    '3. A worker profile by name ONLY when the user asks for that specific AI',
    'Do not pick a tier or a model yourself',
    'Local models are part of the normal path',
    'do not wait for the user to ask for them'])
    assert.equal(text.includes(part), true, part);
  assert.equal(/when the user requests local/i.test(text), false);

  const noJev = choosingOrders({agents: true, routingOn: false, localOn: true}).join('\n');
  assert.equal(noJev.includes('`auto`'), false, 'auto is not offered while routing is off');
  assert.equal(noJev.includes('Do not pick a tier'), false);
  assert.equal(noJev.includes('in the order its file lists them'), true);
  const cloudOnly = choosingOrders({agents: true, routingOn: true, localOn: false}).join('\n');
  assert.equal(cloudOnly.includes('Local models'), false);
  assert.deepEqual(choosingOrders({agents: false, routingOn: false, localOn: false}), [], 'no agents and no routing: there is nothing to choose between but profiles');
});

// Found live (ACE session): the orchestrator dispatched an analyst, then spent 19 tool calls of its own
// answering the same question and wrote the next task from its own findings; the analyst's whole
// 15-minute slot was wasted.
test('the orders tell the orchestrator to wait on what it dispatched instead of doing it itself', () => {
  const text = choosingOrders({agents: true, routingOn: true, localOn: true}).join('\n');
  assert.equal(text.includes('Once you have dispatched a task, wait for it'), true);
  assert.equal(text.includes('do not investigate the same question yourself'), true);
  assert.equal(text.includes('cancel the task first'), true);
});

// Found live: an analyst ran out of its ten-minute deadline; the orders said a deadline means stop
// and report, and the orchestrator ended the whole run over it, with the builder's work done.
test('the orders tell the orchestrator to submit a plan before a phase and how bounce answers', () => {
  const text = fs.readFileSync(new URL('../src/reload.js', import.meta.url), 'utf8');
  for (const part of ['Before dispatching a phase, submit its plan', '"kind":"plan.submitted"', 'plan.accepted', 'plan.rejected', 'Fix a rejected plan and submit it again']) assert.equal(text.includes(part), true, part);
});

test('the orders say a deadline is a task to resubmit smaller, not a reason to stop the run', () => {
  const text = fs.readFileSync(new URL('../src/reload.js', import.meta.url), 'utf8');
  assert.equal(text.includes('it is not a reason to stop the run'), true);
  assert.equal(/task\.cancelled, task\.deadline or',\n\s*'task\.rejected mean stop/.test(text), false, 'a deadline is no longer listed among the stop reasons');
});
