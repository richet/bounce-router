import fs from 'node:fs';
import path from 'node:path';
import {queryLines} from './query.js';
import {resolveExecutable} from './executable.js';
import {saveJSON} from './core.js';

// Quota is whatever the vendor CLI states about its own subscription windows.
// Nothing here estimates remaining quota, and an agent that reports none says so.
// A window carries its own length so the sidebar can mark how much of its clock has run.
const makeWindow = (label, used, resetsAt, minutes) => ({label, percent: Math.max(0, Math.round(Number(used) || 0)),
  resetsAt: Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
  minutes: minutes === undefined || minutes === null || !Number.isFinite(Number(minutes)) ? null : Number(minutes)});
const pick = (value, ...names) => {for (const name of names) if (value?.[name] !== undefined && value?.[name] !== null) return value[name];};
export const windowLabel = minutes => !Number.isFinite(minutes) ? ''
  : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
// Claude names its windows; Codex gives their length. Both reach the same label.
const claudeLabels = {five_hour: '5h', seven_day: '7d'};
const claudeMinutes = {five_hour: 300, seven_day: 10080};
const codexWindows = limits => ['primary', 'secondary'].flatMap(key => {
  const w = limits?.[key];
  if (!w) return [];
  const minutes = pick(w, 'windowDurationMins', 'window_minutes');
  return [makeWindow(windowLabel(minutes) || key,
    pick(w, 'usedPercent', 'used_percent'), pick(w, 'resetsAt', 'resets_at'), minutes)];
});

// A live stream event carrying quota, or null. During a turn this is Claude's only quota
// source; readQuota below covers the gap between turns with a one-shot `/usage` query.
export function quotaSnapshot(provider, raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (provider === 'claude' && raw.type === 'rate_limit_event') {
    const info = raw.rate_limit_info ?? {};
    const windows = Object.entries(info.unifiedWindows ?? {})
      .map(([key, w]) => makeWindow(claudeLabels[key] ?? key.replace(/_/g, ' '), (w.utilization ?? 0) * 100, w.resetsAt,
        pick(w, 'windowDurationMins', 'window_minutes') ?? claudeMinutes[key]));
    if (!windows.length && Number.isFinite(info.utilization)) {
      windows.push(makeWindow(claudeLabels[info.rateLimitType] ?? info.rateLimitType ?? 'limit', info.utilization * 100, info.resetsAt,
        claudeMinutes[info.rateLimitType]));
    }
    return windows.length ? {provider, windows, plan: null} : null;
  }
  const payload = raw.payload ?? raw;
  if (provider === 'codex' && payload.type === 'token_count') {
    const limits = payload.rate_limits ?? payload.rateLimits;
    const windows = codexWindows(limits);
    return windows.length ? {provider, windows, plan: pick(limits, 'planType', 'plan_type') ?? null} : null;
  }
  return null;
}

// --- Claude's between-turn /usage query -----------------------------------
// `claude -p "/usage" --output-format json` is a LOCAL command (zero cost/tokens) whose `result`
// string is prose, e.g. "Current session: 8% used · resets Sep 25 at 11:49am (America/Mexico_City)".
const USAGE_LINE = /^Current (session|week)(?: \(([^)]+)\))?: (\d+(?:\.\d+)?)% used · resets (\w+) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/;
const MONTHS = {Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11};
// Given a wall-clock reading in an IANA zone, its UTC epoch — no year, so month/day/hour/minute
// only. The double-format trick (no new deps): format a UTC guess back in the target zone, the
// gap between the two is the zone's offset at that instant.
function zonedEpoch(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month, day, hour, minute);
  const dtf = new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
  const parts = dtf.formatToParts(new Date(guess)).reduce((acc, p) => {acc[p.type] = p.value; return acc;}, {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return guess - (asUTC - guess);
}
// No year on the line: the next occurrence at/after now, rolling into next year across December.
function nextReset(month, day, hour, minute, timeZone, now) {
  const year = Number(new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric'}).format(now));
  const epoch = zonedEpoch(year, month, day, hour, minute, timeZone);
  return epoch >= now ? epoch : zonedEpoch(year + 1, month, day, hour, minute, timeZone);
}
// One line -> one window, or null if the line isn't a quota line at all (skip, don't fail the read).
function parseUsageLine(line, now) {
  const m = USAGE_LINE.exec(line.trim());
  if (!m) return null;
  const [, kind, paren, percent, monStr, dayStr, hourStr, minStr, ampm, tz] = m;
  if (!(monStr in MONTHS)) return null;
  const hour = (Number(hourStr) % 12) + (ampm === 'pm' ? 12 : 0);
  const resetsAt = nextReset(MONTHS[monStr], Number(dayStr), hour, minStr ? Number(minStr) : 0, tz, now);
  // "session" is the 5-hour window rate_limit_event also reports; "week (all models)" is the
  // 7-day window; a named model's week has no rate_limit_event counterpart, so it gets a plain
  // `7d <Model>` label — consistent with the 7d label, distinguished by the model it names.
  const label = kind === 'session' ? claudeLabels.five_hour
    : !paren || paren === 'all models' ? claudeLabels.seven_day : `${claudeLabels.seven_day} ${paren}`;
  const minutes = kind === 'session' ? claudeMinutes.five_hour : claudeMinutes.seven_day;
  return makeWindow(label, percent, resetsAt / 1000, minutes);
}
export function parseUsageResult(text, now) {
  return String(text ?? '').split('\n').map(line => parseUsageLine(line, now)).filter(Boolean);
}

// Agents that answer a quota question between turns do it over their own protocol.
export const quotaQueries = {
  codex: {
    args: ['app-server'],
    requests: [
      {id: 1, method: 'initialize', params: {clientInfo: {name: 'bounce', version: '0.1.0'}}},
      {method: 'initialized'},
      {id: 2, method: 'account/rateLimits/read', params: {}},
    ],
    read(raw, out) {
      if (raw.id !== 2) return false;
      if (raw.error) { out.error = raw.error.message; return true; }
      const limits = raw.result?.rateLimits ?? raw.result;
      out.windows = codexWindows(limits);
      out.plan = pick(limits, 'planType', 'plan_type') ?? null;
      return true;
    },
  },
  claude: {
    // --no-session-persistence: a print-mode /usage call would otherwise show up in the user's
    // own `claude --resume` history for no reason — this is bounce polling, not a conversation.
    args: ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
    requests: [],
    throttleMs: 60000, // at most one /usage spawn per process per minute
    read(raw, out, now) {
      if (raw?.local_command !== 'usage') return false;
      if (raw.is_error) { out.error = typeof raw.result === 'string' && raw.result ? raw.result : 'claude usage query failed'; return true; }
      const windows = parseUsageResult(raw.result, now);
      if (!windows.length) { out.error = 'claude reported no quota'; return true; }
      out.windows = windows;
      out.plan = null;
      return true;
    },
  },
};
export const quotaUnavailable = provider => quotaQueries[provider] ? `${provider} reported no quota`
  : `${provider} does not report quota`;
// One /usage spawn per provider per throttle window; readings a fraction of a second apart
// (a redraw storm) reuse the last result. `cache` defaults to module-level so real callers share it; tests override it.
const throttled = new Map();
export async function readQuota(provider, executable = provider, {spawn, timeout = 15000, cwd, now = Date.now(), cache = throttled} = {}) {
  const query = quotaQueries[provider];
  const time = new Date(now).toISOString();
  if (!query) return {provider, windows: [], plan: null, time, error: quotaUnavailable(provider)};
  if (query.throttleMs) {
    const cached = cache.get(provider);
    if (cached && now - cached.at < query.throttleMs) return cached.result;
  }
  const {out, error} = await queryLines({executable, args: query.args, requests: query.requests, read: (raw, o) => query.read(raw, o, now),
    spawn, timeout, cwd, messages: {missing: `${provider} CLI not installed`, timeout: `${provider} did not answer in time`,
      closed: `${provider} exited before reporting quota`}});
  const result = {provider, windows: out.windows ?? [], plan: out.plan ?? null, time,
    error: out.windows?.length ? null : out.error || error || `${provider} reported no quota`};
  if (query.throttleMs) cache.set(provider, {at: now, result});
  return result;
}

export const quotaFile = root => path.join(root, 'quota.json');
export function loadQuota(root) {
  try { return JSON.parse(fs.readFileSync(quotaFile(root), 'utf8')); } catch { return {}; }
}
// A reading unchanged for this long still gets its `time` bumped to now, so the sidebar's age
// marker (compactAge, STALE_READING_MS) never falls more than this far behind the true age of
// the last real read.
const TIME_REFRESH_MS = 60000;
// Only a changed (or gone-stale) reading is written to disk, and a write merges with disk first
// so another process's fresher reading for a different provider is never overwritten.
export function recordQuota(store, root, snapshot) {
  if (!snapshot?.provider) return false;
  const previous = store[snapshot.provider];
  const time = snapshot.time ?? new Date().toISOString();
  const value = snapshot.windows?.length ? {...snapshot, time, error: snapshot.error ?? null}
    : previous ? {...previous, error: snapshot.error ?? null} : {...snapshot, windows: [], time};
  const same = previous && JSON.stringify({...previous, time: 0}) === JSON.stringify({...value, time: 0});
  // The in-memory store always carries the newest time this process has seen, whether or not it
  // gets written — that already kept this process's own view fresh. What "went stale" per the
  // complaint was the DISK copy: staleness below is judged against it, not the in-memory value,
  // or a process polling on a steady cadence would never see its own previous write as stale.
  store[snapshot.provider] = {...value, time};
  if (!root) return !same;
  const disk = loadQuota(root);
  const staleOnDisk = !disk[snapshot.provider]?.time || Date.parse(time) - Date.parse(disk[snapshot.provider].time) >= TIME_REFRESH_MS;
  if (same && !staleOnDisk) return false;
  for (const [provider, entry] of Object.entries(disk)) {
    if (provider === snapshot.provider) continue; // this call's own provider is always the freshest
    if (!store[provider] || Date.parse(entry.time ?? 0) > Date.parse(store[provider].time ?? 0)) store[provider] = entry;
  }
  saveJSON(quotaFile(root), store);
  return true;
}
// Which vendors the usage panel shows: the fallback order, plus — in orchestrator mode — every
// adapter a profile runs on (the workers' vendors are where the quota actually goes), in that
// order, deduped, only vendors that report quota. Pure.
export function usageOrder(order = [], profiles = {}, known = Object.keys(quotaQueries)) {
  const adapters = Object.values(profiles ?? {}).map(p => p?.adapter).filter(Boolean);
  return [...new Set([...order, ...adapters])].filter(p => known.includes(p));
}

export async function refreshQuota(settings, {root, store = loadQuota(root), ...options} = {}) {
  const results = await Promise.all(Object.keys(quotaQueries)
    .map(provider => readQuota(provider, resolveExecutable(provider, settings.executables?.[provider]), options)));
  for (const result of results) recordQuota(store, root, result);
  return store;
}

const duration = ms => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};
const since = (time, now) => {
  const age = now - Date.parse(time);
  return !Number.isFinite(age) ? 'unknown' : age < 45000 ? 'just now' : `${duration(age)} ago`;
};
// A window that has since reset makes its percentage obsolete: say so, never show it.
const expired = (w, now) => w.resetsAt !== null && w.resetsAt <= now;
// A reading older than this is worth flagging beside its percentage — /quota already says
// "reported 1h 35m ago"; the sidebar row showed the same stale number with no hint of its age.
const STALE_READING_MS = 30 * 60000;
// Single-unit form ("1h ago", not "1h 35m ago"): the sidebar row has no room for the long form.
const compactAge = (time, now) => {
  const age = now - Date.parse(time);
  if (!Number.isFinite(age)) return null;
  if (age < STALE_READING_MS) return null;
  const minutes = Math.round(age / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};
// Header form: short enough to sit beside the fallback order.
export const quotaShort = (entry, now = Date.now()) => (entry?.windows ?? [])
  .map(w => expired(w, now) ? `${w.label} reset` : `${w.label} ${w.percent}%`).join(' · ');
export function quotaReport(store, order, now = Date.now()) {
  return order.map(provider => {
    const entry = store[provider];
    if (!entry?.windows?.length) return `${provider} · ${entry?.error ?? quotaUnavailable(provider)}`;
    const windows = entry.windows.map(w => expired(w, now) ? `${windowTitle(w.label)} ended since this reading (was ${w.percent}% used)`
      : `${windowTitle(w.label)} ${w.percent}% used${w.resetsAt ? ` (resets in ${duration(w.resetsAt - now)})` : ''}`);
    return [provider, entry.plan, ...windows, `reported ${since(entry.time, now)}`, entry.error].filter(Boolean).join(' · ');
  }).join('\n') + '\nThese are the plan\'s own windows, used by every session and app on the account, not this session alone.';
}

// --- Sidebar panel -------------------------------------------------------
// A window is named in words (Daniel, 2026-10-01: "if the bars to the right can't be understood they are
// not useful"): the span it covers, and for a per-model window, which model. The percentage is "used".
const windowTitles = {'1h': 'Hourly window', '5h': '5-hour window', '1d': 'Daily window', '7d': 'Weekly'};
export const windowTitle = label => {
  const text = String(label);
  if (windowTitles[text]) return windowTitles[text];
  const match = /^(1h|5h|1d|7d)\s+(.+)$/.exec(text);
  if (match) return `${windowTitles[match[1]]}, ${match[2]} only`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} window`;
};
// Within a day the wall clock is the quickest read; a weekly window needs the distance instead.
const clock = ms => new Date(ms).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'})
  .replace(/\s+/g, '').toLowerCase();
// Longest form first: the bare time still answers "when" once "resets" no longer fits.
export const resetForms = (w, now = Date.now()) => !Number.isFinite(w?.resetsAt) || w.resetsAt <= now ? []
  : w.resetsAt - now > 86400000 ? [`resets in ${duration(w.resetsAt - now)}`, duration(w.resetsAt - now)]
  : [`resets ${clock(w.resetsAt)}`, clock(w.resetsAt)];
export const resetText = (w, now = Date.now()) => resetForms(w, now)[0] ?? '';
const planTitle = plan => String(plan).replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase());

const BAR = {used: '■', free: '□', tick: '│'};
// Fill is quota spent; the tick is how much of the window's own clock has run. Fill
// running ahead of the tick is the sidebar saying this window will not last the window.
// The bar is the share of the window used, nothing else: the clock tick it used to carry (how far the
// window had run) read as a mystery mark. When it resets rides on the bar's row, in words.
export function quotaBar(w, width, now, paint) {
  const reset = resetText(w, now);
  const cells = Math.max(4, reset ? width - reset.length - 1 : width);
  const fill = Math.min(cells, Math.round(Math.min(w.percent, 100) / 100 * cells));
  const tone = w.percent >= 100 ? paint.high : w.percent >= 80 ? paint.warn : paint.ok;
  const bar = tone(BAR.used.repeat(fill)) + paint.muted(BAR.free.repeat(cells - fill));
  return reset ? `${bar} ${paint.muted(reset)}` : bar;
}
// Title left, reset time beside the percentage on the right; the reset drops first when
// the sidebar is too narrow to hold all three.
const panelRow = (left, middles, right, width, p) => {
  const room = width - left.length - right.length;
  const middle = middles.find(m => room >= m.length + 2);
  return middle
    ? p.text(left) + ' '.repeat(room - middle.length - 1) + p.muted(middle) + ' ' + p.text(right)
    : p.text(left) + ' '.repeat(Math.max(1, room)) + p.text(right);
};
const noPaint = {title: s => s, text: s => s, muted: s => s, ok: s => s, warn: s => s, high: s => s, tick: s => s};
// One titled group per provider, each window a labelled bar. Detail steps down from bars
// to plain lines to a single summary line as the sidebar runs out of rows to give it.
export function quotaPanel(store, order, {width = 30, now = Date.now(), rows = Infinity, cooldowns = {}, paint} = {}) {
  const p = {...noPaint, ...paint};
  const head = provider => {
    const entry = store[provider];
    return p.title([provider.toUpperCase(), entry?.plan ? planTitle(entry.plan) : null].filter(Boolean).join(' · '))
      + (cooldowns[provider] > now ? p.muted(' · cooldown') : '');
  };
  // Title left, "N% used" right; with bars, the bar row carries the reset. An ended window keeps the last
  // number it had instead of hiding it; a stale reading says how old it is.
  const line = (w, detail, readingTime) => {
    const title = windowTitle(w.label);
    if (expired(w, now)) return [panelRow(title, [], 'ended', width, p), p.muted(`${w.percent}% used before it ended`)];
    const age = readingTime != null ? compactAge(readingTime, now) : null;
    const used = `${w.percent}% used`;
    if (detail === 'bars') return [panelRow(title, age ? [`read ${age}`] : [], used, width, p), quotaBar(w, width, now, p)];
    return [panelRow(title, [...resetForms(w, now), ...(age ? [`read ${age}`] : [])], used, width, p)];
  };
  const build = detail => order.flatMap((provider, index) => {
    const entry = store[provider];
    const windows = entry?.windows ?? [];
    // Providers read as separate groups while there is room; the compact form stays dense.
    const gap = index && detail !== 'compact' ? [''] : [];
    if (!windows.length) return [...gap, head(provider), p.muted(entry?.error ?? quotaUnavailable(provider))];
    if (detail === 'compact') return [head(provider), p.muted(quotaShort(entry, now))];
    return [...gap, head(provider), ...windows.flatMap(w => line(w, detail, entry.time))];
  });
  // One line says what every number below is, once (Daniel, 2026-10-01).
  // Daniel, 2026-10-01: these are the vendor's windows for the whole subscription — every session and app —
  // not this session's; the legend says so, and TOKENS below is the one block that is per session.
  const legend = p.muted('QUOTA · of your whole plan');
  let built = [];
  for (const detail of ['bars', 'lines', 'compact']) {
    built = detail === 'compact' ? build(detail) : [legend, ...build(detail)];
    if (built.length <= rows) return built;
  }
  return built.slice(0, Math.max(0, rows));
}

// --- Model usage panel ---------------------------------------------------
// A count reads at a glance only once it stops being an exact integer: 1.2M, not 1234567.
const trimZero = s => s.replace(/\.0$/, '');
const compactTokens = n => !Number.isFinite(n) || n <= 0 ? '0'
  : n >= 1e6 ? `${trimZero((n / 1e6).toFixed(1))}M` : n >= 1e3 ? `${trimZero((n / 1e3).toFixed(1))}k` : `${Math.round(n)}`;
// Name left, count right; the name gives way first since the count is what ranks the row.
const modelLabelRow = (name, count, width, p) => {
  const room = Math.max(1, width - count.length - 1);
  const label = name.length > room ? `${name.slice(0, Math.max(1, room - 1))}…` : name;
  return p.text(label) + ' '.repeat(Math.max(1, width - label.length - count.length)) + p.text(count);
};
const modelBar = (fraction, width, p) => {
  const cells = Math.max(4, width);
  const fill = Math.min(cells, Math.round(Math.max(0, Math.min(1, fraction)) * cells));
  return p.ok(BAR.used.repeat(fill)) + p.muted(BAR.free.repeat(cells - fill));
};
// Ranked by reducers.modelUsage, so entries[0] is already the top spender: its bar is always
// full and every other bar reads as a share of it. No usage yet means nothing to rank — hidden,
// not a placeholder. Same bars -> lines -> compact degradation as quotaPanel, for the same reason.
// In and out apart (Daniel, 2026-10-02): what a model read (input, cache reads included) and what it wrote
// are two quantities — output is a fraction of a percent of input — so each gets its own bar, scaled against
// the model that read or wrote the most, and the label row carries both counts.
const inOf = e => (e.usage?.input ?? 0) + (e.usage?.cache_read ?? 0) || (e.tokens ?? 0);
const outOf = e => e.usage?.output ?? 0;
const taggedBar = (fraction, width, tag, p) => { const cells = Math.max(4, width - tag.length - 1); const fill = Math.min(cells, Math.round(Math.max(0, Math.min(1, fraction)) * cells)); return `${p.ok(BAR.used.repeat(fill))}${p.muted(BAR.free.repeat(cells - fill))} ${p.muted(tag)}`; };
export function modelPanel(entries, {width = 28, rows = Infinity, paint} = {}) {
  const p = {...noPaint, ...paint};
  // Fewer than a title plus one line can't say anything: hidden, same as no usage at all.
  if (!entries?.length || rows < 2) return [];
  const topIn = Math.max(1, ...entries.map(inOf)), topOut = Math.max(1, ...entries.map(outOf));
  const build = detail => {
    const title = p.title('TOKENS · session · in | out');
    if (detail === 'compact') return [title, p.muted(entries.map(e => `${e.model} ${compactTokens(inOf(e))}|${compactTokens(outOf(e))}`).join(' · '))];
    return [title, ...entries.flatMap(e => {
      const head = modelLabelRow(e.model, `${compactTokens(inOf(e))} in · ${compactTokens(outOf(e))} out`, width, p);
      return detail === 'bars' ? [head, taggedBar(inOf(e) / topIn, width, 'in', p), taggedBar(outOf(e) / topOut, width, 'out', p)] : [head];
    })];
  };
  let built = [];
  for (const detail of ['bars', 'lines', 'compact']) {
    built = build(detail);
    if (built.length <= rows) return built;
  }
  return built.slice(0, Math.max(0, rows));
}
