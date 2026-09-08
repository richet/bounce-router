import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {skillMetadata, skillDir, skillStore, listSkills, syncSkills, inspectSkills, addSkill, newSkill, importSkills, importCandidates, importSelected, clearSkills, resetSkills, skillsCommand, skillsChanged} from '../src/skills.js';
import {config, defaults} from '../src/core.js';

const write = (dir, name, description, extra = {}) => {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`);
  for (const [file, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
};
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-skills-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'data'), home = path.join(base, 'home'), cwd = path.join(base, 'work');
  for (const dir of ['.claude', '.codex', '.agents']) fs.mkdirSync(path.join(home, dir), {recursive: true});
  fs.mkdirSync(cwd, {recursive: true});
  // env is empty so a real CLAUDE_CONFIG_DIR/CODEX_HOME cannot redirect a test at the machine.
  return {base, root, home, cwd, options: {root, home, cwd, env: {}}};
}

test('frontmatter yields the routed fields and rejects what no agent would load', () => {
  assert.deepEqual(skillMetadata('---\nname: deploy-web\ndescription: "Ship the site"\nmetadata:\n  short: ignored\n---\n\ntext'),
    {name: 'deploy-web', description: 'Ship the site'});
  assert.deepEqual(skillMetadata('﻿---\r\nname: bom\r\ndescription: handles a byte order mark\r\n---\r\ntext').name, 'bom');
  for (const [source, message] of [
    ['# no frontmatter', /--- frontmatter block/],
    ['---\nname: Deploy Web\ndescription: caps and spaces\n---\n', /lowercase, hyphenated/],
    ['---\nname: deploy\n---\n', /needs a description/],
  ]) assert.throws(() => skillMetadata(source), message);
});

test('each agent gets its own verified skills directory in both scopes', () => {
  const home = '/h', cwd = '/w', env = {};
  assert.deepEqual(['claude', 'codex', 'muse'].map(p => skillDir(p, {home, env})),
    ['/h/.claude/skills', '/h/.codex/skills', '/h/.agents/skills']);
  assert.deepEqual(['claude', 'codex', 'muse'].map(p => skillDir(p, {scope: 'project', cwd, home, env})),
    ['/w/.claude/skills', '/w/.codex/skills', '/w/.agents/skills']);
  assert.equal(skillDir('claude', {home, env: {CLAUDE_CONFIG_DIR: '/custom'}}), '/custom/skills');
  assert.equal(skillDir('codex', {home, env: {CODEX_HOME: '/custom'}}), '/custom/skills');
  assert.throws(() => skillDir('gemini', {home, env}), /Unknown provider/);
  assert.throws(() => skillDir('claude', {scope: 'global', home, env}), /user or project/);
});

test('one bounce skill reaches every agent, updates in place, and is withdrawn on removal', t => {
  const {root, home, options} = setup(t);
  write(path.join(skillStore(root), 'deploy'), 'deploy', 'Ship the site', {'references/steps.md': 'one\n'});
  const first = syncSkills(options);
  assert.equal(skillsChanged(first), true);
  assert.deepEqual(first.map(r => `${r.provider}:${r.action}`), ['claude:installed', 'codex:installed', 'muse:installed']);
  for (const dir of ['.claude', '.codex', '.agents']) {
    assert.match(fs.readFileSync(path.join(home, dir, 'skills/deploy/SKILL.md'), 'utf8'), /name: deploy/);
    assert.equal(fs.readFileSync(path.join(home, dir, 'skills/deploy/references/steps.md'), 'utf8'), 'one\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, dir, 'skills/deploy/.bounce-skill.json'), 'utf8')).skill, 'deploy');
  }
  // An unchanged store writes nothing at all, so a sync per launch is free.
  const before = fs.statSync(path.join(home, '.claude/skills/deploy/SKILL.md')).mtimeMs;
  assert.deepEqual(syncSkills(options).map(r => r.action), ['current', 'current', 'current']);
  assert.equal(skillsChanged(syncSkills(options)), false);
  assert.equal(fs.statSync(path.join(home, '.claude/skills/deploy/SKILL.md')).mtimeMs, before);
  assert.deepEqual(inspectSkills(options)[0].state, {claude: 'current', codex: 'current', muse: 'current'});

  fs.writeFileSync(path.join(skillStore(root), 'deploy/references/steps.md'), 'two\n');
  assert.deepEqual(inspectSkills(options)[0].state, {claude: 'stale', codex: 'stale', muse: 'stale'});
  assert.deepEqual(syncSkills(options).map(r => r.action), ['updated', 'updated', 'updated']);
  assert.equal(fs.readFileSync(path.join(home, '.codex/skills/deploy/references/steps.md'), 'utf8'), 'two\n');

  fs.rmSync(path.join(skillStore(root), 'deploy'), {recursive: true});
  assert.deepEqual(syncSkills(options).map(r => `${r.provider}:${r.action}`), ['claude:removed', 'codex:removed', 'muse:removed']);
  for (const dir of ['.claude', '.codex', '.agents']) assert.equal(fs.existsSync(path.join(home, dir, 'skills/deploy')), false);
});

test('an agent\'s own skill is never overwritten or deleted, and a missing agent home is left alone', t => {
  const {root, home, options} = setup(t);
  write(path.join(skillStore(root), 'review'), 'review', 'Review a diff');
  const native = write(path.join(home, '.claude/skills/review'), 'review', 'Claude wrote this one');
  const vendor = write(path.join(home, '.codex/skills/imagegen'), 'imagegen', 'Codex shipped this one');
  fs.rmSync(path.join(home, '.agents'), {recursive: true});

  const report = syncSkills(options);
  // Claude's own review skill differs in content, so it is a real conflict and is left alone.
  assert.deepEqual(report.map(r => `${r.provider}:${r.action}`), ['claude:conflict', 'codex:installed', 'muse:absent']);
  assert.match(fs.readFileSync(path.join(native, 'SKILL.md'), 'utf8'), /Claude wrote this one/);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
  assert.deepEqual(inspectSkills(options)[0].state, {claude: 'conflict', codex: 'current', muse: 'missing'});

  // Pruning a dropped skill only touches directories carrying bounce's marker.
  fs.rmSync(path.join(skillStore(root), 'review'), {recursive: true});
  syncSkills(options);
  assert.equal(fs.existsSync(vendor), true);
  assert.equal(fs.existsSync(native), true);
});

test('skills are adopted from a folder, a single file, or the agents that already have them', t => {
  const {base, root, home, options} = setup(t);
  const source = write(path.join(base, 'src/deploy'), 'deploy', 'Ship the site', {'scripts/go.sh': 'echo go\n'});
  assert.equal(addSkill(root, source, {home}).name, 'deploy');
  assert.equal(fs.readFileSync(path.join(skillStore(root), 'deploy/scripts/go.sh'), 'utf8'), 'echo go\n');
  assert.throws(() => addSkill(root, source, {home}), /already has a deploy skill/);
  addSkill(root, source, {home, force: true});

  fs.writeFileSync(path.join(base, 'notes.md'), '---\nname: notes\ndescription: Take notes\n---\n\nbody\n');
  assert.equal(addSkill(root, path.join(base, 'notes.md'), {home}).name, 'notes');
  assert.equal(fs.existsSync(path.join(skillStore(root), 'notes/SKILL.md')), true);

  write(path.join(home, '.codex/skills/imagegen'), 'imagegen', 'Codex shipped this one');
  write(path.join(home, '.codex/skills/broken'), 'broken', 'x');
  fs.writeFileSync(path.join(home, '.codex/skills/broken/SKILL.md'), 'no frontmatter');
  fs.mkdirSync(path.join(home, '.codex/skills/.system'), {recursive: true});
  syncSkills(options);
  const report = importSkills(options);
  assert.deepEqual(report.filter(r => r.skill).map(r => `${r.skill}:${r.action}`), ['broken:invalid', 'imagegen:adopted']);
  assert.deepEqual(listSkills(root).map(s => s.name), ['deploy', 'imagegen', 'notes']);
  // A second import re-reports the broken one and leaves the skill already in the store alone.
  assert.deepEqual(importSkills(options).filter(r => r.skill).map(r => `${r.skill}:${r.action}`), ['broken:invalid', 'imagegen:exists']);
});

test('the command surface scaffolds, syncs, lists and clears without touching vendor skills', t => {
  const {root, home, options} = setup(t);
  assert.match(skillsCommand([], options).text, /No bounce skills yet/);
  assert.match(skillsCommand(['new', 'deploy', 'Ship', 'the', 'site'], options).text, /Created .*skills\/deploy/);
  assert.match(fs.readFileSync(path.join(skillStore(root), 'deploy/SKILL.md'), 'utf8'), /description: Ship the site/);
  assert.throws(() => skillsCommand(['new', 'deploy'], options), /already has a deploy skill/);
  assert.throws(() => skillsCommand(['new', 'Deploy Web'], options), /lowercase and hyphenated/);

  assert.match(skillsCommand(['sync'], options).text, /claude: 1 installed/);
  const listed = skillsCommand(['list'], options).text;
  assert.match(listed, /deploy — Ship the site/);
  assert.match(listed, /claude current · codex current · muse current/);

  const native = write(path.join(home, '.agents/skills/imagegen'), 'imagegen', 'Muse shipped this one');
  assert.match(skillsCommand(['clear'], options).text, /muse: 1 removed/);
  assert.equal(fs.existsSync(path.join(home, '.claude/skills/deploy')), false);
  assert.equal(fs.existsSync(native), true);
  assert.equal(listSkills(root).length, 1);

  skillsCommand(['sync'], options);
  assert.match(skillsCommand(['remove', 'deploy'], options).text, /Removed .*skills\/deploy/);
  assert.equal(fs.existsSync(path.join(home, '.codex/skills/deploy')), false);
  assert.throws(() => skillsCommand(['remove', 'deploy'], options), /No bounce skill named deploy/);
  assert.throws(() => skillsCommand(['explode'], options), /list, sync, new, add, remove, import, clear or reset/);
});

test('skill settings default on and reject an unusable scope', t => {
  const {root} = setup(t);
  assert.deepEqual(defaults().skills, {scope: 'user', autoSync: true});
  fs.mkdirSync(root, {recursive: true});
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({skills: {scope: 'project'}}));
  assert.deepEqual(config(root).skills, {scope: 'project', autoSync: true});
  fs.writeFileSync(file, JSON.stringify({skills: {scope: 'everywhere'}}));
  assert.throws(() => config(root), /config.skills must be/);
});

test('a skill adopted from an agent is not then reported as a conflict against that agent', t => {
  const {root, home, options} = setup(t);
  // The bug: import copied Muse's skills into bounce, then sync called every one of them a
  // conflict, because Muse's originals carry no marker and the bytes were never compared.
  write(path.join(home, '.agents/skills/deploy'), 'deploy', 'Ship the site', {'refs/a.md': 'one\n'});
  importSkills(options);
  assert.deepEqual(listSkills(root).map(s => s.name), ['deploy']);

  const report = syncSkills(options);
  assert.deepEqual(report.map(r => `${r.provider}:${r.action}`), ['claude:installed', 'codex:installed', 'muse:identical']);
  assert.deepEqual(inspectSkills(options)[0].state, {claude: 'current', codex: 'current', muse: 'identical'});
  assert.match(skillsCommand(['sync'], options).text, /muse: 1 identical/);

  // Identical means unmanaged, not owned: dropping the skill must not delete Muse's own copy.
  fs.rmSync(path.join(skillStore(root), 'deploy'), {recursive: true});
  syncSkills(options);
  assert.equal(fs.existsSync(path.join(home, '.agents/skills/deploy/SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.claude/skills/deploy')), false);

  // Editing bounce's copy makes the two genuinely differ, and only then is it a conflict.
  addSkill(root, path.join(home, '.agents/skills/deploy'), {home});
  fs.writeFileSync(path.join(skillStore(root), 'deploy/refs/a.md'), 'two\n');
  assert.equal(syncSkills({...options, providers: ['muse']})[0].action, 'conflict');
});

test('import offers a list to choose from and adopts only what was selected', t => {
  const {root, home, options} = setup(t);
  write(path.join(home, '.agents/skills/deploy'), 'deploy', 'Ship the site');
  write(path.join(home, '.agents/skills/notes'), 'notes', 'Take notes');
  write(path.join(home, '.codex/skills/deploy'), 'deploy', 'Ship the site');
  write(path.join(home, '.codex/skills/imagegen'), 'imagegen', 'Make pictures');
  write(path.join(home, '.claude/skills/broken'), 'broken', 'x');
  fs.writeFileSync(path.join(home, '.claude/skills/broken/SKILL.md'), 'no frontmatter');

  const found = importCandidates(options);
  assert.deepEqual(found.map(r => `${r.provider}:${r.skill}:${r.action}`),
    ['claude:broken:invalid', 'codex:deploy:new', 'codex:imagegen:new', 'muse:notes:new']);
  // The same skill in two agents' directories is offered once, not twice.
  assert.equal(found.filter(r => r.skill === 'deploy').length, 1);
  assert.equal(listSkills(root).length, 0, 'surveying writes nothing');

  const chosen = found.filter(r => ['deploy', 'notes'].includes(r.skill));
  assert.deepEqual(importSelected(root, chosen, {home}).map(r => r.action), ['adopted', 'adopted']);
  assert.deepEqual(listSkills(root).map(s => s.name), ['deploy', 'notes']);

  // Re-surveying marks what the store already has, and it is skipped unless forced.
  const again = importCandidates(options);
  assert.equal(again.find(r => r.skill === 'deploy').action, 'exists');
  assert.deepEqual(importSelected(root, again.filter(r => r.skill === 'deploy'), {home}).map(r => r.action), ['exists']);
  assert.deepEqual(importSelected(root, again.filter(r => r.skill === 'deploy'), {home, force: true}).map(r => r.action), ['adopted']);

  const listing = skillsCommand(['import', '--list'], options).text;
  assert.match(listing, /3 skills available to import/);
  assert.match(listing, /= deploy \(codex\)/);
  assert.match(listing, /\+ imagegen \(codex\)/);
  assert.match(listing, /! broken \(claude\)/);
  assert.equal(listSkills(root).length, 2, '--list still writes nothing');
});

test('reset empties bounce only after confirmation and leaves the agents their own skills', t => {
  const {root, home, options} = setup(t);
  write(path.join(skillStore(root), 'deploy'), 'deploy', 'Ship the site');
  write(path.join(skillStore(root), 'notes'), 'notes', 'Take notes');
  const native = write(path.join(home, '.agents/skills/imagegen'), 'imagegen', 'Muse shipped this one');
  syncSkills(options);
  assert.equal(fs.existsSync(path.join(home, '.claude/skills/deploy')), true);

  // Without --force nothing is deleted; the user is told exactly what would go.
  const warning = skillsCommand(['reset'], options).text;
  assert.match(warning, /Reset deletes all 2 skills/);
  assert.match(warning, /deploy, notes/);
  assert.equal(listSkills(root).length, 2);

  const {text} = skillsCommand(['reset', '--force'], options);
  assert.match(text, /bounce: 2 deleted/);
  assert.match(text, /claude: 2 removed/);
  assert.deepEqual(listSkills(root), []);
  assert.equal(fs.existsSync(skillStore(root)), false);
  for (const dir of ['.claude', '.codex', '.agents']) assert.equal(fs.existsSync(path.join(home, dir, 'skills/deploy')), false);
  assert.equal(fs.existsSync(native), true, "an agent's own skill survives a reset");

  assert.match(skillsCommand(['reset'], options).text, /no skills to delete/);
  assert.deepEqual(resetSkills(options), []);
  assert.throws(() => skillsCommand(['explode'], options), /import, clear or reset/);
});
