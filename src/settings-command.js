// /config: see and change bounce's settings from the TUI instead of editing ~/.bounce/config.json by hand
// (Daniel, 2026-10-01: "having to configure a config.json file manually is a hassle"). The file stays the
// truth and keeps only what the user set; every change goes through the same validation as the loader, so a
// refused value is refused with the loader's words. What takes effect at once and what waits for the next
// session is said on every line, because a daemon reads most settings when it starts.
import fs from 'node:fs';
import path from 'node:path';
import {defaults, validateSettings, saveJSON} from './core.js';
import {normalizeJevSettings} from './jev.js';
import {normalizeLocalSettings} from './local-models.js';

// key → {what, applies: 'now' | 'next session'}. Keys not listed here can still be set: they are
// validated the same way and said to apply at the next session.
export const SETTINGS = {
  order: {what: 'provider order for the orchestrator and classic turns (also /order)', applies: 'now', type: 'list', help: 'Which provider the orchestrator (or a classic turn) runs on, and who it falls back to when that one is out of quota or fails: a comma list like codex,claude. The first is the orchestrator.'},
  mode: {what: 'yolo or plan (also /mode)', applies: 'now', type: 'enum', choices: ['yolo', 'plan'], help: 'yolo lets agents run commands and edit without asking; plan makes every agent read-only. The session restarts into the new mode.'},
  'models.claude': {what: 'Claude model for the orchestrator and classic turns', applies: 'now', type: 'string', help: "The Claude model name used when a turn runs on Claude (for example sonnet or opus). Empty means the CLI's own default."},
  'models.codex': {what: 'Codex model for the orchestrator and classic turns', applies: 'now', type: 'string', help: "The Codex model name used when a turn runs on Codex (for example gpt-5.6-sol). Empty means the CLI's own default."},
  sidebar: {what: 'show the status sidebar (also /sidebar)', applies: 'now', type: 'boolean', help: 'Whether the right-hand status rail (workers, models, quota) is shown next to the transcript.'},
  cooldownMinutes: {what: 'how long a provider that hit its quota is skipped', applies: 'now', type: 'number', help: 'After a provider reports its quota is exhausted, how many minutes bounce skips it before trying it again. 0 retries at once.'},
  taskMinutes: {what: 'a task\'s lease, renewed while its worker makes progress (1–240)', applies: 'next session', fallback: 15, type: 'number', help: "How long a worker may run before bounce checks on it: the lease. It is renewed while the worker makes progress, so long work is normal; a worker that stops progressing is asked to conclude at the lease's end. 1 to 240."},
  taskCeilingMinutes: {what: 'the most a task runs from its own start (at least taskMinutes, up to 240)', applies: 'next session', fallback: 60, type: 'number', help: 'The most one task runs, counted from its own start, renewals included; past it the worker is asked for its conclusion. At least taskMinutes, up to 240.'},
  sweepMinutes: {what: 'quiet minutes with held work before the orchestrator is asked; 0 off', applies: 'next session', fallback: 20, type: 'number', help: 'When nothing is running and held work waits for the orchestrator, how many quiet minutes pass before bounce asks it once what is waiting. 0 turns the sweep off.'},
  reports: {what: 'how a worker ends: plain (an answer in its own words) or structured (the fixed report)', applies: 'next session', fallback: 'plain', type: 'enum', choices: ['plain', 'structured'], help: 'How a worker ends its turn: plain — an answer in its own words that bounce turns into the report — or structured — the fixed JSON report. Plain is on trial; structured brings the old format back.'},
  contextChars: {what: 'how much of the journal a handoff carries (4000–200000)', applies: 'next session', type: 'number', help: 'How many characters of recent conversation a handoff to the orchestrator may carry (older decisions beyond it are summarised or dropped). 4000 to 200000.'},
  maxConcurrentCloud: {what: 'cloud workers at once, machine-wide', applies: 'next session', type: 'number', help: 'How many cloud workers (Claude, Codex) run at once across every bounce session on this machine. Local workers have their own limit per endpoint.'},
  'skills.scope': {what: 'where skills install: user or project', applies: 'next session', type: 'enum', choices: ['user', 'project'], help: 'Where skills are installed for the agents: user (your home, every project) or project (this repository only).'},
  'skills.autoSync': {what: 'sync skills to the agents on start', applies: 'next session', type: 'boolean', help: "Whether bounce copies the skills to each agent's own skill folder when a session starts."},
  'jev.enabled': {what: 'Jev (TypeSafe) on or off', applies: 'next session', fallback: false, type: 'boolean', help: 'Whether Jev (TypeSafe) is used at all: reviewing finished work and routing tasks to agents.'},
  'jev.review': {what: 'Jev reviews finished work', applies: 'next session', fallback: true, type: 'boolean', help: 'Whether Jev reviews each finished task before it is accepted and can send it back once.'},
  'jev.routing': {what: 'Jev routes tasks to agents', applies: 'next session', fallback: true, type: 'boolean', help: 'Whether Jev picks the agent (and, for an `auto` agent, the AI) a task goes to.'},
  'jev.confidence': {what: 'confidence Jev needs to accept (0–1)', applies: 'next session', fallback: 0.8, type: 'number', help: "How sure Jev must be to accept finished work on its own, 0 to 1. Below it the work is accepted with Jev's leaning as advice."},
  'jev.sendBackConfidence': {what: 'confidence Jev needs to send work back (0–1)', applies: 'next session', fallback: 0.9, type: 'number', help: 'How sure Jev must be to send finished work back to the worker, 0 to 1. Higher means fewer send-backs; 0.9 was chosen from a measurement of which send-backs were right.'},
  'local.endpoints.lmstudio.maxConcurrent': {what: 'local workers at once on this endpoint', applies: 'next session', fallback: 1, type: 'number', help: 'How many local workers run on this LM Studio at once, across every bounce session on the machine. 1 on a single-GPU Mac: more does not make it faster.'},
  'local.endpoints.lmstudio.contextTokens': {what: 'context OpenCode is told a local model has', applies: 'next session', type: 'number', help: "The context size OpenCode is told a local model has; a worker's conversation is compacted at this size instead of growing to whatever LM Studio loaded the model with."},
  'local.endpoints.lmstudio.slotsPerModel': {what: 'parallel slots per loaded local model', applies: 'next session', type: 'number', help: "How many turns one loaded local model runs at once (LM Studio's parallel slots). Two builders on one model no longer hold back a reviewer on another."},
};
const HIDDEN = new Set(['profiles', 'executables', 'operation', 'orchestrator', 'secrets']);

const getPath = (object, key) => key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object);
function setPath(object, key, value) {
  const parts = key.split('.');
  let node = object;
  for (const part of parts.slice(0, -1)) { if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {}; node = node[part]; }
  if (value === undefined) delete node[parts.at(-1)]; else node[parts.at(-1)] = value;
}
// `true`, `3`, `["codex","claude"]`, `{"a":1}` read as JSON; anything else is the string itself, so `/config reports plain` works unquoted.
export function parseValue(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return undefined;
  if (/^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/s.test(text)) { try { return JSON.parse(text); } catch { return text; } }
  if (/^[^,\s]+(,[^,\s]+)+$/.test(text)) return text.split(',');
  return text;
}
const show = value => value === undefined ? '(unset)' : JSON.stringify(value);

// Everything the loader checks plus the two blocks it hands to their own modules.
export function checkSettings(merged) {
  validateSettings(merged);
  if (merged.jev !== undefined) {
    if (!merged.jev || typeof merged.jev !== 'object') throw new Error('jev must be an object');
    for (const key of ['confidence', 'sendBackConfidence']) {
      const value = merged.jev[key];
      if (value !== undefined && (typeof value !== 'number' || !(value >= 0 && value <= 1))) throw new Error(`jev.${key} must be a number from 0 to 1`);
    }
    for (const key of ['enabled', 'review', 'routing']) if (merged.jev[key] !== undefined && typeof merged.jev[key] !== 'boolean') throw new Error(`jev.${key} must be true or false`);
    normalizeJevSettings(merged.jev);
  }
  if (merged.local !== undefined) normalizeLocalSettings(merged.local);
}

// The rows of the /config panel: every catalogued key with its current value and where it comes from.
export function settingsEntries(root) {
  const file = path.join(root, 'config.json');
  const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return Object.entries(SETTINGS).map(([key, meta]) => {
    const set = getPath(stored, key);
    const value = set !== undefined ? set : getPath(defaults(), key) ?? meta.fallback;
    return {key, meta, value, set: set !== undefined, label: `${key} = ${show(value)}${set === undefined && value !== undefined ? ' (default)' : ''} · ${meta.what} · applies ${meta.applies}`};
  });
}
// The rows a typed filter keeps: a match on the key or on what it does, case aside.
export function filterEntries(entries, text) {
  const needle = String(text ?? '').trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(entry => entry.key.toLowerCase().includes(needle) || entry.meta.what.toLowerCase().includes(needle));
}
// What Enter does on a row: a boolean flips, a choice cycles, anything else is typed (null here).
export function nextValue(entry) {
  if (entry.meta.type === 'boolean') return String(!entry.value);
  if (entry.meta.type === 'enum') { const choices = entry.meta.choices; return choices[(Math.max(0, choices.indexOf(entry.value)) + 1) % choices.length]; }
  return null;
}

// {text, changed: {key, value} | null}. `settings` is the live object the TUI holds; a key that applies now
// is written into it too, so what the TUI reads next reflects the change without a restart.
export function configCommand(words, {root, settings}) {
  const file = path.join(root, 'config.json');
  const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const [first, ...rest] = words.filter(Boolean);
  if (!first || first === 'list') {
    const keys = [...new Set([...Object.keys(SETTINGS), ...Object.keys(stored).filter(key => !HIDDEN.has(key) && typeof stored[key] !== 'object').map(key => key)])];
    const lines = keys.map(key => {
      const set = getPath(stored, key);
      const meta = SETTINGS[key];
      const value = set !== undefined ? set : getPath(defaults(), key) ?? meta?.fallback;
      return `  ${key} = ${show(value)}${set === undefined && value !== undefined ? ' (default)' : ''}${meta ? ` · ${meta.what} · applies ${meta.applies}` : ''}`;
    });
    return {text: [`Settings (${file}; what the file does not set is a default):`, ...lines, '  /config <key> <value> sets one · /config unset <key> returns it to the default · /config help'].join('\n'), changed: null};
  }
  if (first === 'help') {
    return {text: ['/config                shows every setting, its value and whether a change applies now or at the next session', '/config <key> <value>  sets one (true/false, numbers, a,b lists and JSON are read as such; anything else is text)', '/config unset <key>    removes it from the file; the default applies', 'Keys are dotted paths: jev.confidence, local.endpoints.lmstudio.maxConcurrent, models.codex. The file is ' + file + '.'].join('\n'), changed: null};
  }
  const unset = first === 'unset';
  const key = unset ? rest[0] : first;
  const meta = SETTINGS[key];
  if (!key) throw new Error('Use /config unset <key>');
  if (HIDDEN.has(key.split('.')[0])) throw new Error(`${key} is managed elsewhere: profiles and agents by /local setup and bounce agents, the operation by /operation`);
  const value = unset ? undefined : parseValue(rest.join(' '));
  if (!unset && value === undefined) throw new Error(`Use /config ${key} <value>, or /config unset ${key}`);
  const next = structuredClone(stored);
  setPath(next, key, value);
  // prune emptied objects so an unset leaves no `{}` behind
  for (const top of Object.keys(next)) if (next[top] && typeof next[top] === 'object' && !Array.isArray(next[top]) && !Object.keys(next[top]).length) delete next[top];
  checkSettings({...defaults(), ...next});
  saveJSON(file, next);
  const effective = unset ? (getPath(defaults(), key) ?? meta?.fallback) : value;
  if (settings && (meta?.applies === 'now')) setPath(settings, key, effective);
  return {text: `${key} = ${show(effective)}${unset ? ' (default)' : ''} · saved to ${file} · applies ${meta?.applies ?? 'at the next session'}${meta?.applies === 'now' ? '' : ' (restart the session: bounce stop <id>, then bounce --resume <id>)'}`, changed: {key, value: effective}};
}
