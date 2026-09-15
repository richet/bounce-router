import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {commandSources, listVendorCommands, findVendorCommand, expandVendorCommand, substitute, vendorCommandRows} from '../src/vendor-commands.js';
import {inputDisposition} from '../src/commands.js';
import {completions, typedCommand} from '../src/terminal.js';
import {Session, Router, defaults} from '../src/core.js';
import {createFormatter} from '../src/format.js';

const md = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); };
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-vendor-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'data'), home = path.join(base, 'home'), cwd = path.join(base, 'api');
  fs.mkdirSync(cwd, {recursive: true});
  return {base, root, home, cwd, options: {root, cwd, home, env: {}}};
}

test('commands are looked up where each agent keeps them, workspace before home, commands before skills', t => {
  const {root, home, cwd, options} = setup(t);
  const sources = commandSources(options);
  assert.deepEqual(sources.slice(0, 4).map(s => `${s.kind}:${s.origin}`), ['command:claude · project', 'command:claude', 'command:codex', 'skill:bounce']);
  assert.equal(sources[0].dir, path.join(cwd, '.claude/commands'));
  assert.equal(sources[2].dir, path.join(home, '.codex/prompts'));
  assert.equal(commandSources({root, home, env: {}}).some(s => s.origin.endsWith('project')), false, 'no workspace, no project areas');
  assert.equal(commandSources({cwd, home, env: {CODEX_HOME: '/elsewhere'}}).find(s => s.origin === 'codex').dir, '/elsewhere/prompts');

  md(path.join(cwd, '.claude/commands/triage.md'), '---\ndescription: Triage a ticket\nargument-hint: <REC-####>\n---\n\nTriage **$ARGUMENTS** now.\n');
  md(path.join(home, '.claude/commands/triage.md'), 'home copy, shadowed');
  md(path.join(home, '.claude/commands/frontend/component.md'), 'Make a component: $1 in $2');
  md(path.join(home, '.codex/prompts/standup.md'), 'Summarise the day');
  md(path.join(root, 'skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: Ship the site\n---\n\nRun scripts/ship.sh\n');
  md(path.join(cwd, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: workspace copy, shadowed by the bounce store\n---\nx');
  md(path.join(home, '.agents/skills/imagegen/SKILL.md'), '---\nname: imagegen\ndescription: Make pictures\n---\n\nDraw it.\n');
  md(path.join(cwd, '.claude/commands/.hidden.md'), 'ignored');
  md(path.join(cwd, '.claude/commands/Not Valid.md'), 'ignored');

  const found = listVendorCommands(options);
  assert.deepEqual(found.map(c => `${c.name}:${c.kind}:${c.origin}`),
    ['triage:command:claude · project', 'component:command:claude', 'standup:command:codex', 'deploy:skill:bounce', 'imagegen:skill:muse']);
  assert.equal(found[0].description, 'Triage a ticket');
  assert.equal(found[0].hint, '<REC-####>');
  assert.equal(findVendorCommand('TRIAGE', options).file, path.join(cwd, '.claude/commands/triage.md'));
  assert.equal(findVendorCommand('nope', options), null);
  assert.deepEqual(vendorCommandRows(options)[0], ['triage', 'Triage a ticket (claude · project)', '<REC-####>']);
  assert.deepEqual(vendorCommandRows(options)[2], ['standup', 'Command (codex)', '']);
});

test('expansion follows Claude substitution rules, drops frontmatter and names its source', t => {
  const {root, cwd, options} = setup(t);
  md(path.join(cwd, '.claude/commands/triage.md'), '---\ndescription: Triage a ticket\nallowed-tools: Bash(git:*)\n---\n\nTriage **$ARGUMENTS** now.\nIf `$ARGUMENTS` is empty, ask.\n');
  md(path.join(cwd, '.claude/commands/seed.md'), 'Account $1, contact $2 $3; cost $10.');
  md(path.join(cwd, '.claude/commands/standup.md'), 'Summarise the day.');
  md(path.join(root, 'skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: Ship the site\n---\n\nRun scripts/ship.sh\n');

  const triage = expandVendorCommand('/triage REC-1234 ', options);
  assert.equal(triage.name, 'triage'); assert.equal(triage.origin, 'claude · project'); assert.equal(triage.typed, '/triage REC-1234');
  assert.equal(triage.prompt, `Command: /triage (claude · project) — ${path.join(cwd, '.claude/commands/triage.md')}\n\nTriage **REC-1234** now.\nIf \`REC-1234\` is empty, ask.`);
  assert.equal(triage.prompt.includes('allowed-tools'), false, 'frontmatter is vendor configuration, not instructions');
  assert.match(expandVendorCommand('/seed Acme Jane Doe', options).prompt, /Account Acme, contact Jane Doe; cost \$10\.$/);
  assert.match(expandVendorCommand('/seed Acme', options).prompt, /Account Acme, contact  ; cost/);
  // Arguments a template never mentions are appended rather than lost.
  assert.match(expandVendorCommand('/standup for the api team', options).prompt, /Summarise the day\.\n\nfor the api team$/);
  assert.match(expandVendorCommand('/standup', options).prompt, /Summarise the day\.$/);
  // A skill says where its files are so scripts/ and references/ stay reachable.
  const deploy = expandVendorCommand('/deploy', options);
  assert.equal(deploy.prompt, `Skill: /deploy (bounce) — files under ${path.join(root, 'skills/deploy')}\n\nRun scripts/ship.sh`);
  assert.equal(expandVendorCommand('/unknown thing', options), null);
  assert.equal(expandVendorCommand('not a command', options), null);
  assert.equal(substitute('a $ARGUMENTS b $ARGUMENTSX', 'x y'), 'a x y b $ARGUMENTSX');
});

test('the TUI treats an agent-owned /NAME as a turn, offers it in the picker and runs it on Enter', () => {
  const vendorCommand = name => name === 'triage';
  assert.equal(inputDisposition('/triage REC-1', {busy: false, vendorCommand}).action, 'run-turn');
  assert.equal(inputDisposition('/triage REC-1', {busy: true, vendorCommand}).action, 'queue-turn');
  assert.equal(inputDisposition('/triage REC-1', {busy: false, vendorCommand}).vendor, 'triage');
  // bounce's own commands win a name clash, and an unknown name is still a command error.
  assert.equal(inputDisposition('/skills', {busy: false, vendorCommand: () => true}).action, 'run-command');
  assert.equal(inputDisposition('/nope', {busy: false, vendorCommand}).unknown, true);
  assert.equal(inputDisposition('/nope', {busy: false}).unknown, true);

  const extra = () => [['triage', 'Triage a ticket (claude · project)', '<REC-####>'], ['seed-account', 'Seed (claude · project)', ''], ['skills', 'a clash', '']];
  assert.deepEqual(completions('/tri', extra).map(r => r[0]), ['triage']);
  assert.deepEqual(completions('/s', extra).map(r => r[0]), ['sessions', 'skills', 'stop', 'seed-account']);
  assert.equal(completions('/', extra).length, 30, 'own commands, then the two extras that do not clash');
  assert.equal(completions('/', ).length, 28);
  assert.equal(typedCommand('/triage', extra), 'triage');
  assert.equal(typedCommand('/seed-account', extra), 'seed-account');
  assert.equal(typedCommand('/triage'), '');
  assert.equal(typedCommand('/skills'), 'skills');
});

test('the journal keeps the expansion as the request and the typed line for the transcript', async t => {
  const {root, cwd, options} = setup(t);
  md(path.join(cwd, '.claude/commands/triage.md'), 'Triage **$ARGUMENTS** end-to-end.');
  const session = new Session(root, {root, cwd});
  const attempts = [];
  const router = new Router(session, defaults(), {runner: async o => { attempts.push(o); return {status: 'completed'}; }});
  const expanded = expandVendorCommand('/triage REC-7', options);
  await router.run(expanded.prompt, [], {typed: '/triage REC-7'});
  const user = session.events.find(e => e.kind === 'user');
  assert.equal(user.typed, '/triage REC-7');
  assert.match(user.text, /Triage \*\*REC-7\*\* end-to-end\./);
  assert.match(attempts[0].prompt, /Current user request:\nCommand: \/triage \(claude · project\)[^\n]*\n\nTriage \*\*REC-7\*\* end-to-end\./);
  // A later turn's history carries the instructions, not just the slash line.
  await router.run('Carry on');
  assert.match(attempts[1].prompt, /\[user\] Command: \/triage[\s\S]*end-to-end/);
  await router.run('Plain');
  assert.equal('typed' in session.events.findLast(e => e.kind === 'user'), false);

  const compact = createFormatter({color: false, compact: true}).event(user, 80);
  assert.equal(compact[0], '> /triage REC-7');
  assert.match(compact[1], /^  ⎿  expanded to \d+ chars · \/details shows it/);
  assert.equal(compact.join('\n').includes('end-to-end'), false);
  assert.match(createFormatter({color: false}).event(user, 80).join('\n'), /end-to-end/);
});
