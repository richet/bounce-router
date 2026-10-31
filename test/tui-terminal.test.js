import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import stripAnsi from 'strip-ansi';
import {createInkTerminal} from '../src/tui/ink-terminal.js';

test('Ink terminal controller exposes incremental state and preserves externally-owned view fields', () => {
  const terminal = createInkTerminal({onKeypress() {}});
  terminal.update({agentsOpen: true, selectedId: 'worker:a', input: 'draft', scroll: 3, notice: 'ready'});
  terminal.ingest({kind: 'task.submitted', id: '1', seq: 1, task: 'a', profile: 'build'});
  assert.deepEqual(terminal.paneIds(), ['orchestrator', 'worker:a']);
  assert.equal(terminal.snapshot().view.input, 'draft');
  assert.equal(terminal.snapshot().view.scroll, 3);
  terminal.unmount();
});

test('controller reset replaces projected history for classic /new without replacing the controller', () => {
  const terminal = createInkTerminal();
  terminal.ingest({kind: 'task.submitted', id: 'old-task', seq: 1, task: 'old', profile: 'worker'});
  terminal.reset([{kind: 'note', id: 'new-note', seq: 1, text: 'new session'}]);
  assert.deepEqual(terminal.paneIds(), ['orchestrator']);
  assert.deepEqual(terminal.snapshot().transcript.map(event => event.text), ['new session']);
  terminal.unmount();
});

test('scrolling loads durable history beyond the bounded live projection', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 12;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const events = Array.from({length: 10}, (_, n) => ({kind: 'note', id: String(n), text: `history-${n}`}));
  const terminal = createInkTerminal({stdin, stdout, history: () => events, projectionOptions: {transcriptLimit: 2}});
  await terminal.mount({events});
  output = '';
  terminal.update({scroll: 5});
  await new Promise(resolve => setTimeout(resolve, 60));
  terminal.unmount();
  assert.match(stripAnsi(output), /history-0/);
});

test('Ink terminal mounts a real full-screen frame and restores terminal mode on exit', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80;
  stdout.rows = 24;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout, onKeypress() {}});
  await terminal.mount({agentsOpen: true, input: 'hello', events: [
    {kind: 'task.submitted', id: '1', seq: 1, task: 'worker-one', profile: 'build'},
  ]});
  await new Promise(resolve => setTimeout(resolve, 20));
  terminal.unmount();
  assert.match(output, /orchestrator/);
  assert.match(output, /worker-o/);
  assert.match(output, /\x1b\[\?1049l/, 'alternate screen is restored');
});

test('real Ink workspace shows the orchestrator transcript inside its pane', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 18;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount({agentsOpen: true, events: [
    {kind: 'assistant', id: 'root-1', seq: 1, text: 'orchestrator transcript evidence'},
  ]});
  await new Promise(resolve => setTimeout(resolve, 40));
  terminal.unmount();
  assert.match(output, /orchestrator transcript evidence/);
});

test('real Ink orchestrator pane renders structured main progress', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 18;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount({agentsOpen: true, now: Date.parse('2026-09-14T00:01:00.000Z'), main: {
    state: 'working', phase: 'coordinate', text: 'reviewing reports', next: 'integrate',
    operation: 'waiting for worker', evidence: ['review.log'], updatedAt: '2026-09-14T00:00:30.000Z',
  }});
  await new Promise(resolve => setTimeout(resolve, 40));
  terminal.unmount();
  assert.match(output, /phase: coordinate/);
  assert.match(output, /reviewing reports · next: integrate/);
  assert.match(output, /evidence: review\.log/);
  assert.match(output, /updated: 30s ago/);
});

test('real Ink frame reflects events ingested after mount', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 18;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount({agentsOpen: true, selectedId: 'worker:build', events: [
    {kind: 'task.submitted', id: '1', seq: 1, task: 'build', profile: 'worker'},
  ]});
  terminal.ingest({kind: 'task.activity', id: '2', seq: 2, task: 'build', text: 'post-mount operation'});
  await new Promise(resolve => setTimeout(resolve, 60));
  terminal.unmount();
  assert.match(output, /post-mount operation/);
});

test('real Ink frame keeps quota beside the transcript and budgets only menu/input rows below', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 100; stdout.rows = 12;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount({
    menu: ['menu one', 'menu two'],
    metadata: {quotaLines: ['quota one', 'quota two']},
    notice: 'notice',
    events: Array.from({length: 10}, (_, index) => ({kind: 'note', id: String(index), seq: index, text: `budget-row-${index}`})),
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  terminal.unmount();
  assert.match(output, /budget-row-4/);
  assert.doesNotMatch(output, /budget-row-3/);
  assert.match(output, /menu one/);
  assert.match(output, /quota two/);
});

test('real Ink three-pane frame keeps the right-bottom worker inside the viewport', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 20;
  const frames = [];
  stdout.on('data', chunk => {
    const text = stripAnsi(String(chunk));
    if (text.includes(' main ·')) frames.push(text); // the main worker's status line, under the prompt since 2026-10-01
  });
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount({agentsOpen: true, events: [
    {kind: 'task.submitted', id: '1', seq: 1, task: 'worker-one', profile: 'build'},
    {kind: 'task.submitted', id: '2', seq: 2, task: 'worker-two', profile: 'review'},
  ]});
  await new Promise(resolve => setTimeout(resolve, 40));
  terminal.unmount();
  const lines = frames.at(-1)?.split('\n') ?? [];
  const bottomWorkerLine = lines.findIndex(line => line.includes('review · worker-t'));
  assert.match(frames.at(-1) ?? '', /review · worker-t/, 'right-bottom pane is rendered');
  assert.ok(bottomWorkerLine < stdout.rows, `right-bottom pane row ${bottomWorkerLine} exceeds viewport ${stdout.rows}`);
});

test('real Ink five-pane frame reserves and renders the overflow notice', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 20;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount({agentsOpen: true, events: Array.from({length: 4}, (_, index) => ({
    kind: 'task.submitted', id: String(index), seq: index, task: `worker-${index}`, profile: 'build',
  }))});
  await new Promise(resolve => setTimeout(resolve, 40));
  terminal.unmount();
  assert.match(stripAnsi(output), /\+ 1 more agents · Tab cycles/);
});

test('real Ink worker pane applies selected-pane scroll and shows progress evidence and freshness', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 58; stdout.rows = 16;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const events = [
    {kind: 'task.submitted', id: '1', seq: 1, task: 'build', profile: 'worker'},
    {kind: 'task.started', id: '2', seq: 2, task: 'build', requested: 'gpt'},
    {kind: 'task.milestone', id: '3', seq: 3, time: '2026-09-14T00:00:00.000Z', task: 'build', phase: 'verify', text: 'milestone text', next: 'review', evidence: ['test.log']},
    ...Array.from({length: 12}, (_, index) => ({kind: 'task.activity', id: `a-${index}`, seq: 4 + index, time: `2026-09-14T00:00:${String(index + 1).padStart(2, '0')}.000Z`, task: 'build', text: `operation-${index}`})),
  ];
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount({agentsOpen: true, selectedId: 'worker:build', scroll: 4, now: Date.parse('2026-09-14T00:01:00.000Z'), events});
  await new Promise(resolve => setTimeout(resolve, 40));
  terminal.unmount();
  assert.match(output, /phase: verify/);
  assert.match(output, /evidence: test\.log/);
  assert.match(output, /updated: 1m ago/);
  assert.match(output, /operation-7/);
  assert.match(output, /operation: operation-11/);
  assert.doesNotMatch(output, /│ operation-10/);
});

test('keypress acknowledgement is measured at a completed real Ink frame', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 16;
  let terminal;
  let rendered = false;
  let input = '';
  const frame = new Promise(resolve => {
    terminal = createInkTerminal({stdin, stdout,
      onKeypress: str => { input += str; terminal.update({input, notice: 'command acknowledged'}); },
      onFrame: () => { if (input === 'x') { rendered = true; resolve(); } },
    });
  });
  stdout.on('data', () => {});
  await terminal.mount();
  stdin.write('x');
  await Promise.race([frame, new Promise((_, reject) => setTimeout(() => reject(new Error('frame did not complete')), 200))]);
  terminal.unmount();
  assert.equal(rendered, true);
});

test('terminal decodes normal keys, modified Enter, split paste, and resize without replaying input while suspended', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 24;
  const keys = []; const pastes = []; const sizes = [];
  const terminal = createInkTerminal({stdin, stdout, onKeypress: (str, key) => keys.push([str, key?.name, Boolean(key?.meta)]), onPaste: text => pastes.push(text), onResize: size => sizes.push(size)});
  await terminal.mount();
  stdin.write('\t\x1b[A\x7f\x03\x1b[13;2u');
  stdin.write('\x1b[200~hello'); stdin.write(' world\x1b[201~');
  await new Promise(resolve => setTimeout(resolve, 60));
  stdout.columns = 100; stdout.rows = 30; stdout.emit('resize');
  terminal.suspend(); stdin.write('x'); await new Promise(resolve => setTimeout(resolve, 60));
  terminal.unmount();
  assert.deepEqual(keys.map(key => key[1]), ['tab', 'up', 'backspace', 'c', 'return']);
  assert.equal(keys.at(-1)[2], true, 'modified enter stays distinct from submit');
  assert.deepEqual(pastes, ['hello world']);
  assert.deepEqual(sizes, [{columns: 100, rows: 30}]);
});

test('stdout backpressure coalesces frames until drain, then renders the latest view', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 24;
  const write = stdout.write.bind(stdout);
  let blocked = false;
  stdout.write = chunk => { write(chunk); return !blocked; };
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount();
  blocked = true;
  terminal.write('blocked frame');
  assert.equal(terminal.debugState().outputBlocked, true);
  terminal.update({notice: 'latest'});
  const beforeDrain = terminal.debugState().renderCount;
  blocked = false; stdout.emit('drain');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(terminal.debugState().outputBlocked, false);
  assert.ok(terminal.debugState().renderCount > beforeDrain, 'drain schedules one current frame');
  terminal.unmount();
});
test('unchanged mouse setting does not flood the terminal with mode escapes', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 80; stdout.rows = 24;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount();
  output = '';
  for (let i = 0; i < 100; i++) terminal.update({mouseScroll: false});
  assert.equal(output.includes('\x1b[?1000l'), false);
  terminal.unmount();
});

test('scrolling past the beginning keeps the oldest transcript visible', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.isTTY = true; stdout.columns = 80; stdout.rows = 12;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const events = Array.from({length: 10}, (_, n) => ({kind: 'note', id: String(n), text: `scroll-boundary-${n}`}));
  const terminal = createInkTerminal({stdin, stdout, history: () => events,
    onScroll: amount => terminal.update({scroll: Math.max(0, terminal.snapshot().view.scroll + amount)}),
  });
  try {
    await terminal.mount({events});
    await new Promise(resolve => setTimeout(resolve, 60));
    output = '';
    stdin.write('\x1b[<64;10;5M'.repeat(34));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(stripAnsi(output), /scroll-boundary-0/);
    assert.equal(terminal.snapshot().view.scroll, 2);
    output = '';
    stdin.write('\x1b[<65;10;5M');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(stripAnsi(output), /scroll-boundary-9/);
    assert.doesNotMatch(stripAnsi(output), /scroll-boundary-0/);
  } finally { terminal.unmount(); }
});

test('a wheel step in a short worker pane preserves its activity and resets its stored offset', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.isTTY = true; stdout.columns = 58; stdout.rows = 16;
  let output = '';
  const clamps = [];
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout, onScrollClamp: (id, value) => clamps.push([id, value])});
  try {
    await terminal.mount({agentsOpen: true, selectedId: 'worker:a', events: [
      {kind: 'task.submitted', id: '1', seq: 1, task: 'a', profile: 'scout'},
      {kind: 'task.activity', id: '2', seq: 2, task: 'a', text: 'worker activity remains visible'},
    ]});
    await new Promise(resolve => setTimeout(resolve, 60));
    terminal.update({scroll: 3, paneScrolls: {'worker:a': 3}, notice: 'scroll boundary'});
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(stripAnsi(output), /worker activity remains visible/);
    assert.equal(terminal.snapshot().view.scroll, 0);
    assert.equal(terminal.snapshot().view.paneScrolls['worker:a'], 0);
    assert.deepEqual(clamps, [['worker:a', 0]]);
  } finally { terminal.unmount(); }
});

test('live output does not move the history being read while scrolled up', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.isTTY = true; stdout.columns = 80; stdout.rows = 12;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const events = Array.from({length: 24}, (_, n) => ({kind: 'note', id: String(n), text: `anchored-history-${n}`}));
  const terminal = createInkTerminal({stdin, stdout, history: () => events});
  const visible = () => [...stripAnsi(output).matchAll(/anchored-history-\d+/g)].map(match => match[0]);
  try {
    await terminal.mount({events});
    await new Promise(resolve => setTimeout(resolve, 60));
    output = '';
    terminal.update({scroll: 4});
    await new Promise(resolve => setTimeout(resolve, 60));
    const before = visible();
    assert.deepEqual(before, Array.from({length: 8}, (_, n) => `anchored-history-${n + 12}`));
    output = '';
    for (let n = 24; n < 28; n++) {
      const event = {kind: 'note', id: String(n), text: `anchored-history-${n}`};
      events.push(event); terminal.ingest(event);
    }
    terminal.update({notice: 'new output arrived'});
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(visible(), before);
    output = '';
    terminal.update({scroll: 0});
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(stripAnsi(output), /anchored-history-27/);
  } finally { terminal.unmount(); }
});

test('worker scrollback stays put during activity and returns to live output at the bottom', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.isTTY = true; stdout.columns = 58; stdout.rows = 16;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout});
  const visible = () => [...stripAnsi(output).matchAll(/worker-history-\d+/g)].map(match => match[0]);
  try {
    await terminal.mount({agentsOpen: true, selectedId: 'worker:a', events: [
      {kind: 'task.submitted', id: 's', seq: 1, task: 'a', profile: 'scout'},
      ...Array.from({length: 24}, (_, n) => ({kind: 'task.activity', id: `a${n}`, seq: n + 2, task: 'a', text: `worker-history-${n}`})),
    ]});
    await new Promise(resolve => setTimeout(resolve, 60));
    output = '';
    terminal.update({scroll: 4});
    await new Promise(resolve => setTimeout(resolve, 60));
    const before = visible();
    // The operation heading stays live; the scrollable activity rows stay anchored.
    assert.deepEqual(before.slice(1), Array.from({length: 6}, (_, n) => `worker-history-${n + 14}`));
    output = '';
    terminal.ingest({kind: 'task.activity', id: 'new', seq: 26, task: 'a', text: 'worker-history-24'});
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(visible().slice(1), before.slice(1));
    assert.equal(visible()[0], 'worker-history-24');
    output = '';
    terminal.update({scroll: 0});
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(visible().at(-1), 'worker-history-24');
  } finally { terminal.unmount(); }
});

// Drag selects inside the region it started in, release copies.
async function mountedForSelection(t, initial, options = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 120; stdout.rows = 20;
  stdout.on('data', () => {});
  const copied = [], scrolled = [];
  const terminal = createInkTerminal({stdin, stdout, onKeypress() {}, onCopy: text => copied.push(text), onScroll: (amount, region) => scrolled.push([amount, region]), ...options});
  await terminal.mount(initial);
  t.after(() => terminal.unmount());
  await new Promise(resolve => setTimeout(resolve, 60));
  // The 1-based cell of `word` in the region that shows it.
  const cellOf = word => {
    for (const region of terminal.regions()) {
      const shown = region.visible ?? region.rows.map((_, index) => index).slice(0, region.height);
      const line = shown.findIndex(row => stripAnsi(String(region.rows[row])).includes(word));
      if (line >= 0) return {region: region.id, x: region.x + stripAnsi(String(region.rows[shown[line]])).indexOf(word) + 1, y: region.y + line + 1};
    }
    return null;
  };
  const send = sequence => new Promise(resolve => { stdin.write(sequence); setTimeout(resolve, 80); });
  return {terminal, copied, scrolled, cellOf, send};
}

test('a drag across a transcript row copies the words under it on release, and the highlight shows them', async t => {
  const {terminal, copied, cellOf, send} = await mountedForSelection(t, {events: [{kind: 'note', id: 'n1', text: 'alpha beta gamma delta'}]});
  const start = cellOf('beta');
  assert.ok(start, 'the note is drawn in a region');
  await send(`\x1b[<0;${start.x};${start.y}M\x1b[<32;${start.x + 4};${start.y}M`);
  assert.equal(terminal.snapshot().view.selection.region, start.region);
  assert.deepEqual(copied, [], 'nothing is copied while the button is down');
  await send(`\x1b[<32;${start.x + 10};${start.y}M\x1b[<0;${start.x + 10};${start.y}m`);
  assert.deepEqual(copied, ['beta gamma']);
  assert.ok(terminal.snapshot().view.selection, 'the selection stays shown after the copy');
  await send('x');
  assert.equal(terminal.snapshot().view.selection, null, 'a key clears it');
});

test('a double-click copies the word; a plain click copies nothing and clears the selection', async t => {
  const {copied, cellOf, send} = await mountedForSelection(t, {events: [{kind: 'note', id: 'n1', text: 'open src/tui/selection.js:12 now'}]});
  const at = cellOf('selection.js');
  await send(`\x1b[<0;${at.x};${at.y}M\x1b[<0;${at.x};${at.y}m\x1b[<0;${at.x};${at.y}M\x1b[<0;${at.x};${at.y}m`);
  assert.deepEqual(copied, ['src/tui/selection.js:12']);
  await new Promise(resolve => setTimeout(resolve, 450));
  await send(`\x1b[<0;${at.x};${at.y}M\x1b[<0;${at.x};${at.y}m`);
  assert.deepEqual(copied, ['src/tui/selection.js:12'], 'a single click copies nothing');
});

test('a drag that runs into the sidebar stays in the conversation, and the wheel names the region under it', async t => {
  const {copied, scrolled, cellOf, send, terminal} = await mountedForSelection(t, {events: [{kind: 'note', id: 'n1', text: 'left side words'}]});
  const at = cellOf('side');
  const sidebar = terminal.regions().find(region => region.id === 'sidebar');
  assert.ok(sidebar, 'a 120-column terminal shows the sidebar');
  await send(`\x1b[<0;${at.x};${at.y}M\x1b[<32;${sidebar.x + 5};${at.y}M\x1b[<0;${sidebar.x + 5};${at.y}m`);
  assert.deepEqual(copied, ['side words'], 'clamped to the conversation\'s right edge');
  await send(`\x1b[<64;${sidebar.x + 2};3M\x1b[<65;${at.x};${at.y}M`);
  assert.deepEqual(scrolled, [[3, 'sidebar'], [-3, at.region]]);
});

test('in the agent workspace a drag stays inside the worker pane it started in, and the wheel names the pane under it', async t => {
  const {copied, scrolled, cellOf, send, terminal} = await mountedForSelection(t, {agentsOpen: true, events: [
    {kind: 'assistant', id: 'o1', seq: 1, text: 'orchestrator words here'},
    {kind: 'task.submitted', id: 's1', seq: 2, task: 'worker-one', profile: 'build'},
    {kind: 'task.activity', id: 'a1', seq: 3, task: 'worker-one', text: 'worker found the bug'},
  ]});
  const at = cellOf('found the bug');
  assert.equal(at?.region, 'worker:worker-one', 'the worker\'s activity is drawn in its own pane region');
  const orchestrator = terminal.regions().find(region => region.id === 'orchestrator');
  // Dragged leftwards across the gap into the orchestrator's pane: the selection stops at the worker pane's left
  // edge, so it takes the start of the worker's row and nothing of the orchestrator's text beside it.
  await send(`\x1b[<0;${at.x + 13};${at.y}M\x1b[<32;${orchestrator.x + 3};${at.y}M\x1b[<0;${orchestrator.x + 3};${at.y}m`);
  assert.equal(copied.length, 1);
  assert.match(copied[0], /found the bug$/);
  assert.doesNotMatch(copied[0], /orchestrator/);
  await send(`\x1b[<64;${at.x};${at.y}M`);
  assert.deepEqual(scrolled, [[3, 'worker:worker-one']]);
});

test('dragging past the top of the conversation scrolls it and the selection grows with what comes into view', async t => {
  const events = Array.from({length: 60}, (_, n) => ({kind: 'note', id: `n${n}`, text: `line-${String(n).padStart(2, '0')}`}));
  let scroll = 0, terminal;
  const env = await mountedForSelection(t, {events}, {onScroll: (amount, region) => {
    if (region !== 'orchestrator') return;
    scroll = Math.max(0, scroll + amount);
    terminal.update({scroll});
  }});
  terminal = env.terminal;
  const {copied, cellOf, send} = env;
  const start = cellOf('line-59');
  assert.ok(start, 'the newest line is on screen');
  const top = terminal.regions().find(region => region.id === 'orchestrator');
  const hiddenAtStart = top.rows.findIndex(text => stripAnsi(String(text)).includes('line-40'));
  assert.equal(top.visible.includes(hiddenAtStart), false, 'line-40 starts off screen');
  await send(`\x1b[<0;${start.x + 7};${start.y}M\x1b[<32;${start.x};1M`);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.ok(scroll > 0, 'holding the pointer above the conversation scrolled it');
  await send(`\x1b[<0;${start.x};1m`);
  assert.equal(copied.length, 1);
  const lines = copied[0].split('\n').filter(line => /line-\d\d/.test(line));
  assert.match(lines.at(-1), /Saved note  line-59$/, 'the selection still ends where the drag began');
  assert.ok(lines.some(line => line.includes('line-40')), `rows scrolled into view are in the copy: ${lines[0]} … ${lines.at(-1)}`);
});

test('in the agent workspace, dragging to a worker pane\'s top edge scrolls that pane\'s activity and copies what came into view', async t => {
  const events = [
    {kind: 'task.submitted', id: 's1', seq: 1, task: 'worker-one', profile: 'build'},
    ...Array.from({length: 40}, (_, n) => ({kind: 'task.activity', id: `a${n}`, seq: n + 2, task: 'worker-one', text: `step-${String(n).padStart(2, '0')}`})),
  ];
  const scrolls = {};
  let terminal;
  const env = await mountedForSelection(t, {agentsOpen: true, events}, {onScroll: (amount, region) => {
    scrolls[region] = Math.max(0, (scrolls[region] ?? 0) + amount);
    terminal.update({paneScrolls: {...scrolls}});
  }});
  terminal = env.terminal;
  const {copied, cellOf, send} = env;
  const pane = terminal.regions().find(region => region.id === 'worker:worker-one');
  // The newest activity row is the pane's last shown line (its header repeats it as `operation: step-39`).
  const lastLine = pane.visible.length - 1;
  assert.match(stripAnsi(String(pane.rows[pane.visible[lastLine]])), /^● step-39$/);
  const start = {x: pane.x + 1 + '● step-39'.length, y: pane.y + lastLine + 1};
  await send(`\x1b[<0;${start.x};${start.y}M\x1b[<32;${start.x};${pane.y + 1}M`);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(scrolls['worker:worker-one'] > 0, 'the pane under the drag scrolled');
  await send(`\x1b[<0;${start.x};${pane.y + 1}m`);
  assert.doesNotMatch(copied[0], /operation:/, 'the fixed header is not part of a drag that scrolled the activity');
  const steps = copied[0].split('\n').map(line => /step-(\d\d)/.exec(line)?.[1]).filter(Boolean).map(Number);
  assert.equal(steps.at(-1), 39, 'the selection still ends at the row the drag began on');
  assert.ok(steps[0] < 39 - pane.height, `rows that were above the pane's view are copied too (from step ${steps[0]})`);
});
