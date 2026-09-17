import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {skillMetadata, skillDir, skillStore, skillHash, listSkills, syncSkills, inspectSkills, addSkill, newSkill, importSkills, importCandidates, importSelected, clearSkills, resetSkills, skillsCommand, skillsChanged, seedSkills} from '../src/skills.js';
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

test('import sees a workspace\'s own .claude/skills as well as the home area, whatever scope sync installs into', t => {
  const {root, home, cwd, options} = setup(t);
  write(path.join(home, '.claude/skills/hop'), 'hop', 'Drive the dev platform');
  write(path.join(cwd, '.claude/skills/bunny-billing'), 'bunny-billing', 'Integrate billing');
  write(path.join(cwd, '.codex/skills/broken'), 'broken', 'x');
  fs.writeFileSync(path.join(cwd, '.codex/skills/broken/SKILL.md'), 'no frontmatter');
  // The same skill in the workspace and at home is offered once, from the workspace, since
  // that is the copy the vendor lets shadow the other.
  write(path.join(home, '.codex/skills/deploy'), 'deploy', 'Ship the site (home)');
  write(path.join(cwd, '.codex/skills/deploy'), 'deploy', 'Ship the site (work)');

  // The default scope is user; a project skill still shows, labelled with where it came from.
  const found = importCandidates({...options, scope: 'user'});
  assert.deepEqual(found.filter(r => r.skill).map(r => `${r.provider}:${r.scope}:${r.skill}:${r.action}`),
    ['claude:project:bunny-billing:new', 'claude:user:hop:new', 'codex:project:broken:invalid', 'codex:project:deploy:new']);
  assert.equal(found.find(r => r.skill === 'deploy').description, 'Ship the site (work)');
  const listing = skillsCommand(['import', '--list'], {...options, scope: 'user'}).text;
  assert.match(listing, /\+ bunny-billing \(claude · project\)/);
  assert.match(listing, /\+ hop \(claude\)/);
  assert.match(listing, /! broken \(codex · project\)/);

  // Adopting it installs it wherever sync is pointed; the workspace original is not touched.
  const report = importSkills({...options, scope: 'user'});
  assert.equal(report.find(r => r.skill === 'bunny-billing').action, 'adopted');
  syncSkills({...options, scope: 'user'});
  assert.equal(fs.existsSync(path.join(home, '.codex/skills/bunny-billing/SKILL.md')), true);
  assert.equal(fs.readFileSync(path.join(cwd, '.claude/skills/bunny-billing/SKILL.md'), 'utf8').includes('Integrate billing'), true);
  assert.equal(fs.existsSync(path.join(cwd, '.claude/skills/bunny-billing/.bounce-skill.json')), false, 'the native copy gains no marker');

  // With no workspace at all, only the home area is surveyed; a provider missing both says so.
  const homeOnly = importCandidates({root, home, env: {}});
  assert.equal(homeOnly.some(r => r.scope === 'project'), false);
  fs.rmSync(path.join(home, '.agents'), {recursive: true, force: true});
  const absent = importCandidates({...options, providers: ['muse']});
  assert.equal(absent[0].action, 'absent');
  assert.match(absent[0].detail, /\.agents\/skills and .*\.agents\/skills do not exist/);
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

test('seeding ships the bundled agent-orchestrator skill and leaves the user\'s own alone', t => {
  const {root, home, options} = setup(t);

  const first = seedSkills({root});
  assert.deepEqual(first, [{skill: 'agent-orchestrator', action: 'installed'}]);
  const target = path.join(skillStore(root), 'agent-orchestrator');
  assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(target, 'references/bounce.md')), true);
  assert.equal(skillMetadata(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).name, 'agent-orchestrator');

  // Unchanged bundled source writes nothing on a second pass.
  const hashBefore = skillHash(target);
  const mtimeBefore = fs.statSync(path.join(target, 'SKILL.md')).mtimeMs;
  assert.deepEqual(seedSkills({root}), [{skill: 'agent-orchestrator', action: 'current'}]);
  assert.equal(skillHash(target), hashBefore);
  assert.equal(fs.statSync(path.join(target, 'SKILL.md')).mtimeMs, mtimeBefore);

  // A pre-existing store skill of the same name, with no bounce marker, is the user's own.
  fs.rmSync(target, {recursive: true, force: true});
  write(target, 'agent-orchestrator', 'Hand-written by the user');
  const bytesBefore = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
  assert.deepEqual(seedSkills({root}), [{skill: 'agent-orchestrator', action: 'unmanaged'}]);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), bytesBefore);

  // A seeded copy the user then edits is reported modified, and the edit is never clobbered.
  fs.rmSync(target, {recursive: true, force: true});
  seedSkills({root});
  fs.appendFileSync(path.join(target, 'SKILL.md'), '\nA user note.\n');
  assert.deepEqual(seedSkills({root}), [{skill: 'agent-orchestrator', action: 'modified'}]);
  assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /A user note\./);

  // The seeded copy is a first-class store skill: sync reaches it like any other.
  const synced = syncSkills(options);
  assert.equal(synced.some(r => r.skill === 'agent-orchestrator' && r.action === 'installed'), true);
  assert.equal(fs.existsSync(path.join(home, '.claude/skills/agent-orchestrator/SKILL.md')), true);
});

test('seeding upgrades an untouched seeded copy but yields to the user once they have edited it', t => {
  const {base, root} = setup(t);
  const bundled = path.join(base, 'bundled');
  const source = path.join(bundled, 'demo-skill');
  write(source, 'demo-skill', 'A bundled skill', {'references/notes.md': 'one\n'});
  const target = path.join(skillStore(root), 'demo-skill');

  assert.deepEqual(seedSkills({root, bundled}), [{skill: 'demo-skill', action: 'installed'}]);
  assert.equal(fs.readFileSync(path.join(target, 'references/notes.md'), 'utf8'), 'one\n');

  // bounce ships a new version and the seeded copy is untouched: it is replaced.
  fs.writeFileSync(path.join(source, 'references/notes.md'), 'two\n');
  assert.deepEqual(seedSkills({root, bundled}), [{skill: 'demo-skill', action: 'updated'}]);
  assert.equal(fs.readFileSync(path.join(target, 'references/notes.md'), 'utf8'), 'two\n');
  assert.deepEqual(seedSkills({root, bundled}), [{skill: 'demo-skill', action: 'current'}]);

  // The same upgrade against a copy the user has edited leaves their version in place.
  fs.appendFileSync(path.join(target, 'references/notes.md'), 'and mine\n');
  fs.writeFileSync(path.join(source, 'references/notes.md'), 'three\n');
  assert.deepEqual(seedSkills({root, bundled}), [{skill: 'demo-skill', action: 'modified'}]);
  assert.equal(fs.readFileSync(path.join(target, 'references/notes.md'), 'utf8'), 'two\nand mine\n');
});

test('seeding is a no-op for an absent bundled directory or an empty bundled skills store', t => {
  const {root} = setup(t);
  assert.deepEqual(seedSkills({root, bundled: path.join(root, 'no-such-dir')}), []);
  assert.deepEqual(seedSkills({root, bundled: fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-empty-'))}), []);
});
