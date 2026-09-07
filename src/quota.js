import fs from 'node:fs';
import path from 'node:path';
import {queryLines} from './query.js';
import {resolveExecutable} from './executable.js';
import {saveJSON} from './core.js';

// Quota is whatever the vendor CLI states about its own subscription windows.
// Nothing here estimates remaining quota, and an agent that reports none says so.
const makeWindow = (label, used, resetsAt) => ({label, percent: Math.max(0, Math.round(Number(used) || 0)),
  resetsAt: Number.isFinite(resetsAt) ? resetsAt * 1000 : null});
const pick = (value, ...names) => {for (const name of names) if (value?.[name] !== undefined && value?.[name] !== null) return value[name];};
export const windowLabel = minutes => !Number.isFinite(minutes) ? ''
  : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
// Claude names its windows; Codex gives their length. Both reach the same label.
const claudeLabels = {five_hour: '5h', seven_day: '7d'};
const codexWindows = limits => ['primary', 'secondary'].flatMap(key => {
  const w = limits?.[key];
  if (!w) return [];
  return [makeWindow(windowLabel(pick(w, 'windowDurationMins', 'window_minutes')) || key,
    pick(w, 'usedPercent', 'used_percent'), pick(w, 'resetsAt', 'resets_at'))];
});

// A live stream event carrying quota, or null. Claude reports quota only this way.
export function quotaSnapshot(provider, raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (provider === 'claude' && raw.type === 'rate_limit_event') {
    const info = raw.rate_limit_info ?? {};
    const windows = Object.entries(info.unifiedWindows ?? {})
      .map(([key, w]) => makeWindow(claudeLabels[key] ?? key.replace(/_/g, ' '), (w.utilization ?? 0) * 100, w.resetsAt));
    if (!windows.length && Number.isFinite(info.utilization)) {
      windows.push(makeWindow(claudeLabels[info.rateLimitType] ?? info.rateLimitType ?? 'limit', info.utilization * 100, info.resetsAt));
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
};
// Where a reading can come from: Codex answers between turns, Claude reports its
// windows only while a turn runs, and Muse's protocol carries no quota at all.
const streamsQuota = new Set(['claude', 'codex']);
export const quotaUnavailable = provider => quotaQueries[provider] ? `${provider} reported no quota`
  : streamsQuota.has(provider) ? `${provider} reports quota only while a turn runs; none seen yet`
  : `${provider} does not report quota`;
export async function readQuota(provider, executable = provider, {spawn, timeout = 15000, cwd} = {}) {
  const query = quotaQueries[provider];
  const time = new Date().toISOString();
  if (!query) return {provider, windows: [], plan: null, time, error: quotaUnavailable(provider)};
  const {out, error} = await queryLines({executable, args: query.args, requests: query.requests, read: query.read,
    spawn, timeout, cwd, messages: {missing: `${provider} CLI not installed`, timeout: `${provider} did not answer in time`,
      closed: `${provider} exited before reporting quota`}});
  return {provider, windows: out.windows ?? [], plan: out.plan ?? null, time,
    error: out.windows?.length ? null : out.error || error || `${provider} reported no quota`};
}

export const quotaFile = root => path.join(root, 'quota.json');
export function loadQuota(root) {
  try { return JSON.parse(fs.readFileSync(quotaFile(root), 'utf8')); } catch { return {}; }
}
// Percentages repeat many times per turn. The store always holds the latest reading;
// only a changed reading is written to disk, and only a change asks for a redraw.
export function recordQuota(store, root, snapshot) {
  if (!snapshot?.provider) return false;
  const previous = store[snapshot.provider];
  const time = snapshot.time ?? new Date().toISOString();
  const value = snapshot.windows?.length ? {...snapshot, time, error: snapshot.error ?? null}
    : previous ? {...previous, error: snapshot.error ?? null} : {...snapshot, windows: [], time};
  store[snapshot.provider] = value;
  const same = previous && JSON.stringify({...previous, time: 0}) === JSON.stringify({...value, time: 0});
  if (same) return false;
  if (root) saveJSON(quotaFile(root), store);
  return true;
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
// Header form: short enough to sit beside the fallback order.
export const quotaShort = (entry, now = Date.now()) => (entry?.windows ?? [])
  .map(w => expired(w, now) ? `${w.label} reset` : `${w.label} ${w.percent}%`).join(' · ');
export function quotaReport(store, order, now = Date.now()) {
  return order.map(provider => {
    const entry = store[provider];
    if (!entry?.windows?.length) return `${provider} · ${entry?.error ?? quotaUnavailable(provider)}`;
    const windows = entry.windows.map(w => expired(w, now) ? `${w.label} window reset since this reading`
      : `${w.label} ${w.percent}% used${w.resetsAt ? ` (resets in ${duration(w.resetsAt - now)})` : ''}`);
    return [provider, entry.plan, ...windows, `reported ${since(entry.time, now)}`, entry.error].filter(Boolean).join(' · ');
  }).join('\n');
}
