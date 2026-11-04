import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import fs from 'node:fs';
import {Chalk} from 'chalk';
import {helpText, helpRows, tableRows, TUI_SECTIONS, CLI_SECTIONS, CLI_OPTIONS, KEYS} from '../src/help.js';
import {commands} from '../src/terminal.js';
import {createFormatter} from '../src/format.js';

const widest = rows => Math.max(...rows.map(row => stringWidth(row)));

test('every picker command is documented, and the help is one source for both surfaces', () => {
  const documented = new Set(TUI_SECTIONS.flatMap(section => section.rows.map(([name]) => name.split(' ')[0].slice(1))));
  for (const [name] of commands) assert.ok(documented.has(name), `/${name} is in the picker but not in /help`);
  const tui = helpRows({tui: true}).join('\n');
  assert.ok(tui.indexOf('Agents & models') < tui.indexOf('Command line'), '/help leads with slash commands');
  assert.match(tui, /bounce skill install/, '/help still lists the command line');
  assert.doesNotMatch(tui, /one terminal/, 'the transcript block already carries the label');
});

test('bounce --help reads like ace --help: usage, titled groups, one description column, options', () => {
  const text = helpText();
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 5), [
    'bounce — one terminal, your coding agents',
    '',
    'Usage: bounce [options]                     Open the interactive view',
    '       bounce <command> [options]           Run one command',
    '',
  ]);
  assert.doesNotMatch(text, /\x1b/);
  assert.doesNotMatch(text, /Agents & models|Ctrl\+C/, 'slash commands and keys stay in /help');
  assert.deepEqual(lines.filter(line => /^\S.*:$/.test(line)), ['Sessions:', 'Agents and models:', 'Local models:', 'Skills:', 'MCP:', 'Bridge (workers and scripts):', 'Maintenance:', 'Options:']);
  assert.ok(lines.includes('  skill install                             Teach your own agents to set up and run bounce'));
  assert.ok(lines.includes('  stats [session] [--tasks] [--against <session>]'));
  assert.equal(lines[lines.indexOf('  stats [session] [--tasks] [--against <session>]') + 1], ' '.repeat(44) + 'What a session cost and got', 'a wide label puts its description under the column');
  for (const line of lines) {
    const row = line.match(/^ {2}\S.*?\S {2,}(\S.*)$/);
    if (row) assert.equal(line.indexOf(row[1]), 44, `description off the column: ${line}`);
  }
  const wide = helpText(400);
  for (const [name, hint, description] of [...CLI_SECTIONS.flatMap(section => section.rows), ...CLI_OPTIONS]) {
    assert.ok(wide.includes(hint ? `${name} ${hint}` : name), `${name} missing`);
    assert.ok(wide.includes(description), `${name}: description missing`);
  }
  for (const width of [40, 60, 80, 100]) assert.ok(widest(helpText(width).split('\n')) <= Math.max(width, 44 + 20), `width ${width}`);
});

test('every command the CLI accepts is in bounce --help', () => {
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const accepted = new Set([...cli.matchAll(/positionals\[0\] === '([a-z-]+)'/g)].map(match => match[1]));
  accepted.delete('typesafe'); // the old name of jev
  const documented = new Set(CLI_SECTIONS.flatMap(section => section.rows.map(([name]) => name.split(' ')[0])));
  for (const command of accepted) assert.ok(documented.has(command), `bounce ${command} is accepted but not in --help`);
});

test('descriptions share one column and wrap under themselves, never back under the label', () => {
  const rows = tableRows([['/short', '', 'A description that is long enough to wrap around'], ['/longer', 'ARG', 'Second']], {width: 44});
  assert.deepEqual(rows, [
    '  /short       A description that is long',
    '               enough to wrap around',
    '  /longer ARG  Second',
  ]);
  const column = rows[0].indexOf('A description');
  assert.equal(rows[2].indexOf('Second'), column);
  assert.ok(widest(rows) <= 44);
});

test('a label too wide for the column stands alone with its description beneath it', () => {
  const rows = tableRows([['/x', '', 'Fits'], ['/model worker', 'PROFILE [auto|endpoint/model|refresh] [--save]', 'Own line']], {width: 80});
  assert.deepEqual(rows, ['  /x  Fits', '  /model worker PROFILE [auto|endpoint/model|refresh] [--save]', '    Own line']);
});

test('a narrow pane stacks every description under its label and still never overflows', () => {
  for (const width of [30, 40, 63, 85, 120]) {
    const rows = helpRows({width, tui: true, vendor: [['commit', 'Create a commit (claude)', '[MESSAGE]']]});
    assert.ok(widest(rows) <= width, `width ${width}: a row is ${widest(rows)} wide`);
    assert.ok(rows.some(row => row.includes('/commit [MESSAGE]')), 'agents\' own commands are listed with their hint');
  }
  const stacked = tableRows([['/provider', 'NAME', 'Select and save the default agent']], {width: 30});
  assert.deepEqual(stacked, ['  /provider NAME', '    Select and save the', '    default agent']);
});

test('the transcript paints a help block: headed, commands cyan, hints and notes muted', () => {
  const color = createFormatter({color: true, compact: true});
  const rows = color.event({kind: 'help', vendor: [['commit', 'Create a commit (claude)', '']]}, 90);
  assert.equal(stripAnsi(rows[0]), 'Bounce · Help');
  assert.match(rows[0], /\x1b\[1m\x1b\[36m/);
  assert.match(rows.join('\n'), /\x1b\[36m\/provider\x1b\[39m \x1b\[90mNAME\x1b\[39m/);
  assert.match(rows.join('\n'), /\x1b\[33mCtrl\+C\x1b\[39m/);
  assert.match(stripAnsi(rows.join('\n')), /Commands your agents keep here\n  Expanded by bounce/);
  assert.equal(rows.at(-1), '', 'a blank row separates the block from what follows');
  assert.ok(rows.slice(1).every(row => row === '' || row.startsWith('  ')), 'the body sits under the label');
  const plain = createFormatter({color: false}).event({kind: 'help'}, 90);
  assert.doesNotMatch(plain.join('\n'), /\x1b/);
  assert.ok(widest(plain) <= 90);
});

test('bounce --help on a terminal is painted like /help, and colour never moves a column', () => {
  const c = new Chalk({level: 1});
  const paint = {title: c.bold.cyan, name: c.cyan, hint: c.gray, muted: c.gray, key: c.yellow};
  for (const width of [60, 100]) assert.equal(stripAnsi(helpText(width, paint)), helpText(width));
  const painted = helpText(100, paint).split('\n');
  assert.equal(painted.find(line => stripAnsi(line) === 'Skills:'), c.bold.cyan('Skills:'));
  assert.ok(painted.includes('  ' + c.cyan('skill install') + ' '.repeat(29) + 'Teach your own agents to set up and run bounce'));
  assert.ok(painted.some(line => line.startsWith('  ' + c.yellow('--json'))), 'options are yellow');
  assert.ok(painted.some(line => line.startsWith(c.bold.cyan('Usage: ') + c.cyan('bounce') + c.gray(' [options]'))));
});
