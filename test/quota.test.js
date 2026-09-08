import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {quotaSnapshot, readQuota, loadQuota, recordQuota, quotaShort, quotaReport, windowLabel} from '../src/quota.js';

const fake = script => (executable, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => {child.killed = true;};
  const requests = [];
  child.stdin.on('data', chunk => {for (const line of String(chunk).split('\n')) if (line) requests.push(JSON.parse(line));});
  setTimeout(() => script(child, {executable, args, requests}), 5);
  return child;
};
const root = t => {const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-quota-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir;};

test('each vendor stream shape becomes the same window reading', () => {
  const claude = quotaSnapshot('claude', {type: 'rate_limit_event', rate_limit_info: {status: 'allowed',
    unifiedWindows: {five_hour: {utilization: 0.05, resetsAt: 1788832200}, seven_day: {utilization: 0.024, resetsAt: 1789279200}}}});
  assert.deepEqual(claude, {provider: 'claude', plan: null, windows: [
    {label: '5h', percent: 5, resetsAt: 1788832200000}, {label: '7d', percent: 2, resetsAt: 1789279200000}]});
  // Older Claude builds report a single window without the unified block.
  assert.deepEqual(quotaSnapshot('claude', {type: 'rate_limit_event', rate_limit_info: {rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 1788832200}}).windows,
    [{label: '5h', percent: 90, resetsAt: 1788832200000}]);
  const codex = quotaSnapshot('codex', {type: 'token_count', rate_limits: {plan_type: 'plus',
    primary: {used_percent: 91, window_minutes: 300, resets_at: 1788833024},
    secondary: {used_percent: 14, window_minutes: 10080, resets_at: 1789419824}}});
  assert.deepEqual(codex, {provider: 'codex', plan: 'plus', windows: [
    {label: '5h', percent: 91, resetsAt: 1788833024000}, {label: '7d', percent: 14, resetsAt: 1789419824000}]});
  // Anything else, including a turn with no limits attached, reports nothing.
  for (const raw of [{type: 'assistant'}, {type: 'token_count', rate_limits: null}, null, 'text'])
    assert.equal(quotaSnapshot('codex', raw), null);
  assert.equal(quotaSnapshot('muse', {payload_type: 'run.output.delta'}), null);
  assert.deepEqual(['5h', '7d', '45m', ''].map(x => x), [windowLabel(300), windowLabel(10080), windowLabel(45), windowLabel(undefined)]);
});

test('codex answers a quota question between turns; others say they cannot', async () => {
  const codex = await readQuota('codex', '/apps/codex', {spawn: fake((child, {args, requests}) => {
    assert.deepEqual(args, ['app-server']);
    assert.deepEqual(requests.map(r => r.method), ['initialize', 'initialized', 'account/rateLimits/read']);
    child.stdout.write(JSON.stringify({id: 2, result: {rateLimits: {planType: 'plus',
      primary: {usedPercent: 100, windowDurationMins: 300, resetsAt: 1788833024},
      secondary: {usedPercent: 16, windowDurationMins: 10080, resetsAt: 1789419824}}}}) + '\n');
  })});
  assert.equal(codex.error, null);
  assert.equal(codex.plan, 'plus');
  assert.deepEqual(codex.windows.map(w => `${w.label} ${w.percent}%`), ['5h 100%', '7d 16%']);

  const missing = await readQuota('codex', 'codex', {spawn: fake(child => child.emit('error', Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'})))});
  assert.deepEqual([missing.windows, missing.error], [[], 'codex CLI not installed']);
  const refused = await readQuota('codex', 'codex', {spawn: fake(child =>
    child.stdout.write(JSON.stringify({id: 2, error: {message: 'not signed in'}}) + '\n'))});
  assert.deepEqual([refused.windows, refused.error], [[], 'not signed in']);
  const claude = await readQuota('claude', 'claude', {spawn: () => assert.fail('must not spawn')});
  assert.deepEqual([claude.windows, claude.error], [[], 'claude reports quota only while a turn runs; none seen yet']);
  const muse = await readQuota('muse', 'muse', {spawn: () => assert.fail('must not spawn')});
  assert.deepEqual([muse.windows, muse.error], [[], 'muse does not report quota']);
});

test('repeat readings update the store in place and only changes reach disk', t => {
  const dir = root(t);
  const store = loadQuota(dir);
  assert.deepEqual(store, {});
  const reading = percent => ({provider: 'claude', plan: null, windows: [{label: '5h', percent, resetsAt: null}]});
  assert.equal(recordQuota(store, dir, reading(5)), true);
  assert.equal(recordQuota(store, dir, reading(5)), false);
  const written = loadQuota(dir);
  assert.equal(written.claude.windows[0].percent, 5);
  assert.equal(recordQuota(store, dir, reading(6)), true);
  assert.equal(loadQuota(dir).claude.windows[0].percent, 6);
  // A failed refresh keeps the last known usage and explains itself.
  assert.equal(recordQuota(store, dir, {provider: 'claude', windows: [], error: 'codex did not answer in time'}), true);
  assert.equal(store.claude.windows[0].percent, 6);
  assert.equal(store.claude.error, 'codex did not answer in time');
  assert.equal(recordQuota(store, dir, null), false);
});

test('quota reads as a compact header and a full report', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const store = {
    codex: {provider: 'codex', plan: 'plus', time: '2026-09-08T11:58:00Z',
      windows: [{label: '5h', percent: 100, resetsAt: now + 83 * 60000}, {label: '7d', percent: 16, resetsAt: now + 6.75 * 86400000}]},
    claude: {provider: 'claude', time: '2026-09-08T11:59:50Z', windows: [{label: '5h', percent: 5, resetsAt: null}]},
    muse: {provider: 'muse', windows: [], error: 'muse does not report quota'},
  };
  assert.equal(quotaShort(store.codex, now), '5h 100% · 7d 16%');
  assert.equal(quotaShort(store.muse), '');
  assert.equal(quotaShort(undefined), '');
  assert.deepEqual(quotaReport(store, ['codex', 'claude', 'muse'], now).split('\n'), [
    'codex · plus · 5h 100% used (resets in 1h 23m) · 7d 16% used (resets in 6d 18h) · reported 2m ago',
    'claude · 5h 5% used · reported just now',
    'muse · muse does not report quota']);
  assert.equal(quotaReport({}, ['claude'], now), 'claude · claude reports quota only while a turn runs; none seen yet');
  assert.equal(quotaReport({}, ['codex'], now), 'codex · codex reported no quota');
  // A reading whose window has already rolled over never shows its stale percentage.
  const stale = {claude: {provider: 'claude', time: '2026-09-08T04:00:00Z',
    windows: [{label: '5h', percent: 100, resetsAt: now - 60000}, {label: '7d', percent: 30, resetsAt: now + 86400000}]}};
  assert.equal(quotaShort(stale.claude, now), '5h reset · 7d 30%');
  assert.equal(quotaReport(stale, ['claude'], now),
    'claude · 5h window reset since this reading · 7d 30% used (resets in 1d 0h) · reported 8h 0m ago');
});
