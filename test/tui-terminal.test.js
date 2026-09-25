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
    if (text.includes('bounce ·')) frames.push(text);
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
