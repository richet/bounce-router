// Inline rendering for classic (docs/plans/interactive-polish.md step 7): what is finished goes to the terminal's own
// scrollback once, through Ink's <Static>; only the turn in flight, the prompt and the status line are redrawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import stripAnsi from 'strip-ansi';
import {splitInline} from '../src/tui/inline.js';
import {createInkTerminal} from '../src/tui/ink-terminal.js';

const rows = [
  {kind: 'user', id: 'u1', text: 'first'}, {kind: 'assistant', id: 'a1', text: 'one'}, {kind: 'turn.footer', id: 'f1', text: '1.0 s'},
  {kind: 'user', id: 'u2', text: 'second'}, {kind: 'progress', id: 'p1', text: 'Thinking'}, {kind: 'tool.fold', id: 'k1', text: '2 tool calls'}, {kind: 'delta', id: 'd1', text: 'stre'},
];

test('while a turn runs, everything after its prompt stays live; the prompt and all before it are committed', () => {
  const {committed, live} = splitInline(rows, {busy: true});
  assert.deepEqual(committed.map(row => row.id), ['u1', 'a1', 'f1', 'u2']);
  assert.deepEqual(live.map(row => row.id), ['p1', 'k1', 'd1']);
});

test('idle, every row is committed except live progress, which never reaches the scrollback', () => {
  const {committed, live} = splitInline(rows, {busy: false});
  assert.deepEqual(committed.map(row => row.id), ['u1', 'a1', 'f1', 'u2', 'k1', 'd1']);
  assert.deepEqual(live, []);
});

async function mountInline(t, events) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 24;
  stdout.isTTY = true; // Ink draws live frames only to a terminal
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout, onKeypress() {}});
  await terminal.mount({events, inline: true});
  t.after(() => terminal.unmount());
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  await settle();
  return {terminal, settle, output: () => output, plain: () => stripAnsi(output)};
}

test('an inline view prints history once, outside the alternate screen and without mouse capture', async t => {
  const {terminal, settle, output, plain} = await mountInline(t, [{kind: 'user', id: 'u1', text: 'hello there'}, {kind: 'assistant', id: 'a1', text: 'General Kenobi'}]);
  assert.equal(output().includes('\x1b[?1049h'), false, 'no alternate screen');
  assert.equal(output().includes('\x1b[?1002h'), false, 'no mouse capture: the terminal selects');
  assert.equal(plain().split('General Kenobi').length - 1, 1);
  terminal.update({input: 'typing'}); await settle();
  terminal.update({input: 'typing more'}); await settle();
  assert.equal(plain().split('General Kenobi').length - 1, 1, 'redrawing the prompt does not print history again');
  terminal.update({busy: true});
  terminal.ingest({kind: 'user', id: 'u2', text: 'next question'});
  terminal.ingest({kind: 'delta', id: 'd1', provider: 'claude', text: 'Streaming ans'});
  await settle();
  assert.match(plain(), /Streaming ans/, 'the turn in flight is drawn live');
  assert.deepEqual(terminal.inlineState().printed, ['u1', 'a1', 'u2'], 'the new prompt is committed, the answer in flight is not');
  terminal.ingest({kind: 'assistant', id: 'a2', provider: 'claude', text: 'Streaming answer done.', streamed: true});
  terminal.update({busy: false}); await settle();
  assert.deepEqual(terminal.inlineState().printed, ['u1', 'a1', 'u2', 'a2'], 'the finished answer is committed once, after the turn');
});

// The orchestrator keeps its pane grid on the alternate screen (step 7b, first cut): on quit it leaves what inline
// would have printed — the conversation and one block per task outcome — in the terminal's own scrollback.
async function mountGrid(t, events) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 24;
  stdout.isTTY = true;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout, onKeypress() {}});
  await terminal.mount({events});
  await new Promise(resolve => setTimeout(resolve, 60));
  return {terminal, output: () => output};
}
const orchestration = [
  {kind: 'user', id: 'u1', text: 'fix the parser'}, {kind: 'assistant', id: 'a1', text: 'Sending a builder.'},
  {kind: 'task.submitted', id: 't1', task: 'task-one', profile: 'builder', time: '2026-10-21T00:00:00Z'},
  {kind: 'task.started', id: 't2', task: 'task-one', profile: 'builder', time: '2026-10-21T00:00:01Z'},
  {kind: 'task.activity', id: 't3', task: 'task-one', text: 'editing src/parser.js'},
  {kind: 'task.completed', id: 't4', task: 'task-one', summary: 'Parser handles empty input', time: '2026-10-21T00:00:05Z'},
];

test('quitting the pane grid leaves the conversation and each task outcome in the scrollback, after the alternate screen', async () => {
  const {terminal, output} = await mountGrid(null, orchestration);
  assert.equal(output().includes('\x1b[?1049h'), true, 'the grid runs on the alternate screen');
  terminal.suspend();
  terminal.unmount({scrollback: true});
  assert.equal(output().split('\x1b[?1049l').length - 1, 1, 'the alternate screen is left once, so a second exit cannot move the cursor over the dump');
  const after = stripAnsi(output().slice(output().lastIndexOf('\x1b[?1049l')));
  assert.match(after, /fix the parser/);
  assert.match(after, /Sending a builder\./);
  assert.match(after, /builder · completed · 4\.0s/);
  assert.match(after, /Parser handles empty input/);
  assert.equal(after.includes('editing src/parser.js'), false, 'live worker activity is not an outcome');
  assert.equal(/Message main|BOUNCE/.test(after), false, 'the prompt and the sidebar of the last frame are not printed');
});

test('a plain unmount (a restart into new code) prints nothing after the alternate screen', async () => {
  const {terminal, output} = await mountGrid(null, orchestration);
  terminal.unmount();
  assert.equal(stripAnsi(output().slice(output().lastIndexOf('\x1b[?1049l'))).trim(), '');
});

test('once the view has left the alternate screen, unmounting draws no last frame over the main screen', async () => {
  const {terminal, output} = await mountGrid(null, orchestration);
  terminal.suspend();
  const left = output().length;
  terminal.unmount();
  assert.equal(stripAnsi(output().slice(left)).trim(), '', 'Ink\'s final render on unmount stays off the main screen');
});

// Found in the real-console pass 2026-10-21: quitting inline left the prompt, the notice and the status line on the
// screen, and the cursor where Ink had left it, so the shell (and bounce's own "Resume:" line) wrote over them.
test('leaving an inline view erases its live rows first; the printed history stays', async t => {
  const {terminal, settle, output} = await mountInline(t, [{kind: 'user', id: 'u1', text: 'hello there'}, {kind: 'assistant', id: 'a1', text: 'General Kenobi'}]);
  terminal.update({notice: 'Ctrl+C again to quit'}); await settle();
  const before = output().length;
  terminal.suspend();
  const left = output().slice(before);
  const restore = left.indexOf('\x1b[>4;0m');
  assert.notEqual(restore, -1, 'the keyboard is handed back');
  const erased = left.slice(0, restore);
  assert.equal(erased.split('\x1b[2K').length - 1 >= 4, true, `the live rows are erased before the terminal is handed back: ${JSON.stringify(erased)}`);
  assert.equal(stripAnsi(erased).trim(), '', 'nothing is drawn while leaving');
});
