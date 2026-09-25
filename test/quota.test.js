process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {quotaSnapshot, readQuota, loadQuota, recordQuota, quotaShort, quotaReport, quotaPanel, modelPanel, windowLabel, windowTitle, resetText, usageOrder, parseUsageResult, quotaFile} from '../src/quota.js';

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
    {label: '5h', percent: 5, resetsAt: 1788832200000, minutes: 300},
    {label: '7d', percent: 2, resetsAt: 1789279200000, minutes: 10080}]});
  // Older Claude builds report a single window without the unified block.
  assert.deepEqual(quotaSnapshot('claude', {type: 'rate_limit_event', rate_limit_info: {rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 1788832200}}).windows,
    [{label: '5h', percent: 90, resetsAt: 1788832200000, minutes: 300}]);
  const codex = quotaSnapshot('codex', {type: 'token_count', rate_limits: {plan_type: 'plus',
    primary: {used_percent: 91, window_minutes: 300, resets_at: 1788833024},
    secondary: {used_percent: 14, window_minutes: 10080, resets_at: 1789419824}}});
  assert.deepEqual(codex, {provider: 'codex', plan: 'plus', windows: [
    {label: '5h', percent: 91, resetsAt: 1788833024000, minutes: 300},
    {label: '7d', percent: 14, resetsAt: 1789419824000, minutes: 10080}]});
  // Anything else, including a turn with no limits attached, reports nothing.
  for (const raw of [{type: 'assistant'}, {type: 'token_count', rate_limits: null}, null, 'text'])
    assert.equal(quotaSnapshot('codex', raw), null);
  assert.equal(quotaSnapshot('muse', {payload_type: 'run.output.delta'}), null);
  assert.deepEqual(['5h', '7d', '45m', ''].map(x => x), [windowLabel(300), windowLabel(10080), windowLabel(45), windowLabel(undefined)]);
});

test('codex and claude answer a quota question between turns; muse says it cannot', async () => {
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
  // A fresh cache: this call must not see the throttle cache another test in this file wrote.
  const claude = await readQuota('claude', 'claude', {cache: new Map(), spawn: fake(child =>
    child.stdout.write(JSON.stringify({local_command: 'usage', is_error: false, result: 'nothing recognizable here'}) + '\n'))});
  assert.deepEqual([claude.windows, claude.error], [[], 'claude reported no quota']);
  const muse = await readQuota('muse', 'muse', {spawn: () => assert.fail('must not spawn')});
  assert.deepEqual([muse.windows, muse.error], [[], 'muse does not report quota']);
});

// Real capture (2026-09-25): `claude -p "/usage" --output-format json --no-session-persistence`
// answers in ~2s with num_turns 0 / total_cost_usd 0 (a local command, not a turn) and a `result`
// string whose quota lines look like this.
test('the /usage parser reads the three window shapes claude prints, with exact reset epochs', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const text = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 8% used · resets Sep 25 at 11:49am (America/Mexico_City)',
    'Current week (all models): 6% used · resets Oct 1 at 10:59pm (America/Mexico_City)',
    'Current week (Fable): 0% used · resets Oct 1 at 11pm (America/Mexico_City)',
    '',
    "What's contributing to your limits usage?",
  ].join('\n');
  assert.deepEqual(parseUsageResult(text, now), [
    {label: '5h', percent: 8, resetsAt: 1790358540000, minutes: 300},
    {label: '7d', percent: 6, resetsAt: 1790917140000, minutes: 10080},
    {label: '7d Fable', percent: 0, resetsAt: 1790917200000, minutes: 10080},
  ]);
});

test('the /usage parser rolls a December reset into next January when no year is given', () => {
  const now = Date.parse('2026-12-28T12:00:00Z');
  const windows = parseUsageResult('Current session: 50% used · resets Jan 3 at 9am (America/Mexico_City)', now);
  assert.deepEqual(windows, [{label: '5h', percent: 50, resetsAt: 1798988400000, minutes: 300}]);
  assert.equal(new Date(windows[0].resetsAt).toISOString(), '2027-01-03T15:00:00.000Z');
});

test('the /usage parser skips lines it cannot read instead of failing the whole result', () => {
  assert.deepEqual(parseUsageResult('', Date.now()), []);
  assert.deepEqual(parseUsageResult('not a quota line at all', Date.now()), []);
  assert.deepEqual(parseUsageResult('Current session: fifty% used · resets soon (nowhere)', Date.now()), []);
});

test('readQuota(claude) spawns claude -p /usage and parses its result into windows', async () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const claude = await readQuota('claude', '/apps/claude', {cache: new Map(), now, spawn: fake((child, {executable, args}) => {
    assert.equal(executable, '/apps/claude');
    assert.deepEqual(args, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence']);
    child.stdout.write(JSON.stringify({local_command: 'usage', is_error: false,
      result: 'Current session: 8% used · resets Sep 25 at 11:49am (America/Mexico_City)'}) + '\n');
  })});
  assert.equal(claude.error, null);
  assert.equal(claude.time, new Date(now).toISOString());
  assert.deepEqual(claude.windows, [{label: '5h', percent: 8, resetsAt: 1790358540000, minutes: 300}]);
});

test('readQuota(claude) reports the vendor error when is_error is set', async () => {
  const claude = await readQuota('claude', 'claude', {cache: new Map(), spawn: fake(child =>
    child.stdout.write(JSON.stringify({local_command: 'usage', is_error: true, result: 'Invalid API key'}) + '\n'))});
  assert.deepEqual([claude.windows, claude.error], [[], 'Invalid API key']);
});

test('readQuota(claude) throttles: a second call within 60s reuses the first result without spawning', async () => {
  const cache = new Map();
  const now = Date.parse('2026-09-25T12:00:00Z');
  const spawned = fake(child => child.stdout.write(JSON.stringify({local_command: 'usage', is_error: false,
    result: 'Current session: 8% used · resets Sep 25 at 11:49am (America/Mexico_City)'}) + '\n'));
  const first = await readQuota('claude', 'claude', {cache, now, spawn: spawned});
  const second = await readQuota('claude', 'claude', {cache, now: now + 30000, spawn: () => assert.fail('must not spawn again within 60s')});
  assert.deepEqual(second, first);
  const third = await readQuota('claude', 'claude', {cache, now: now + 61000, spawn: fake(child =>
    child.stdout.write(JSON.stringify({local_command: 'usage', is_error: false,
      result: 'Current session: 9% used · resets Sep 25 at 11:49am (America/Mexico_City)'}) + '\n'))});
  assert.equal(third.windows[0].percent, 9);
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

test('an unchanged reading still bumps time on disk once the stored time goes stale', t => {
  const dir = root(t);
  const store = loadQuota(dir);
  const reading = time => ({provider: 'claude', plan: null, time, windows: [{label: '5h', percent: 5, resetsAt: null}]});
  assert.equal(recordQuota(store, dir, reading('2026-09-25T07:00:00Z')), true);
  assert.equal(loadQuota(dir).claude.time, '2026-09-25T07:00:00Z');
  // 30s later: unchanged numbers, stored time still fresh -> no write, no redraw.
  assert.equal(recordQuota(store, dir, reading('2026-09-25T07:00:30Z')), false);
  assert.equal(loadQuota(dir).claude.time, '2026-09-25T07:00:00Z');
  // 61s after the ORIGINAL stored time: same numbers, but the stored time is now stale -> the
  // sidebar's age marker would change, so this writes and asks for a redraw.
  assert.equal(recordQuota(store, dir, reading('2026-09-25T07:01:01Z')), true);
  assert.equal(loadQuota(dir).claude.time, '2026-09-25T07:01:01Z');
});

test('recordQuota merges with disk before writing, so a fresher reading for another provider is never lost', t => {
  const dir = root(t);
  const store = loadQuota(dir);
  // One process already holds an older codex reading in memory...
  assert.equal(recordQuota(store, dir, {provider: 'codex', time: '2026-09-25T07:00:00Z', windows: [{label: '5h', percent: 10, resetsAt: null}]}), true);
  // ...while a DIFFERENT process wrote a newer codex reading straight to disk in the meantime.
  const disk = loadQuota(dir);
  disk.codex = {provider: 'codex', time: '2026-09-25T07:05:00Z', windows: [{label: '5h', percent: 20, resetsAt: null}]};
  fs.writeFileSync(quotaFile(dir), JSON.stringify(disk));
  // This call's own reading is for claude, unrelated to codex.
  assert.equal(recordQuota(store, dir, {provider: 'claude', time: '2026-09-25T07:06:00Z', windows: [{label: '5h', percent: 1, resetsAt: null}]}), true);
  const merged = loadQuota(dir);
  // codex kept the newer of the two (disk's 20%, not this process's stale 10%)...
  assert.equal(merged.codex.windows[0].percent, 20);
  assert.equal(merged.codex.time, '2026-09-25T07:05:00Z');
  // ...and claude, this call's own provider, is always written as given.
  assert.equal(merged.claude.windows[0].percent, 1);
  // The in-memory store was refreshed with the newer codex entry too, not just the file.
  assert.equal(store.codex.time, '2026-09-25T07:05:00Z');
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
  assert.equal(quotaReport({}, ['claude'], now), 'claude · claude reported no quota');
  assert.equal(quotaReport({}, ['codex'], now), 'codex · codex reported no quota');
  // A reading whose window has already rolled over never shows its stale percentage.
  const stale = {claude: {provider: 'claude', time: '2026-09-08T04:00:00Z',
    windows: [{label: '5h', percent: 100, resetsAt: now - 60000}, {label: '7d', percent: 30, resetsAt: now + 86400000}]}};
  assert.equal(quotaShort(stale.claude, now), '5h reset · 7d 30%');
  assert.equal(quotaReport(stale, ['claude'], now),
    'claude · 5h window reset since this reading · 7d 30% used (resets in 1d 0h) · reported 8h 0m ago');
});

test('the sidebar panel draws each window as a bar with its reset time and pace tick', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const store = {
    claude: {provider: 'claude', plan: null, time: '2026-09-08T12:00:00Z', windows: [
      {label: '5h', percent: 40, resetsAt: now + 180 * 60000, minutes: 300},
      {label: '7d', percent: 15, resetsAt: now + 4 * 86400000, minutes: 10080}]},
    codex: {provider: 'codex', plan: 'plus', time: '2026-09-08T12:00:00Z', windows: [
      {label: '5h', percent: 100, resetsAt: now + 60 * 60000, minutes: 300}]},
    muse: {provider: 'muse', windows: [], error: 'muse does not report quota'},
  };
  const panel = quotaPanel(store, ['claude', 'codex', 'muse'], {width: 30, now});
  assert.deepEqual(panel, [
    'CLAUDE',
    // Two of the five hours have run and 40% is spent, so fill and tick meet at cell 12.
    '5-hour limit resets 3:00pm 40%',
    '■'.repeat(12) + '│' + '□'.repeat(17),
    // Half the week has run against 15% spent, so the tick sits well ahead of the fill.
    'Weekly limit         4d 0h 15%',
    '■'.repeat(5) + '□'.repeat(8) + '│' + '□'.repeat(16),
    // Each provider is its own group, separated by a blank row.
    '',
    'CODEX · Plus',
    // A full window keeps its reset time by dropping the word that no longer fits.
    '5-hour limit       1:00pm 100%',
    '■'.repeat(24) + '│' + '■'.repeat(5),
    '',
    'MUSE',
    'muse does not report quota',
  ]);
  for (const row of panel) assert.ok(row.length <= 30, `row too wide: ${row}`);
  // A window with no length reported draws no tick, and one already past its reset says so.
  assert.deepEqual(quotaPanel({claude: {windows: [{label: '5h', percent: 50, resetsAt: null, minutes: null}]}}, ['claude'], {width: 10, now}),
    ['CLAUDE', '5-hour limit 50%', '■■■■■□□□□□']);
  assert.deepEqual(quotaPanel({claude: {windows: [{label: '5h', percent: 90, resetsAt: now - 1, minutes: 300}]}}, ['claude'], {width: 20, now}),
    ['CLAUDE', '5-hour limit   reset']);
  // A cooldown is named beside the provider, not buried in the window rows.
  assert.equal(quotaPanel(store, ['muse'], {width: 30, now, cooldowns: {muse: now + 1000}})[0], 'MUSE · cooldown');
});

// Found live (2026-09-25): /quota already says "reported 1h 35m ago", but the sidebar's own
// row for the same stale reading showed a bare "1%" with no hint it was over an hour old.
test('a stale reading gets a compact age marker in the sidebar row; a fresh one does not', () => {
  const now = Date.parse('2026-09-25T08:00:00Z');
  const store = {
    claude: {provider: 'claude', time: '2026-09-25T06:25:00Z', windows: [
      {label: '5h', percent: 40, resetsAt: now - 60000, minutes: 300},
      {label: '7d', percent: 1, resetsAt: now + 6 * 86400000 + 72 * 60000, minutes: 10080}]},
    codex: {provider: 'codex', plan: 'prolite', time: '2026-09-25T07:59:30Z', windows: [
      {label: '7d', percent: 78, resetsAt: now + 2 * 86400000 + 63 * 60000, minutes: 10080}]},
  };
  const panel = quotaPanel(store, ['claude', 'codex'], {width: 30, now});
  // The 5h window already reset since the reading, so it stays a plain "reset" — no percent, no age.
  assert.equal(panel[0], 'CLAUDE');
  assert.match(panel[1], /^5-hour limit\s+reset$/);
  // The 7d window's own reading is 1h35m old: the percent gets a compact age marker.
  assert.match(panel[2], /^Weekly limit.*1% · 1h ago$/);
  // Codex's reading is 30s old — no marker.
  const codexHead = panel.find(row => row.startsWith('Weekly limit') && row.includes('78%'));
  assert.doesNotMatch(codexHead, / ago$/);
  for (const row of panel) assert.ok(row.length <= 30, `row too wide: ${row}`);
});

test('the panel gives up bars, then lines, as the sidebar runs out of rows', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const store = {codex: {provider: 'codex', plan: 'plus', windows: [
    {label: '5h', percent: 100, resetsAt: now + 60 * 60000, minutes: 300},
    {label: '7d', percent: 34, resetsAt: now + 3 * 86400000, minutes: 10080}]}};
  const rows = budget => quotaPanel(store, ['codex'], {width: 30, now, rows: budget});
  assert.equal(rows(Infinity).length, 5);
  assert.deepEqual(rows(3), ['CODEX · Plus', '5-hour limit       1:00pm 100%', 'Weekly limit         3d 0h 34%']);
  assert.deepEqual(rows(2), ['CODEX · Plus', '5h 100% · 7d 34%']);
  // Below even the compact form, the panel is cut rather than allowed to push the recap out.
  assert.deepEqual(rows(1), ['CODEX · Plus']);
  // The gap between providers costs a row while there is room; the compact form drops it.
  const two = budget => quotaPanel({...store, claude: store.codex}, ['claude', 'codex'], {width: 30, now, rows: budget});
  assert.equal(two(Infinity).length, 11);
  assert.deepEqual(two(7).map(row => row === '' ? 'gap' : row.split(' ')[0]), ['CLAUDE', '5-hour', 'Weekly', 'gap', 'CODEX', '5-hour', 'Weekly']);
  assert.deepEqual(two(6).map(row => row === '' ? 'gap' : row.split(' ')[0]), ['CLAUDE', '5h', 'CODEX', '5h']);
});

test('window titles and reset text read the way a plan states them', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  assert.deepEqual(['5h', '7d', '1d', '1h', '45m', 'fable weekly'].map(windowTitle),
    ['5-hour limit', 'Weekly limit', 'Daily limit', 'Hourly limit', '45m limit', 'Fable weekly limit']);
  // Past a day the distance is the only unambiguous form; inside one, the wall clock is quicker.
  assert.equal(resetText({resetsAt: now + 6.75 * 86400000}, now), 'resets in 6d 18h');
  assert.match(resetText({resetsAt: now + 90 * 60000}, now), /^resets \d{1,2}:\d{2}(am|pm)$/);
  assert.equal(resetText({resetsAt: null}, now), '');
  assert.equal(resetText({resetsAt: now - 1}, now), '');
});

test('modelPanel: ranked entries each get a labelled row and a bar sized against the top spender', () => {
  const entries = [
    {model: 'claude-opus-5[1m]', provider: 'claude', tokens: 762000, usage: {}, turns: 1},
    {model: 'gpt-5-codex', provider: 'codex', tokens: 381000, usage: {}, turns: 1},
    {model: 'sonnet', provider: null, tokens: 42000, usage: {}, turns: 1},
  ];
  const panel = modelPanel(entries, {width: 28});
  assert.deepEqual(panel, [
    'MODELS',
    'claude-opus-5[1m]       762k',
    '■'.repeat(28),
    'gpt-5-codex             381k',
    // Half the top spender's tokens: half the bar, rounded to the nearest cell.
    '■'.repeat(14) + '□'.repeat(14),
    'sonnet                   42k',
    '■'.repeat(2) + '□'.repeat(26),
  ]);
  for (const row of panel) assert.ok(row.length <= 28, `row too wide: ${row}`);
});

test('modelPanel: no usage yet hides the section entirely, rather than a placeholder', () => {
  assert.deepEqual(modelPanel([], {width: 28}), []);
  assert.deepEqual(modelPanel(undefined, {width: 28}), []);
});

test('modelPanel: a name too long for the width is truncated, the count always stays on the right', () => {
  const entries = [{model: 'super-duper-extremely-long-model-name-v3', provider: 'claude', tokens: 1234567, usage: {}, turns: 1}];
  const panel = modelPanel(entries, {width: 28});
  assert.equal(panel[1], 'super-duper-extremely-… 1.2M');
  assert.equal(panel[1].length, 28);
});

test('modelPanel gives up bars, then per-model lines, then one compact line, as the sidebar runs out of rows', () => {
  const entries = [
    {model: 'claude-opus-5', provider: 'claude', tokens: 762000, usage: {}, turns: 1},
    {model: 'gpt-5-codex', provider: 'codex', tokens: 84000, usage: {}, turns: 1},
  ];
  const rows = budget => modelPanel(entries, {width: 28, rows: budget});
  assert.equal(rows(Infinity).length, 5); // title + 2 * (label + bar)
  assert.deepEqual(rows(3), ['MODELS', 'claude-opus-5           762k', 'gpt-5-codex              84k']);
  assert.deepEqual(rows(2), ['MODELS', 'claude-opus-5 762k · gpt-5-codex 84k']);
  // A title with nothing under it says nothing: hidden below a 2-row budget, same as no usage.
  assert.deepEqual(rows(1), []);
});

test('modelPanel: below a 2-row budget the section hides entirely rather than showing a bare title', () => {
  const entries = [{model: 'x', provider: null, tokens: 10, usage: {}, turns: 1}];
  assert.deepEqual(modelPanel(entries, {rows: 1}), []);
  const panel = modelPanel(entries, {rows: 2});
  assert.equal(panel.length, 2);
  assert.equal(panel[0], 'MODELS');
});

test('usageOrder: the fallback order first, then every profile adapter, deduped, quota-reporting vendors only', () => {
  const profiles = {main: {adapter: 'claude'}, build: {adapter: 'codex'}, critic: {adapter: 'claude'}, local: {adapter: 'opencode'}};
  assert.deepEqual(usageOrder(['claude'], profiles, ['claude', 'codex', 'muse']), ['claude', 'codex']);
  assert.deepEqual(usageOrder(['codex', 'claude'], {}, ['claude', 'codex', 'muse']), ['codex', 'claude']);
  assert.deepEqual(usageOrder(['muse'], profiles, ['claude', 'codex', 'muse']), ['muse', 'claude', 'codex']);
  assert.deepEqual(usageOrder([], {}, ['claude']), []);
});
