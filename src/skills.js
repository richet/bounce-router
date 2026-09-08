import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

// Skills are a vendor feature: every CLI scans its own directory and none of them knows
// about bounce. A routed turn can land on any agent, so a skill installed for one of them
// silently disappears on fallback. bounce keeps one copy of each skill in its own data root
// and installs it into all three skill areas, so the same skills follow the conversation.
// Verified 2026-09-08: Claude reads ~/.claude/skills and <workspace>/.claude/skills, Codex
// $CODEX_HOME/skills and <workspace>/.codex/skills, Muse ~/.agents/skills and — in a
// workspace — .agents, .claude and .codex alike, shadowing a duplicate id with a note
// rather than failing. Each entry is <name>/SKILL.md with name/description frontmatter.
export const skillAreas = {
  claude: {home: (env, home) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), project: '.claude'},
  codex: {home: (env, home) => env.CODEX_HOME || path.join(home, '.codex'), project: '.codex'},
  muse: {home: (env, home) => path.join(home, '.agents'), project: '.agents'},
};
// Names an installed copy as bounce's. Sync updates or removes exactly the directories
// carrying it, so a skill the agent or the user installed natively is never touched.
const MARKER = '.bounce-skill.json';
const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const skillStore = root => path.join(root, 'skills');
export function skillDir(provider, {scope = 'user', cwd, env = process.env, home = os.homedir()} = {}) {
  const area = skillAreas[provider];
  if (!area) throw new Error(`Unknown provider: ${provider}`);
  if (scope === 'user') return path.join(area.home(env, home), 'skills');
  if (scope !== 'project') throw new Error('Skill scope must be user or project');
  if (!cwd) throw new Error('Project skills need a workspace directory');
  return path.join(cwd, area.project, 'skills');
}

// Only the two fields every provider agrees on are read. Nested keys stay indented and are
// left to the vendor: bounce validates what it routes on, and passes the file through whole.
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
export function skillMetadata(text) {
  const block = FRONTMATTER.exec(text);
  if (!block) throw new Error('SKILL.md must open with a --- frontmatter block');
  const fields = {};
  for (const line of block[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  if (!NAME.test(fields.name || '')) throw new Error('frontmatter needs a lowercase, hyphenated name');
  if (!fields.description) throw new Error('frontmatter needs a description');
  return {name: fields.name, description: fields.description};
}

// Symlinks are neither hashed nor copied: an installed skill must not reach outside itself.
function skillFiles(dir, base = dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return skillFiles(file, base);
    if (!entry.isFile() || entry.name === MARKER) return [];
    return [{relative: path.relative(base, file), file}];
  });
}
export function skillHash(dir) {
  const hash = createHash('sha256');
  for (const {relative, file} of skillFiles(dir)) hash.update(relative).update('\0').update(fs.readFileSync(file)).update('\0');
  return hash.digest('hex');
}
export function readSkill(dir) {
  const name = path.basename(dir);
  try {
    const meta = skillMetadata(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    if (meta.name !== name) throw new Error(`frontmatter name "${meta.name}" does not match its directory`);
    return {name, description: meta.description, dir, hash: skillHash(dir)};
  } catch (error) { return {name, dir, error: error.code === 'ENOENT' ? 'no SKILL.md' : error.message}; }
}
export function listSkills(root) {
  const store = skillStore(root);
  if (!fs.existsSync(store)) return [];
  return fs.readdirSync(store, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => readSkill(path.join(store, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const marker = dir => { try { const value = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); return typeof value?.hash === 'string' ? value : null; } catch { return null; } };
const managed = dir => fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isDirectory() && marker(path.join(dir, e.name))).map(e => e.name) : [];
function copyInto(from, to) {
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(target, {recursive: true, mode: 0o700}); copyInto(source, target); }
    else if (entry.isFile() && entry.name !== MARKER) fs.copyFileSync(source, target);
  }
}
// Build beside the destination and rename in. An interrupted copy can then never leave a
// half-written skill behind, which sync would later read as one of the agent's own.
function replace(target, build) {
  const staging = `${target}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
    fs.mkdirSync(staging, {recursive: true, mode: 0o700});
    build(staging);
    fs.rmSync(target, {recursive: true, force: true});
    fs.renameSync(staging, target);
  } finally { fs.rmSync(staging, {recursive: true, force: true}); }
}
function install(skill, target) {
  replace(target, dir => {
    copyInto(skill.dir, dir);
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({skill: skill.name, hash: skill.hash, source: skill.dir, installed: new Date().toISOString()}, null, 2) + '\n', {mode: 0o600});
  });
}

export function syncSkills({root, scope = 'user', cwd, env, home, providers = Object.keys(skillAreas)} = {}) {
  const skills = listSkills(root);
  const report = [];
  for (const provider of providers) {
    const dir = skillDir(provider, {scope, cwd, env, home});
    // Never create a config directory for an agent that has none: an absent home means the
    // CLI is not installed here, and a skills directory beside nothing would only be litter.
    const base = scope === 'user' ? path.dirname(dir) : cwd;
    if (!fs.existsSync(base)) { report.push({provider, action: 'absent', detail: `${base} does not exist`}); continue; }
    for (const skill of skills) {
      if (skill.error) { report.push({provider, skill: skill.name, action: 'invalid', detail: skill.error}); continue; }
      const target = path.join(dir, skill.name);
      const installed = marker(target);
      // An unmarked copy that is byte-identical is the skill bounce adopted from this very
      // agent: there is nothing to write and nothing in dispute, so it is not a conflict.
      // It stays unmarked, so dropping the skill from bounce never deletes the agent's own.
      if (!installed && fs.existsSync(target)) {
        const action = skillHash(target) === skill.hash ? 'identical' : 'conflict';
        report.push({provider, skill: skill.name, action, detail: action === 'conflict'
          ? `${provider} has a different ${skill.name} skill of its own; left in place`
          : `${provider} already has this exact skill; left unmanaged`});
        continue;
      }
      if (installed?.hash === skill.hash) { report.push({provider, skill: skill.name, action: 'current'}); continue; }
      install(skill, target);
      report.push({provider, skill: skill.name, action: installed ? 'updated' : 'installed'});
    }
    // A skill dropped from the store is withdrawn from the agents that were given it.
    for (const name of managed(dir)) if (!skills.some(skill => skill.name === name)) {
      fs.rmSync(path.join(dir, name), {recursive: true, force: true});
      report.push({provider, skill: name, action: 'removed'});
    }
  }
  return report;
}
// Withdraws every copy bounce installed, without touching the agents' own skills. Used to
// uninstall, and to clean up the scope you were using before switching to the other one.
export function clearSkills({scope = 'user', cwd, env, home, providers = Object.keys(skillAreas)} = {}) {
  const report = [];
  for (const provider of providers) {
    const dir = skillDir(provider, {scope, cwd, env, home});
    for (const name of managed(dir)) { fs.rmSync(path.join(dir, name), {recursive: true, force: true}); report.push({provider, skill: name, action: 'removed'}); }
  }
  return report;
}
// Empties bounce's own store as well as withdrawing the installed copies, so a bad import
// can be undone in one step. An agent's own skills are left exactly where they were.
export function resetSkills({root, scope = 'user', cwd, env, home, providers = Object.keys(skillAreas)} = {}) {
  const names = listSkills(root).map(skill => skill.name);
  const report = clearSkills({scope, cwd, env, home, providers});
  fs.rmSync(skillStore(root), {recursive: true, force: true});
  return [...report, ...names.map(skill => ({provider: 'bounce', skill, action: 'deleted'}))];
}
export function inspectSkills({root, scope = 'user', cwd, env, home, providers = Object.keys(skillAreas)} = {}) {
  return listSkills(root).map(skill => ({...skill, state: Object.fromEntries(providers.map(provider => {
    const target = path.join(skillDir(provider, {scope, cwd, env, home}), skill.name);
    const installed = marker(target);
    if (installed) return [provider, installed.hash === skill.hash ? 'current' : 'stale'];
    if (!fs.existsSync(target)) return [provider, 'missing'];
    return [provider, skillHash(target) === skill.hash ? 'identical' : 'conflict'];
  }))}));
}

// base is where a relative path is read from: the shell's directory headlessly, and the
// session workspace in the TUI, which is not necessarily the directory bounce was started in.
export function addSkill(root, source, {home = os.homedir(), base = process.cwd(), force = false} = {}) {
  const resolved = path.resolve(base, source.startsWith('~/') ? path.join(home, source.slice(2)) : source);
  const directory = fs.statSync(resolved).isDirectory();
  const file = directory ? path.join(resolved, 'SKILL.md') : resolved;
  const meta = skillMetadata(fs.readFileSync(file, 'utf8'));
  const target = path.join(skillStore(root), meta.name);
  if (fs.existsSync(target) && !force) throw new Error(`bounce already has a ${meta.name} skill. Add --force to replace it.`);
  // A directory is adopted whole, so references and scripts come with it; a lone Markdown
  // file becomes that skill's SKILL.md whatever the vendor happened to call it.
  replace(target, dir => directory ? copyInto(resolved, dir) : fs.copyFileSync(file, path.join(dir, 'SKILL.md')));
  return readSkill(target);
}
export function removeSkill(root, name) {
  if (!NAME.test(name || '')) throw new Error('Skill names are lowercase and hyphenated');
  const target = path.join(skillStore(root), name);
  if (!fs.existsSync(target)) throw new Error(`No bounce skill named ${name}`);
  fs.rmSync(target, {recursive: true, force: true});
  return target;
}
export function newSkill(root, name, description = 'Describe when an agent should use this skill.') {
  if (!NAME.test(name || '')) throw new Error('Skill names are lowercase and hyphenated');
  const target = path.join(skillStore(root), name);
  if (fs.existsSync(target)) throw new Error(`bounce already has a ${name} skill`);
  fs.mkdirSync(target, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(target, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nWrite the instructions an agent should follow here.\n`,
    {mode: 0o600, flag: 'wx'});
  return target;
}
// Adopt what an agent already has, so an existing skill set becomes bounce-managed
// without being retyped. Copies bounce itself installed are skipped: they are already here.
// Surveying is separate from adopting so the TUI can offer the list before anything is
// written, and so the same list drives both the picker and the headless run.
export function importCandidates({root, scope = 'user', cwd, env, home, providers = Object.keys(skillAreas)} = {}) {
  const found = [];
  for (const provider of providers) {
    const dir = skillDir(provider, {scope, cwd, env, home});
    if (!fs.existsSync(dir)) { found.push({provider, action: 'absent', detail: `${dir} does not exist`}); continue; }
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const source = path.join(dir, entry.name);
      if (marker(source)) continue;
      const skill = readSkill(source);
      if (skill.error) { found.push({provider, skill: entry.name, action: 'invalid', detail: skill.error}); continue; }
      // The same skill often sits in two agents' directories; offer the first one only.
      if (found.some(row => row.skill === skill.name && row.action !== 'invalid')) continue;
      found.push({provider, skill: skill.name, dir: source, description: skill.description,
        action: fs.existsSync(path.join(skillStore(root), skill.name)) ? 'exists' : 'new'});
    }
  }
  return found;
}
// Adopts exactly the candidates handed back, so a selection made in the picker is what runs.
export function importSelected(root, candidates, {home, force = false} = {}) {
  return candidates.map(candidate => {
    if (candidate.action === 'exists' && !force) return {...candidate};
    addSkill(root, candidate.dir, {home, force: true});
    return {...candidate, action: 'adopted'};
  });
}
export function importSkills({root, force = false, ...options} = {}) {
  const found = importCandidates({root, ...options});
  const adoptable = found.filter(row => row.dir && (force || row.action === 'new'));
  const adopted = new Map(importSelected(root, adoptable, {home: options.home, force}).map(row => [row.skill, row]));
  return found.map(row => adopted.get(row.skill) ?? row);
}

const summarize = (report, counted) => [...new Set(report.map(row => row.provider))].map(provider => {
  const rows = report.filter(row => row.provider === provider);
  const counts = counted.map(action => [action, rows.filter(row => row.action === action).length]).filter(([, n]) => n);
  return [`${provider}: ${counts.map(([action, n]) => `${n} ${action}`).join(', ') || 'nothing to do'}`,
    ...rows.filter(row => ['conflict', 'invalid', 'absent'].includes(row.action)).map(row => `  ${row.skill ? row.skill + ': ' : ''}${row.detail}`)].join('\n');
}).join('\n');
export const syncSummary = report => summarize(report, ['installed', 'updated', 'current', 'identical', 'removed']) || 'No agent skill directories to write to.';
export function importListing(found) {
  const offered = found.filter(row => row.dir);
  if (!offered.length) return ['Nothing to import.',
    ...found.filter(row => row.detail).map(row => `  ${row.provider}: ${row.detail}`)].join('\n');
  return [`${offered.length} skill${offered.length === 1 ? '' : 's'} available to import:`,
    ...offered.map(row => `  ${row.action === 'exists' ? '=' : '+'} ${row.skill} (${row.provider}) — ${String(row.description).slice(0, 90)}`),
    ...found.filter(row => row.action === 'invalid').map(row => `  ! ${row.skill} (${row.provider}): ${row.detail}`),
    '"+" is new to bounce; "=" is already in the store and needs --force to replace.'].join('\n');
}
export const importSummary = report => summarize(report, ['adopted', 'exists', 'skipped']);
export const skillsChanged = report => report.some(row => ['installed', 'updated', 'removed'].includes(row.action));
export function skillsSummary(root, options) {
  const skills = inspectSkills({root, ...options});
  if (!skills.length) return `No bounce skills yet in ${skillStore(root)}.\nUse "skills new NAME" to write one, or "skills import" to adopt what your agents already have.`;
  return [`${skills.length} skill${skills.length === 1 ? '' : 's'} in ${skillStore(root)} · ${options?.scope ?? 'user'} scope`,
    ...skills.map(skill => `  ${skill.name} — ${skill.error ? `invalid: ${skill.error}` : skill.description.slice(0, 120)}\n    ${Object.entries(skill.state).map(([provider, state]) => `${provider} ${state}`).join(' · ')}`)].join('\n');
}

// One command surface for the TUI and the headless CLI, so both accept the same words.
export function skillsCommand(words, options) {
  const [action = 'list', ...rest] = words.filter(Boolean);
  const force = rest.includes('--force');
  const args = rest.filter(word => word !== '--force');
  const {root} = options;
  const sync = text => {
    const report = syncSkills(options);
    return {text: [text, syncSummary(report)].filter(Boolean).join('\n'), report};
  };
  if (action === 'list') return {text: skillsSummary(root, options)};
  if (action === 'sync') return sync('');
  if (action === 'clear') { const report = clearSkills(options); return {text: summarize(report, ['removed']) || 'Nothing installed by bounce to remove.', report}; }
  if (action === 'reset') {
    const skills = listSkills(root);
    // Deleting the store is not recoverable, so say what will go and make the user say it again.
    if (!force) return {text: skills.length
      ? `Reset deletes all ${skills.length} skill${skills.length === 1 ? '' : 's'} from ${skillStore(root)} and removes every copy bounce installed:\n  ${skills.map(s => s.name).join(', ')}\nRun "skills reset --force" to do it.`
      : `bounce has no skills to delete. Use "skills clear --force" if copies are still installed.`};
    const report = resetSkills(options);
    return {text: summarize(report, ['removed', 'deleted']) || 'Nothing to reset.', report};
  }
  if (action === 'new') return {text: `Created ${newSkill(root, args[0], args.slice(1).join(' ') || undefined)}\nEdit its SKILL.md, then run skills sync.`};
  if (action === 'add') {
    if (!args.length) throw new Error('Use skills add PATH');
    const skill = addSkill(root, args.join(' '), {home: options.home, base: options.base, force});
    if (skill.error) { removeSkill(root, skill.name); throw new Error(`Not a usable skill: ${skill.error}`); }
    return sync(`Added ${skill.name} — ${skill.description}`);
  }
  if (action === 'remove') return sync(`Removed ${removeSkill(root, args[0])}`);
  if (action === 'import') {
    const providers = args.filter(word => word !== '--list').length ? args.filter(word => word !== '--list') : undefined;
    for (const provider of providers ?? []) if (!skillAreas[provider]) throw new Error(`Unknown provider: ${provider}`);
    // --list surveys without writing, so the offer can be reviewed before anything is adopted.
    if (args.includes('--list')) {
      const found = importCandidates({...options, providers});
      return {text: importListing(found), report: found};
    }
    const report = importSkills({...options, providers, force});
    return sync(importSummary(report));
  }
  throw new Error('Use skills list, sync, new, add, remove, import, clear or reset');
}
