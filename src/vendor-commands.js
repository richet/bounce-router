import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {skillAreas, skillDir, skillStore} from './skills.js';

// Slash commands the agents own — a .claude/commands/NAME.md, a Codex prompt, a skill — are
// expanded into the turn by bounce rather than by the vendor. The vendor never sees the
// typed line: every request travels inside the handoff packet (core.js), and Claude Code
// only expands /NAME at the very start of its input. Expanding here also means the command
// works whichever agent answers the turn, which is the point of routing. Claude's own
// precedence is kept (a workspace command shadows a home one); bounce's own commands are
// matched first by the caller, so a project /review never reaches this table.
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const readable = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// Fields are read the same lenient way skills.js reads SKILL.md; the block itself is dropped
// from the prompt because it is vendor configuration (allowed-tools, model), not instructions.
function split(text) {
  const block = FRONTMATTER.exec(text);
  const fields = {};
  if (block) for (const line of block[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return {fields, body: (block ? text.slice(block[0].length) : text).trim()};
}

// Where each agent keeps its commands, most specific first. Skills come after commands as
// they do in Claude Code, where /NAME also invokes a skill of that name.
export function commandSources({root, cwd, env = process.env, home = os.homedir()} = {}) {
  const claude = skillAreas.claude.home(env, home), codex = skillAreas.codex.home(env, home);
  const sources = [
    ...(cwd ? [{kind: 'command', origin: 'claude · project', dir: path.join(cwd, '.claude', 'commands')}] : []),
    {kind: 'command', origin: 'claude', dir: path.join(claude, 'commands')},
    {kind: 'command', origin: 'codex', dir: path.join(codex, 'prompts')},
    ...(root ? [{kind: 'skill', origin: 'bounce', dir: skillStore(root)}] : []),
  ];
  for (const provider of Object.keys(skillAreas)) {
    if (cwd) sources.push({kind: 'skill', origin: `${provider} · project`, dir: skillDir(provider, {scope: 'project', cwd, env, home})});
    sources.push({kind: 'skill', origin: provider, dir: skillDir(provider, {scope: 'user', env, home})});
  }
  return sources;
}

// Claude reads commands from subdirectories too (frontend/component.md is still /component),
// so the walk is recursive; a skill is always <dir>/NAME/SKILL.md.
function entries(source) {
  if (!fs.existsSync(source.dir)) return [];
  const found = [];
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (source.kind === 'skill') {
        if (entry.isDirectory() && NAME.test(entry.name) && fs.existsSync(path.join(file, 'SKILL.md'))) found.push({name: entry.name, file: path.join(file, 'SKILL.md'), dir: file});
      } else if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md') && NAME.test(entry.name.slice(0, -3))) found.push({name: entry.name.slice(0, -3), file, dir: path.dirname(file)});
    }
  };
  walk(source.dir, 0);
  return found.map(entry => ({...entry, kind: source.kind, origin: source.origin}));
}

// Every command an agent would offer in this workspace, first match per name.
export function listVendorCommands(options = {}) {
  const seen = new Map();
  for (const source of commandSources(options)) for (const entry of entries(source)) {
    if (seen.has(entry.name)) continue;
    const {fields} = split(readable(entry.file) ?? '');
    seen.set(entry.name, {...entry, description: fields.description ?? '', hint: fields['argument-hint'] ?? ''});
  }
  return [...seen.values()];
}
export const findVendorCommand = (name, options = {}) => listVendorCommands(options).find(entry => entry.name === name.toLowerCase()) ?? null;

// Claude's substitution rules: $ARGUMENTS is the whole tail, $1..$9 its words; a template
// without either gets the arguments appended so they are never silently dropped. Inline
// !`shell` is left as written — the agent runs it as a tool rather than bounce running it
// blind here — and @file mentions are passed through for the agent to open.
export function substitute(body, args) {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const used = /\$ARGUMENTS\b|\$[1-9]\b/.test(body);
  const text = body.replace(/\$ARGUMENTS\b/g, args.trim()).replace(/\$([1-9])\b/g, (_, n) => words[n - 1] ?? '');
  return used || !words.length ? text : `${text}\n\n${args.trim()}`;
}

// The turn to send for a typed "/NAME rest", or null when no agent owns NAME. The prompt
// names its own source so a skill's scripts/ and references/ remain reachable, and so the
// history shows later agents what the request expanded from.
export function expandVendorCommand(text, options = {}) {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const entry = findVendorCommand(match[1], options);
  if (!entry) return null;
  const {body} = split(readable(entry.file) ?? '');
  const source = entry.kind === 'skill' ? `Skill: /${entry.name} (${entry.origin}) — files under ${entry.dir}` : `Command: /${entry.name} (${entry.origin}) — ${entry.file}`;
  return {name: entry.name, origin: entry.origin, file: entry.file, typed: text.trim(), prompt: `${source}\n\n${substitute(body, match[2] ?? '')}`};
}

// Picker and /help rows: name, description with origin, and the vendor's argument hint.
export const vendorCommandRows = options => listVendorCommands(options).map(entry => [entry.name, `${entry.description || (entry.kind === 'skill' ? 'Skill' : 'Command')} (${entry.origin})`, entry.hint]);
