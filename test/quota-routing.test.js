// Between cloud peers of an `auto` agent, the subscription with the most room per hour left before its weekly reset
// plays the task: a week's share unused at its reset is lost. The room is measured under a ceiling the user sets per
// provider, which can rise over the last hours of the window.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pickAI} from '../src/jev.js';
import {normalizeQuotaSettings, ceilingAt, weeklyRoom} from '../src/quota.js';
import {orchestratorStatus, formatStatus} from '../src/control-status.js';
import {validateOrchestration} from '../src/profiles.js';
import {agentMetadata} from '../src/agents.js';

const builder = `---\nname: builder\ndescription: Writes the change.\npolicy: write\nmodels: [auto, claude/sonnet, codex/gpt-5.6-terra]\n---\nYou are the builder.\n`;
const roles = new Map([['builder', {...agentMetadata(builder), source: 'user', file: '/x/builder.md'}]]);
const {profiles} = validateOrchestration({operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude', 'codex'], models: {}, local: {}, profiles: {main: {adapter: 'claude', model: 'opus'}}}, undefined, {roles});
const head = profiles.builder;
const now = Date.parse('2026-03-10T12:00:00Z');
const hour = 3600000;
const week = (percent, resetsAt) => ({windows: [{label: '7d', percent, resetsAt, minutes: 10080}]});
// Codex at 30% resetting in 40 hours, Claude at 35% resetting in 80.
const today = {codex: week(30, Date.parse('2026-03-12T04:00:00Z')), claude: week(35, Date.parse('2026-03-13T20:00:00Z'))};
const pick = (quotas, quotaSettings) => pickAI({profiles, head, notes: {}, locals: [], tier: 'mid', longContext: false, quotas, cooldowns: {}, localFree: () => true, now, ...(quotaSettings ? {quotaSettings} : {})});

test('quota settings: a ceiling per provider or one for all, and an optional rise before the reset', () => {
  assert.deepEqual(normalizeQuotaSettings(undefined), {ceiling: {}, ramp: null});
  assert.deepEqual(normalizeQuotaSettings({ceiling: 50}), {ceiling: {'*': 50}, ramp: null});
  assert.deepEqual(normalizeQuotaSettings({ceiling: {codex: 40, claude: 'x', muse: 120}, ramp: {hours: 24, to: 90}}), {ceiling: {codex: 40}, ramp: {hours: 24, to: 90}});
  assert.deepEqual(normalizeQuotaSettings({ramp: {hours: 0}}), {ceiling: {}, ramp: null}, 'a rise over no hours is none');
});

test('the ceiling holds until the rise begins, then climbs straight to its top at the reset', () => {
  const settings = normalizeQuotaSettings({ceiling: {codex: 50}, ramp: {hours: 24, to: 100}});
  const resetsAt = now + 48 * hour;
  assert.equal(ceilingAt(settings, 'codex', {resetsAt}, now), 50);
  assert.equal(ceilingAt(settings, 'codex', {resetsAt}, now + 36 * hour), 75);
  assert.equal(ceilingAt(settings, 'codex', {resetsAt}, now + 48 * hour), 100);
  assert.equal(ceilingAt(settings, 'claude', {resetsAt}, now), 100, 'no ceiling set: the whole window');
  assert.equal(ceilingAt(normalizeQuotaSettings({ceiling: 50}), 'claude', {resetsAt}, now), 50);
});

test('the room is the share left under the ceiling per hour to the weekly reset; no weekly reading, no room', () => {
  const settings = normalizeQuotaSettings({ceiling: 50});
  const room = weeklyRoom(today.codex, 'codex', settings, now);
  assert.deepEqual([room.percent, room.ceiling, room.headroom, room.hours], [30, 50, 20, 40]);
  assert.equal(weeklyRoom(week(60, now + hour), 'codex', settings, now).headroom, 0, 'over the ceiling: no room, not negative');
  assert.equal(weeklyRoom({windows: [{label: '5h', percent: 3, resetsAt: now + hour}]}, 'codex', settings, now), null);
  assert.equal(weeklyRoom(week(10, now - hour), 'codex', settings, now), null, 'a window that has ended has no reading');
});

test('the job goes to codex: 20 points in 40 hours against 15 in 80', () => {
  const picked = pick(today, normalizeQuotaSettings({ceiling: 50}));
  assert.equal(picked.ai, 'codex_terra');
  assert.match(picked.why, /^20 points left under its 50% ceiling, 40 h before its weekly reset$/);
});

test('room wins over the sooner reset: a week nearly at its ceiling gives way to one with room', () => {
  const quotas = {codex: week(49, now + 24 * hour), claude: week(10, now + 96 * hour)};
  assert.equal(pick(quotas, normalizeQuotaSettings({ceiling: 50})).ai, 'claude_sonnet', '1 point in 24 h against 40 in 96');
});

test('a ceiling is a preference, not a stop: both over it, the job still runs, on the sooner reset', () => {
  const quotas = {codex: week(70, now + 24 * hour), claude: week(60, now + 96 * hour)};
  assert.equal(pick(quotas, normalizeQuotaSettings({ceiling: 50})).ai, 'codex_terra');
});

test('with no reading, or only one peer with one, the old order stands', () => {
  assert.equal(pick({}).ai, 'claude_sonnet', 'no readings: the list\'s order');
  assert.equal(pick({claude: week(90, now + 96 * hour)}).ai, 'claude_sonnet', 'a vendor with no reading still goes last');
});

test('status shows each quota with its ceiling and reset', () => {
  const view = orchestratorStatus([], {now, quotas: today, quotaSettings: normalizeQuotaSettings({ceiling: {codex: 50}})});
  assert.deepEqual(view.quota.map(q => [q.provider, q.window, q.percent, q.ceiling]), [['codex', '7d', 30, 50], ['claude', '7d', 35, 100]]);
  assert.match(formatStatus(view), /\nQuota: codex 7d 30% of 50, resets 2026-03-12 04:00Z · claude 7d 35%, resets 2026-03-13 20:00Z$/);
  assert.equal(orchestratorStatus([], {now}).quota, undefined, 'no readings: no quota line');
});
