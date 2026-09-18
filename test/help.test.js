import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {helpText, helpRows, tableRows, TUI_SECTIONS, CLI_USAGE, KEYS} from '../src/help.js';
import {commands} from '../src/terminal.js';
import {createFormatter} from '../src/format.js';

const widest = rows => Math.max(...rows.map(row => stringWidth(row)));

test('every picker command is documented, and the help is one source for both surfaces', () => {
  const documented = new Set(TUI_SECTIONS.flatMap(section => section.rows.map(([name]) => name.split(' ')[0].slice(1))));
  for (const [name] of commands) assert.ok(documented.has(name), `/${name} is in the picker but not in /help`);
  const text = helpText();
  assert.match(text, /^bounce — one terminal, your coding agents\n\nCommand line\n/);
  assert.doesNotMatch(text, /\x1b/);
  assert.ok(text.indexOf('Command line') < text.indexOf('Agents & models'), '--help leads with usage');
  const tui = helpRows({tui: true}).join('\n');
  assert.ok(tui.indexOf('Agents & models') < tui.indexOf('Command line'), '/help leads with slash commands');
  assert.doesNotMatch(tui, /one terminal/, 'the transcript block already carries the label');
  const wide = helpText(400);
  for (const [name, hint] of [...CLI_USAGE, ...KEYS]) assert.ok(wide.includes(hint ? `${name} ${hint}` : name), `${name} missing`);
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
