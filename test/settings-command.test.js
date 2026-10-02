// /config (Daniel, 2026-10-01): settings seen and changed from the TUI; the file keeps only what the user set;
// a wrong value is refused with the loader's own words; each line says whether it applies now or next session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configCommand, parseValue, settingsEntries, nextValue, filterEntries} from '../src/settings-command.js';
import {config} from '../src/core.js';

const home = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-config-')); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return root; };

test('values typed at the prompt read as what they are', () => {
  assert.deepEqual(['true', '20', '0.9', 'plain', 'codex,claude', '["a","b"]', '{"x":1}', ''].map(parseValue), [true, 20, 0.9, 'plain', ['codex', 'claude'], ['a', 'b'], {x: 1}, undefined]);
});

test('/config lists every setting with its value, whether it is a default, and when a change applies', t => {
  const root = home(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({order: ['codex', 'claude'], sweepMinutes: 5}));
  const {text} = configCommand([], {root, settings: config(root)});
  assert.match(text, /^Settings \(.*config\.json; what the file does not set is a default\):/);
  assert.match(text, /\n  order = \["codex","claude"\] · provider order .* · applies now/);
  assert.match(text, /\n  sweepMinutes = 5 · quiet minutes with held work .* · applies next session/);
  assert.match(text, /\n  taskMinutes = 15 \(default\) · /);
  assert.match(text, /\n  jev\.confidence = 0\.8 \(default\) · /);
});

test('/config key value saves only that key, validated like the loader, and says when it applies', t => {
  const root = home(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({order: ['codex', 'claude']}));
  const settings = config(root);
  const set = configCommand(['sweepMinutes', '30'], {root, settings});
  assert.equal(set.text, `sweepMinutes = 30 · saved to ${path.join(root, 'config.json')} · applies next session (restart the session: bounce stop <id>, then bounce --resume <id>)`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')), {order: ['codex', 'claude'], sweepMinutes: 30});
  assert.equal(settings.sweepMinutes, undefined, 'a next-session setting is not pushed into the live object');

  const now = configCommand(['sidebar', 'false'], {root, settings});
  assert.match(now.text, /^sidebar = false · saved to .* · applies now$/);
  assert.equal(settings.sidebar, false, 'a setting that applies now is in the live object too');

  const nested = configCommand(['jev.confidence', '0.7'], {root, settings});
  assert.match(nested.text, /^jev\.confidence = 0\.7 · saved/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).jev, {confidence: 0.7});

  assert.throws(() => configCommand(['sweepMinutes', '500'], {root, settings}), /sweepMinutes must be a whole number of minutes from 0 \(off\) to 240/);
  assert.throws(() => configCommand(['reports', 'loud'], {root, settings}), /reports must be "plain" or "structured"/);
  assert.throws(() => configCommand(['jev.confidence', '2'], {root, settings}), /confidence/);
  assert.throws(() => configCommand(['profiles.main', '{"adapter":"codex"}'], {root, settings}), /managed elsewhere/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).sweepMinutes, 30, 'a refused value changes nothing');

  const unset = configCommand(['unset', 'jev.confidence'], {root, settings});
  assert.match(unset.text, /^jev\.confidence = 0\.8 \(default\) · saved/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).jev, undefined, 'an emptied block leaves no {} behind');
  assert.doesNotThrow(() => config(root), 'the file the command wrote loads');
});

// Daniel, 2026-10-01: "/config lists it but fails to be interactive in the way other harnesses are". The panel's
// rows and what Enter does on each come from here; the TUI only moves the cursor and shows the lines.
test('the panel rows carry value and provenance, and Enter flips a boolean, cycles a choice, and types the rest', t => {
  const root = home(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({mode: 'plan', sidebar: false}));
  const entries = settingsEntries(root);
  const by = Object.fromEntries(entries.map(e => [e.key, e]));
  assert.equal(by.mode.label, 'mode = "plan" · yolo or plan (also /mode) · applies now');
  assert.equal(by.reports.label, 'reports = "plain" (default) · how a worker ends: plain (an answer in its own words) or structured (the fixed report) · applies next session');
  assert.deepEqual([by.sidebar.set, by.reports.set], [true, false]);
  assert.equal(nextValue(by.sidebar), 'true');
  assert.equal(nextValue(by.mode), 'yolo');
  assert.equal(nextValue(by.reports), 'structured');
  assert.equal(nextValue(by.sweepMinutes), null, 'a number is typed');
  assert.equal(nextValue(by.order), null, 'a list is typed');
});

// Daniel, 2026-10-01: filter the options as you type, and explain what each does.
test('every setting has an explanation, and typing filters the rows by key or by what they do', t => {
  const root = home(t);
  const entries = settingsEntries(root);
  for (const entry of entries) assert.equal(typeof entry.meta.help === 'string' && entry.meta.help.length > 40, true, `${entry.key} needs a help sentence`);
  assert.deepEqual(filterEntries(entries, 'jev').map(e => e.key), ['jev.enabled', 'jev.review', 'jev.routing', 'jev.confidence', 'jev.sendBackConfidence']);
  assert.deepEqual(filterEntries(entries, 'QUOTA').map(e => e.key), ['cooldownMinutes'], 'a word from what it does matches too');
  assert.equal(filterEntries(entries, '').length, entries.length);
  assert.deepEqual(filterEntries(entries, 'zzz'), []);
});
