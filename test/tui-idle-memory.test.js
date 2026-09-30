import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {createInkTerminal} from '../src/tui/ink-terminal.js';

// Found live: an idle TUI grew to 3.9 GB over 10 h. React's development build writes a
// performance.measure (with a props diff) per component per commit, and Node never evicts them.
test('re-rendering an idle TUI leaves no performance entries behind', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 120; stdout.rows = 30;
  stdout.resume();
  const terminal = createInkTerminal({stdin, stdout});
  await terminal.mount({events: [{kind: 'task.submitted', id: 's', seq: 1, task: 'a', profile: 'build'}, {kind: 'task.started', id: 't', seq: 2, task: 'a'}]});
  const before = performance.getEntriesByType('measure').length;
  for (let tick = 0; tick < 50; tick++) {
    terminal.update({now: Date.parse('2026-09-26T00:00:00Z') + tick * 250, notice: `tick ${tick}`});
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const frames = terminal.debugState().renderCount;
  terminal.unmount();
  assert.ok(frames >= 40, `expected the ticks to render, got ${frames}`);
  assert.equal(performance.getEntriesByType('measure').length - before, 0);
});
