// The folded conversation is for reading what was said and knowing how to continue. Measured on two
// live sessions: three quarters of the screen was machinery (the orchestrator's own tool calls 43–51%,
// vendor plumbing, bounce's internal rows, the hand-off prompt) and a worker's outcome got 2%, its
// question cut at the screen edge. Details mode still shows everything; nothing leaves the journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import {conversationEvents} from '../src/tui/transcript.js';
import {createFormatter} from '../src/format.js';

let seq = 0;
const at = s => `2026-09-21T05:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
const ev = (s, kind, extra = {}) => ({id: `e${++seq}`, time: at(s), kind, ...extra});
const call = (s, name, args) => ev(s, 'tool', {provider: 'claude', from: 'main', text: `${name}: ${JSON.stringify(args)}`});
const output = (s, text) => ev(s, 'tool', {provider: 'claude', from: 'main', text});
const render = (events, {details = false, width = 80} = {}) => {
  const formatter = createFormatter({color: false, compact: true});
  return conversationEvents(events, {details}).flatMap(row => formatter.event(row, width).map(stripAnsi));
};
const T = '02a9a23d-8722-4f50-b4f5-6204afd58a78';

test('a run of the orchestrator\'s own tool calls is one line naming how many and the last one; details still shows them all', () => {
  const events = [ev(1, 'user', {text: 'continue'}),
    call(2, 'Read', {file_path: '/repo/docs/PROGRESS.md'}), output(3, '1  # Ace\n2\n3  Design\n4  more\n5  more'),
    ev(4, 'status', {provider: 'claude', from: 'main', text: 'hook_started'}),
    call(5, 'Bash', {command: 'ls', description: 'List the tree'}), output(6, 'a\nb'),
    ev(7, 'assistant', {provider: 'claude', text: 'Here is the plan.'}),
    call(8, 'Read', {file_path: '/repo/src/x.ts'})];
  const lines = render(events);
  assert.deepEqual(lines.filter(line => line.includes('tool call')), ['  ⚙ 2 tool calls · last: Bash(List the tree)', '  ⚙ 1 tool call · last: Read(/repo/src/x.ts)']);
  assert.equal(lines.some(line => line.includes('# Ace') || line.includes('+2 lines')), false, 'no pasted file content in the folded view');
  assert.equal(render(events, {details: true}).some(line => line.includes('# Ace')), true);
});

test('a worker\'s outcome is a block you can read: its whole summary wrapped, and a worker waiting on you is marked with its whole question and how to answer', () => {
  const question = '3 of 4 P2 source majors fixed (copy failure/inventory, marker provenance, Git ref probes). Finding 1 (worktree-scoped exclude) needs a design decision: should the exclude live in the worktree\'s own info/exclude, or in a per-worktree config include? The first is simpler; the second survives a worktree move.';
  const events = [ev(1, 'task.submitted', {task: T, profile: 'build_claude', orders: 'fix'}), ev(2, 'task.started', {task: T, requested: 'opus[1m]'}),
    ev(400, 'task.input_required', {task: T, text: question})];
  const lines = render(events);
  assert.equal(lines[0], '? build_claude is waiting on you · opus[1m]');
  assert.equal(lines.slice(1, -1).map(line => line.trim()).join(' '), question, 'the whole question, wrapped, none of it cut');
  assert.equal(lines.every(line => line.length <= 80), true);
  assert.equal(lines.at(-1), '  ⎿  answer: /agents 02a9a23d, then type your reply');

  const done = [ev(1, 'task.submitted', {task: T, profile: 'build'}), ev(2, 'task.started', {task: T, requested: 'gpt-5.6-terra'}),
    ev(560, 'task.completed', {task: T, summary: 'Addressed both assigned P2 blockers and Create input readability; 13 red regressions now pass, all 19 focused tests pass, owned-file type/style checks pass.'}),
    ev(561, 'task.accepted', {task: T})];
  const block = render(done);
  assert.equal(block[0], '✔ build · accepted · gpt-5.6-terra · 559.0s');
  assert.equal(block.slice(1).map(line => line.trim()).join(' '), 'Addressed both assigned P2 blockers and Create input readability; 13 red regressions now pass, all 19 focused tests pass, owned-file type/style checks pass.');
  // a long report is capped, and says so
  const long = render([ev(1, 'task.submitted', {task: T, profile: 'build'}), ev(2, 'task.started', {task: T}), ev(9, 'task.completed', {task: T, summary: 'word '.repeat(400)})]);
  assert.deepEqual([long.length, long.at(-1)], [8, '  … /agents 02a9a23d or /details for the rest']);
});

test('machinery leaves the folded view: vendor plumbing, the hand-off prompt, empty internal rows, stall pings; what remains of bounce\'s own rows is one line each', () => {
  const events = [ev(1, 'user', {text: 'go'}),
    ...['hook_started', 'hook_response', 'background_tasks_changed', 'task_updated', 'Task started · Wait for the builder to finish', 'Task stopped · Orphaned by a previous Claude Code process exit'].map((text, i) => ev(2 + i, 'status', {provider: 'claude', from: 'main', text})),
    ev(10, 'status', {provider: 'claude', from: 'main', text: 'Compacting conversation'}),
    ev(11, 'handoff', {text: 'Worker outcomes not yet handed to you…\nContinue your orders.'}), ev(12, 'review.started', {task: T, profile: 'jev'}),
    ev(13, 'review.finished', {task: T, text: '{"verdict":"accept"}'}), ev(14, 'control.jev', {from: 'user'}), ev(15, 'control.local_activate', {from: 'user'}),
    ev(16, 'policy.escalated', {task: T, text: 'silent for 122 s'}), ev(17, 'policy.corrected', {task: T, text: 'silent for 240 s'}),
    ev(18, 'jev.routed', {task: T, text: 'Routed builder → its own models (fallback: tier confidence 0.36 below 0.6; confidence 0.65 below 0.8)'}),
    ev(19, 'jev.verdict', {task: T, text: 'Jev verdict · accept (chose rework below threshold) · confidence 0.11 of 0.8 · fired: unmet_acceptance, empty_diff · 396 ms'}),
    ev(20, 'local.profiles.activated', {names: ['analyst', 'builder'], text: 'Agents updated in this session: analyst → lmstudio/qwen3-coder-30b-a3b-instruct-mlx@4bit (via opencode), claude · read-only; builder → …'})];
  const lines = render(events).filter(Boolean);
  assert.deepEqual(lines, ['> go',
    '  claude · Activity  Compacting conversation',
    '  · Routed builder → its own models (fallback: tier confidence 0.36 below 0.6; …',
    '  · Jev verdict · accept (chose rework below threshold) · confidence 0.11 of 0.…',
    '  · Agents updated in this session: analyst → lmstudio/qwen3-coder-30b-a3b-inst…']);
  assert.equal(lines.every(line => line.length <= 80), true);
  const detailed = render(events, {details: true}).join('\n');
  for (const kept of ['hook_started', 'Continue your orders.', 'silent for 122 s', '{"verdict":"accept"}']) assert.equal(detailed.includes(kept), true, kept);
});

test('a finished turn ends on what to do next: the answer\'s TLDR, who is still working, and who is waiting on you', () => {
  const W = '8302c5f5-a4dc-471b-8b37-b6ba4a9fc5f7';
  const answer = '**TLDR:** Round 4 is running with two builders; nothing is fixed yet. No decision is needed from you.\n\n' + '- **Source-ownership builder** fixes the four major findings of the review in its own files.\n'.repeat(8);
  const events = [ev(1, 'user', {text: 'continue'}), ev(2, 'task.submitted', {task: T, profile: 'build_claude'}), ev(3, 'task.started', {task: T}),
    ev(4, 'task.submitted', {task: W, profile: 'build'}), ev(5, 'task.started', {task: W}),
    ev(6, 'task.input_required', {task: T, text: 'Which exclude?'}),
    ev(7, 'assistant', {provider: 'claude', text: answer}), ev(8, 'main.terminal', {status: 'completed', text: answer, provider: 'claude'})];
  const lines = render(events);
  const tail = lines.slice(lines.findIndex(line => line.startsWith('▸ TLDR · ')));
  assert.equal(tail.slice(0, -2).map(line => line.trim()).join(' '), '▸ TLDR · Round 4 is running with two builders; nothing is fixed yet. No decision is needed from you.');
  assert.deepEqual(tail.slice(-2), ['  1 worker running · 1 waiting on you: build_claude (/agents 02a9a23d)', '']);
  assert.equal(tail.every(line => line.length <= 80), true);
  assert.equal(lines.some(line => line.includes('Finished · completed')), false);
  // a long answer with no TLDR: its first sentence. A short answer is still on screen right above, so
  // it is not repeated; with no workers either, the turn just ends. A failed turn keeps saying so.
  const wordy = render([ev(1, 'user', {text: 'hi'}), ev(2, 'assistant', {provider: 'claude', text: `The gate passes. Details follow.\n\n${'More detail. '.repeat(60)}`}), ev(3, 'main.terminal', {status: 'completed', provider: 'claude'})]);
  assert.deepEqual(wordy.slice(-2), ['▸ TLDR · The gate passes.', '']);
  const short = render([ev(1, 'user', {text: 'hi'}), ev(2, 'assistant', {provider: 'claude', text: 'The gate passes.'}), ev(3, 'main.terminal', {status: 'completed', provider: 'claude'})]);
  assert.equal(short.some(line => line.includes('Next')), false);
  assert.equal(short.filter(line => line.includes('The gate passes.')).length, 1);
  const failed = render([ev(1, 'user', {text: 'hi'}), ev(2, 'main.terminal', {status: 'failed', text: 'claude exited 1', provider: 'claude'})]);
  assert.equal(failed.some(line => line.includes('Finished · claude exited 1')), true);
});

// "A bit unreadable between the commands and inner comms": the answer's body was painted in the
// terminal's default colour, the same as everything around it. Now the answer to you is the one
// thing in colour, and the machinery around it is dim.
test('what the orchestrator says to you is painted in its own colour on every line; tool runs, routing rows and worker blocks stay dim', () => {
  const formatter = createFormatter({color: true, compact: true});
  const paint = (lines) => lines.map(l => l.replace(/\x1b\[39m/g, '').match(/\x1b\[(\d+)m/)?.[1] ?? null);
  const answer = formatter.event({kind: 'assistant', provider: 'claude', text: 'First line of the answer.\n\nA second paragraph, wrapped over more than one line so that a second line exists here too.'}, 40);
  const codes = paint(answer.filter(Boolean).map(l => l.replace(/^\x1b\[32m●\x1b\[39m /, ''))); // past the green ● marker
  assert.equal(codes.every(code => code === '37'), true, `every answer line opens in the answer colour, got ${JSON.stringify(codes)}: ${JSON.stringify(answer)}`);
  const tools = formatter.event({kind: 'tool.fold', calls: 2, last: 'Bash: {"description":"Run the gate"}'}, 80);
  assert.equal(paint(tools)[0], '90', 'a tool run is dim');
  const routed = formatter.event({kind: 'jev.routed', text: 'Routed builder → its own models'}, 80);
  assert.equal(paint(routed)[0], '90', 'a bounce bookkeeping row is dim');
  const next = formatter.event({kind: 'next', tldr: 'The gate passes.', running: 1, waiting: []}, 80);
  assert.equal(paint(next)[0], '1', 'the Next line is bold, so the eye lands on it');
});
