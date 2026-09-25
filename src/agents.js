import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {validateOrchestration, LOCAL_ADAPTERS} from './profiles.js';
import {normalizeLocalSettings} from './local-models.js';

// An agent is the job: one markdown file, frontmatter for what bounce routes on, body as the worker's
// system prompt. The only thing that varies between the AIs that may play it is the AI — `models:`
// lists them in fallback order — so a fallback is always "same job, different brain", never a
// different policy or scope. Kept in one place the way skills are, in override order:
//   shipped with the orchestration skill  →  the adopted/edited skill in the data root
//   →  <root>/agents/  →  <workspace>/.bounce/agents/
// The orchestration skill ships the defaults (builder, integrator, reviewer, analyst), so a fresh
// install has a working team with no file on disk; nothing but `orchestrator` is built in.
//
// `policy` is an attribute the file opts into, not what an agent is. `maxSteps` reaches runtimes
// that can cap steps (OpenCode). `readPaths`/`writePaths`/`commands` apply when the AI is local.
export const SKILL = 'agent-orchestrator';
export const agentStore = root => path.join(root, 'agents');
export const projectAgentStore = cwd => path.join(cwd, '.bounce', 'agents');
export const installedSkillAgents = root => path.join(root, 'skills', SKILL, 'team');
// `team/`, not `agents/`: the skill's `agents/` directory holds the vendor subagent role files
// (orch-*.md for Claude Code, orch-*.toml for Codex), which are a different thing.
const SHIPPED = fileURLToPath(new URL(`../skills/${SKILL}/team/`, import.meta.url));
const LISTS = ['models', 'readPaths', 'writePaths', 'commands'];
export const AUTO_MODEL = 'auto';
const MODEL_REF = /^[a-z0-9][a-z0-9_-]*\/\S+$/;
const list = value => value.trim().replace(/^\[([\s\S]*)\]$/, '$1').split(',').map(item => item.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')).filter(Boolean);
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function agentMetadata(text) {
  const block = FRONTMATTER.exec(text);
  if (!block) throw new Error('an agent file must open with a --- frontmatter block');
  const fields = {};
  for (const line of block[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  if (!NAME.test(fields.name || '')) throw new Error('frontmatter needs a lowercase name (letters, digits, _ or -)');
  if (fields.name === 'orchestrator') throw new Error('orchestrator is reserved; it is derived from the session, never declared as a role');
  if (!fields.description) throw new Error('frontmatter needs a description');
  const policy = fields.policy ?? 'write';
  // probe: reads and runs commands, never changes the tree (docs/plans/probing-reviewer.md).
  if (!['read-only', 'probe', 'write'].includes(policy)) throw new Error('policy must be read-only, probe or write');
  let maxSteps;
  if (fields.maxSteps !== undefined) {
    maxSteps = Number(fields.maxSteps);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 500) throw new Error('maxSteps must be an integer between 1 and 500');
  }
  const lists = {};
  for (const key of LISTS) if (fields[key] !== undefined) lists[key] = list(fields[key]);
  // `auto` hands the choice of AI to Jev at dispatch (src/jev.js); what follows it is the chain the
  // agent runs on when Jev is off, unavailable or unsure — so it can only lead the list.
  if ((lists.models ?? []).indexOf(AUTO_MODEL) > 0) throw new Error('auto goes first in models: the entries after it are what the agent falls back to');
  for (const ref of (lists.models ?? []).filter(ref => ref !== AUTO_MODEL)) {
    if (!MODEL_REF.test(ref)) throw new Error(`models entries are provider/model refs (e.g. claude/sonnet, lmstudio/auto); got ${ref}`);
    // opencode is the runtime, not a provider: a local model is named by its provider (lmstudio/…).
    if (ref.startsWith('opencode/')) throw new Error(`a model ref names its provider, not the runtime; got ${ref} — use lmstudio/<model> for a local model`);
  }
  for (const key of ['readPaths', 'writePaths', 'commands']) {
    for (const entry of lists[key] ?? []) if (entry.includes('\0') || (key !== 'commands' && (entry.startsWith('/') || entry.split('/').some(part => part === '..')))) throw new Error(`${key} must be relative workspace paths`);
  }
  const prompt = text.slice(block[0].length).trim();
  return {name: fields.name, description: fields.description, policy, ...(maxSteps ? {maxSteps} : {}), ...lists, prompt};
}

// The canonical on-disk form, used by everything that writes an agent (the bridge command, setup):
// flat frontmatter, lists in [a, b] form, body verbatim.
export function serializeAgent(agent) {
  const lines = ['---', `name: ${agent.name}`, `description: ${agent.description}`, `policy: ${agent.policy ?? 'write'}`];
  if (agent.maxSteps) lines.push(`maxSteps: ${agent.maxSteps}`);
  for (const key of LISTS) if (agent[key]?.length) lines.push(`${key}: [${agent[key].join(', ')}]`);
  lines.push('---', '', (agent.prompt ?? '').trim(), '');
  return lines.join('\n');
}

// Readers run in other processes (the TUI host and daemon). Publish a complete file with one
// same-directory rename so they can observe either the old definition or the new one, never the
// create/truncate window of writeFileSync on the final pathname.
function writeComplete(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, {mode: 0o600});
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, {force: true}); } catch {}
  }
}

// Writes an agent file where asked, after re-parsing what will be written so an invalid definition
// never lands. Files bounce authored are recorded by content hash so a later write never clobbers a
// user's edit: an authored file may be rewritten only while it still matches what bounce wrote.
export function writeAgent(dir, agent, {authored = false, force = false} = {}) {
  const text = serializeAgent(agent);
  const meta = agentMetadata(text);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = path.join(dir, `${meta.name}.md`);
  const ledger = path.join(dir, '.authored.json');
  let record = {};
  try { record = JSON.parse(fs.readFileSync(ledger, 'utf8')); } catch {}
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf8');
    if (!force && record[meta.name] !== hash(current)) throw Object.assign(new Error(`${meta.name} was edited by hand; it will not be overwritten`), {code: 'AGENT_EDITED'});
  }
  writeComplete(file, text);
  if (authored) { record[meta.name] = hash(text); writeComplete(ledger, JSON.stringify(record, null, 2) + '\n'); }
  return {file, agent: meta};
}
const hash = value => createHash('sha256').update(value).digest('hex');

function readStore(dir, source) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort().map(name => {
    const file = path.join(dir, name);
    try {
      const meta = agentMetadata(fs.readFileSync(file, 'utf8'));
      if (`${meta.name}.md` !== name) throw new Error(`frontmatter name ${meta.name} does not match file name ${name}`);
      return {...meta, file, source};
    } catch (error) { return {name: name.replace(/\.md$/, ''), file, source, error: error.message}; }
  });
}

// Three layers, later ones shadowing by name: the shipped defaults (always present, even before
// anything is seeded — so a read path never has to write), the user's store, then the project's.
// A file that fails to parse is reported, not hidden, so a broken role never silently falls back.
export function loadAgents(root, {cwd} = {}) {
  const roles = new Map();
  for (const agent of readStore(SHIPPED, 'skill')) roles.set(agent.name, agent);
  for (const agent of readStore(installedSkillAgents(root), 'installed-skill')) roles.set(agent.name, agent);
  for (const agent of readStore(agentStore(root), 'user')) roles.set(agent.name, agent);
  if (cwd) for (const agent of readStore(projectAgentStore(cwd), 'project')) roles.set(agent.name, agent);
  return roles;
}

// `/local on`: a mix of local and cloud AIs is Jev's to make, and it only picks the AI of an agent
// whose `models:` opens with `auto`. So every agent file a person wrote gets `auto` put first; the
// models they chose stay behind it, as what the agent runs on when Jev is off or unsure. Shipped
// agents are already `auto` and are never written to. Returns the names changed.
export function handAIsToJev(roles, {orchestrator = 'main'} = {}) {
  const changed = [];
  for (const role of roles.values()) {
    if (role.error || role.name === orchestrator || !['user', 'project'].includes(role.source) || role.models?.[0] === AUTO_MODEL) continue;
    const {file, source, error, ...agent} = role;
    writeAgent(path.dirname(file), {...agent, models: [AUTO_MODEL, ...(role.models ?? [])]}, {force: true});
    changed.push(role.name);
  }
  return changed;
}

// Roles that cannot change anything: read-only, or probe (runs commands, writes nothing).
export const readOnlyRoles = roles => new Set([...roles.values()].filter(role => !role.error && ['read-only', 'probe'].includes(role.policy)).map(role => role.name));

// What every entry point calls. It never writes: the shipped agents are layered in from the skill.
export function rolesFor(root, {cwd} = {}) {
  return loadAgents(root, {cwd});
}

// One row per agent: who may play it here (the derived chain, in fallback order) and which
// backends were skipped and why. The same table backs `bounce agents`, `bounce local` and the TUI.
export function agentTable(roles, settings) {
  let view = null;
  if (settings.operation === 'orchestrator') { try { view = validateOrchestration(settings, undefined, {roles}); } catch {} }
  const ref = p => LOCAL_ADAPTERS.has(p.adapter) ? `${p.endpoint ?? 'lmstudio'}/${p.model || 'auto'} (via opencode)` : [p.adapter, p.model].filter(Boolean).join('/');
  return [...roles.values()].map(role => {
    if (role.error) return {name: role.name, error: role.error, backends: [], skipped: []};
    const chain = []; let current = view?.profiles[role.name];
    if (current?.auto) chain.push('auto (Jev)');
    while (current) { chain.push(ref(current)); current = current.fallback[0] ? view.profiles[current.fallback[0]] : null; }
    return {name: role.name, policy: role.policy, description: role.description, source: role.source, backends: chain,
      skipped: (view?.skipped ?? []).filter(item => item.agent === role.name).map(item => `${item.ref}: ${item.reason}`)};
  });
}

export const formatAgentTable = rows => rows.map(row => row.error
  ? `  ${row.name} · INVALID: ${row.error}`
  : [`  ${row.name} · ${row.policy} · ${row.source} · ${row.backends.length ? row.backends.join(', ') : 'nobody can play it here'}`, ...row.skipped.map(why => `      skipped ${why}`)].join('\n'));

// `bounce agents`: how an agent file gets defined without anyone learning the format by hand.
// The orchestrator (or the user) pipes markdown in; it lands only if it parses, names a provider
// this machine has, and at least one AI here can play it now — the same derivation the daemon will
// run, so what the command accepts is what the next session offers. {text, report} out, like skills.
export function agentsCommand(words, {root, cwd, settings, scope = 'user', input = '', force = false}) {
  const [action = 'list', name] = words.filter(Boolean);
  const roles = loadAgents(root, {cwd});
  const dir = scope === 'project' ? projectAgentStore(cwd) : agentStore(root);
  if (action === 'list') {
    const rows = agentTable(roles, settings);
    return {text: ['Agents (skill agent-orchestrator, then ~/.bounce/agents, then .bounce/agents):', ...formatAgentTable(rows)].join('\n'), report: rows};
  }
  if (!['show', 'remove', 'set'].includes(action)) throw new Error('Use agents list, agents show NAME, agents set NAME [--scope user|project] [--force] (markdown on stdin), or agents remove NAME');
  if (!name) throw new Error(`Use agents ${action} NAME`);
  if (action === 'show') {
    const agent = roles.get(name);
    if (!agent) throw new Error(`no agent named ${name}`);
    return {text: fs.readFileSync(agent.file, 'utf8'), report: agent};
  }
  if (action === 'remove') {
    const agent = roles.get(name);
    if (!agent) throw new Error(`no agent named ${name}`);
    if (agent.source === 'skill') throw new Error(`${name} is shipped with skill ${SKILL}; define one of the same name to override it instead`);
    fs.rmSync(agent.file);
    return {text: `Removed ${name} (${agent.file}). Newly started sessions will not offer it.`, report: agent};
  }
  const agent = agentMetadata(input);
  if (agent.name !== name) throw new Error(`the file defines ${agent.name}, not ${name}`);
  if (name === settings.orchestrator) throw new Error(`${name} is the orchestrator; it is configured, not defined as an agent`);
  const providers = ['claude', 'codex', 'muse', ...Object.keys(normalizeLocalSettings(settings.local).endpoints)];
  for (const ref of (agent.models ?? []).filter(ref => ref !== AUTO_MODEL)) {
    const provider = ref.slice(0, ref.indexOf('/'));
    if (!providers.includes(provider)) throw new Error(`unknown provider ${provider} in models; providers here: ${providers.join(', ')}`);
  }
  // Validate exactly what the daemon will derive, with this file layered where it will land.
  const next = new Map(roles);
  next.set(name, {...agent, source: scope, file: path.join(dir, `${name}.md`)});
  const row = agentTable(next, settings).find(item => item.name === name);
  if (settings.operation === 'orchestrator') {
    validateOrchestration(settings, undefined, {roles: next});
    if (!row.backends.length) throw new Error(`nobody can play ${name} here: ${row.skipped.join('; ') || 'no provider in settings.order and no local endpoint'}`);
  }
  const {file} = writeAgent(dir, agent, {authored: true, force});
  const lines = [`Defined ${name} (${scope}) · ${agent.policy} · ${row.backends.join(', ')}`, ...row.skipped.map(why => `      skipped ${why}`),
    `Written to ${file}. Available to newly started sessions; a running session keeps the roster it started with.`];
  return {text: lines.join('\n'), report: {name, scope, file, backends: row.backends, skipped: row.skipped}};
}
