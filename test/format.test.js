import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import {clean, createFormatter, displayEvents, createTranscriptRenderer, activeModel} from '../src/format.js';

const plain = createFormatter({color: false});

test('main start is not labelled finished and internal transport rows stay hidden', () => {
  assert.match(plain.event({kind: 'attempt', status: 'started', provider: 'codex'}, 80).join('\n'), /Starting/);
  assert.deepEqual(plain.event({kind: 'peer.native', sessionId: 'private-id'}, 80), []);
  assert.match(plain.event({kind: 'main.started', state: 'running'}, 80).join('\n'), /Running/);
  assert.match(plain.event({kind: 'policy.fallback.skipped', reason: 'no_profile_configured'}, 80).join('\n'), /no_profile_configured/);
});
const color = createFormatter({color: true});
test('Markdown preserves content while formatting headings, lists, links and emphasis', () => {
  const out = plain.markdown('# Heading\n\n**bold** and `code`\n\n- first\n- second\n\n[Docs](https://example.com)', 60).join('\n');
  assert.match(out, /Heading/);
  assert.match(out, /bold and code/);
  assert.match(out, /first[\s\S]*second/);
  assert.match(out, /https:\/\/example.com/);
  assert.doesNotMatch(out, /\x1b|\*\*|`|# Heading/);
});
test('fenced code highlights tokens and preserves indentation, including unfinished fences', () => {
  const source = '```js\nconst answer = "yes";\n  return 42;';
  const out = color.markdown(source, 60).join('\n');
  assert.match(out, /\x1b\[35mconst/);
  assert.match(out, /\x1b\[32m"yes"/);
  assert.match(stripAnsi(out), /    return 42;/);
  assert.doesNotMatch(plain.markdown(source, 60).join('\n'), /\x1b/);
  assert.match(color.markdown('```unknown-language\nhello\n```', 30).join('\n'), /hello/);
});
test('wrapping and clipping respect wide characters and ANSI sequences', () => {
  const rows = color.wrap(color.style.title('你好世界abcd'), 4);
  assert.deepEqual(rows.map(stripAnsi), ['你好', '世界', 'abcd']);
  assert.equal(stripAnsi(color.clip(color.style.title('你好world'), 4)), '你好');
  assert.equal(clean('\x1b[2Jhello\x1b]0;title\x07\tworld'), 'hello    world');
});
test('event content stays literal outside assistant output and deltas combine without mutating journals', () => {
  assert.match(plain.event({kind:'tool', text:'**literal**'}, 40).join('\n'), /\*\*literal\*\*/);
  const events = [{kind:'delta',provider:'muse',text:'```j'}, {kind:'raw'}, {kind:'delta',provider:'muse',text:'s\nconst a = 1;\n```'}, {kind:'user',text:'next'}];
  const grouped = displayEvents(events);
  assert.equal(grouped.length, 2);
  assert.match(grouped[0].text, /^```js/);
  assert.equal(events[0].text, '```j');
});

test('transcript cache skips unchanged history and only formats appended output', () => {
  let calls = 0;
  const render = createTranscriptRenderer((e, width) => { calls++; return plain.event(e, width); });
  const events = [{kind: 'assistant', text: '# Hello'}];
  const rows = render(events, 60);
  for (let i = 0; i < 100; i++) assert.equal(render(events, 60), rows);
  assert.equal(calls, 1);
  events.push({kind: 'raw', text: 'ignored'});
  render(events, 60);
  assert.equal(calls, 1);
  events.push({kind: 'delta', provider: 'muse', text: '```j'});
  render(events, 60);
  events.push({kind: 'usage'}, {kind: 'delta', provider: 'muse', text: 's\nconst x = 1;\n```'});
  assert.deepEqual(render(events, 60), displayEvents(events).flatMap(e => plain.event(e, 60)));
  assert.equal(calls, 3);
  assert.equal(events[2].text, '```j');
  assert.deepEqual(render(events, 20), displayEvents(events).flatMap(e => plain.event(e, 20)));
  assert.equal(calls, 5);
  assert.deepEqual(render([], 20), []);
});

test('unlabelled code and tool source get colors without changing literal tool content', () => {
  const source = 'const greeting = "hello";\nfunction greet() { return greeting; }';
  const fenced = color.markdown('```\n' + source + '\n```', 100).join('\n');
  assert.match(fenced, /\x1b\[35mconst/);
  const tool = color.event({kind: 'tool', text: source}, 100).join('\n');
  assert.match(tool, /\x1b\[32m"hello"/);
  assert.ok(stripAnsi(tool).includes(source));
  assert.doesNotMatch(plain.event({kind: 'tool', text: source}, 100).join('\n'), /\x1b/);
});

test('headings omit Markdown markers while code and status remain literal', () => {
  for (let level = 1; level <= 6; level++) {
    assert.equal(plain.markdown('#'.repeat(level) + ' Heading', 80).join('\n'), 'Heading');
  }
  assert.match(plain.event({kind: 'status', text: '# literal log'}, 80).join('\n'), /Bounce · Activity {2}# literal log/);
});
test('model display tracks the latest attempt and configuration changes', () => {
  const events = [{kind: 'route', provider: 'claude', model: 'default'},
    {kind: 'model', provider: 'claude', model: 'actual-model'}];
  assert.equal(activeModel(events, 'claude'), 'actual-model');
  assert.equal(activeModel(events, 'claude', 'new-model'), 'new-model');
  events.push({kind: 'route', provider: 'codex', model: 'default'});
  assert.equal(activeModel(events, 'codex'), 'Default (not reported)');
  events.push({kind: 'route', provider: 'claude', model: 'default'});
  assert.equal(activeModel(events, 'claude'), 'Default (not reported)');
});

test('bookkeeping events stay on one line while content keeps its own block', () => {
  const status = plain.event({kind: 'status', provider: 'claude', text: 'Task started · probe'}, 80);
  assert.deepEqual(status, ['claude · Activity  Task started · probe']);
  const progress = plain.event({kind: 'progress', provider: 'claude', text: 'Thinking · ~350 tokens'}, 80);
  assert.deepEqual(progress, ['claude · progress  Thinking · ~350 tokens']);
  assert.deepEqual(plain.event({kind: 'attempt', provider: 'codex', text: 'completed'}, 80), ['codex · Agent finished  completed']);
  // Long inline text wraps instead of being clipped, and never gains a blank spacer row.
  const long = plain.event({kind: 'note', text: 'x'.repeat(200)}, 40);
  assert.ok(long.length > 1 && long.at(-1) !== '');
  assert.deepEqual(plain.event({kind: 'assistant', provider: 'claude', text: 'hi'}, 80), ['claude · Response', 'hi', '']);
});

test('tool calls render their JSON input as readable lines', () => {
  const text = 'Bash: ' + JSON.stringify({command: 'grep -n "picker" src/cli.js\nnpm run check', description: 'Check the picker'});
  const rows = plain.event({kind: 'tool', provider: 'claude', text}, 200);
  assert.deepEqual(rows, ['claude · Tool output', 'Bash', 'command:', '  grep -n "picker" src/cli.js', '  npm run check',
    'description: Check the picker', '']);
  // Anything that is not a `Name: {json}` tool call is shown verbatim.
  const plainText = plain.event({kind: 'tool', provider: 'claude', text: '270:   if (busy) return;'}, 200);
  assert.deepEqual(plainText, ['claude · Tool output', '270:   if (busy) return;', '']);
  assert.match(plain.event({kind: 'tool', text: 'Bash: {not json'}, 200).join('\n'), /Bash: \{not json/);
});

test('Inline Markdown inside list items is parsed, not shown as literal markers', () => {
  const source = '1. **Picker** — type `/model`, then *up/down*\n2. plain item\n\n- bullet with **bold**, `code` and *em*\n  - nested **inner**\n';
  const out = plain.markdown(source, 80).join('\n');
  assert.doesNotMatch(out, /\*\*|`/);
  assert.match(out, /Picker — type \/model, then up\/down/);
  assert.match(out, /bullet with bold, code and em/);
  assert.match(out, /nested inner/);
  // Emphasis inside a list item must be styled exactly as it is in a paragraph.
  assert.match(color.markdown('- item with **bold**', 80).join('\n'), /\x1b\[1mbold/);
});

test('compact answers fold long code and tables with a readable expandable preview', () => {
  const source = '## Verification\n\n```sh\none\ntwo\nthree\nfour\nFIFTH_CODE_LINE\n```\n\n| File | Result |\n| --- | --- |\n| a | `ok:` |\n| b | ok |\n| c | ok |\n| FOURTH_ROW | ok |';
  const compact = createFormatter({color: false, compact: true}).markdown(source, 50).join('\n');
  assert.match(compact, /Verification/);
  assert.match(compact, /File: a.*Result: ok:/);
  assert.match(compact, /\/details/);
  assert.doesNotMatch(compact, /FIFTH_CODE_LINE|FOURTH_ROW|\| ---/);
  const expanded = plain.markdown(source, 50).join('\n');
  assert.match(expanded, /FIFTH_CODE_LINE/);
  assert.match(expanded, /FOURTH_ROW/);
});

test('work recap includes only completed turns, uses final response and survives resume', async () => {
  const {createWorkSummary} = await import('../src/format.js');
  const events = [
    {kind: 'user', text: 'Please fix it'},
    {kind: 'assistant', text: 'I will inspect it'},
    {kind: 'assistant', text: '## Summary\n- Fixed **routing**.'},
    {kind: 'turn', text: 'completed'},
    {kind: 'assistant', text: 'Failed work'},
    {kind: 'turn', text: 'failed'},
  ];
  const recap = createWorkSummary();
  assert.deepEqual(recap(events), ['Fixed routing.']);
  assert.deepEqual(recap(events), ['Fixed routing.']);
  events.push({kind: 'user'}, {kind: 'delta', text: 'Added '}, {kind: 'delta', text: 'tests.'});
  assert.deepEqual(recap(events), ['Fixed routing.']);
  events.push({kind: 'turn', text: 'completed'});
  assert.deepEqual(recap(events), ['Fixed routing.', 'Added tests.']);
  assert.deepEqual(createWorkSummary()(events), recap(events));
  assert.deepEqual(recap([]), []);
});

test('work recap discards failed provider output on fallback', async () => {
  const {createWorkSummary} = await import('../src/format.js');
  assert.deepEqual(createWorkSummary()([
    {kind: 'assistant', text: 'Unfinished'}, {kind: 'route'},
    {kind: 'turn', text: 'completed'},
  ]), ['Completed turn']);
});

test('work review preserves all item text and orders oldest first without mutating the recap', async () => {
  const {workReview} = await import('../src/format.js');
  const long = 'Detailed completed work '.repeat(30) + 'END';
  const items = ['First item', long, 'Last item'];
  const report = workReview(items);
  assert.equal(report, '1. First item\n\n2. ' + long + '\n\n3. Last item');
  const rows = plain.event({kind: 'review', text: report}, 30);
  assert.match(rows.join('\n'), /Work Done review/);
  assert.match(rows.join('\n'), /END/);
  assert.match(rows.join('\n'), /First item/);
  assert.deepEqual(items, ['First item', long, 'Last item']);
  assert.equal(workReview([]), 'No completed turns yet.');
});

test('compact formatter: a tool call is a ● Name(purpose) line, a tool result a ⎿ preview block, a delegation row a glyph line with a next step on failure', () => {
  const {event} = createFormatter({color: false, compact: true});
  const call = event({kind: 'tool', provider: 'claude', text: 'Bash: {"command":"npm test","description":"Run the suite"}'}, 200);
  assert.deepEqual(call, ['● Bash(Run the suite)']);
  assert.deepEqual(event({kind: 'tool', provider: 'claude', text: 'Bash: {"command":"npm test","description":"Run the whole suite again"}'}, 20), ['● Bash(Run the who…)']);
  // The first lines show under ⎿ at the content column, the rest fold to "… +N lines"; a blank
  // row closes the block. Inner indentation is kept; an overlong line is clipped, not wrapped.
  const result = event({kind: 'tool', provider: 'claude', text: '\n  # pass 12\n  indented\n# fail 0\nok\nmore\n'}, 200);
  assert.deepEqual(result, ['  ⎿    # pass 12', '       indented', '     # fail 0', '     … +2 lines', '']);
  assert.deepEqual(event({kind: 'tool', provider: 'claude', text: 'x'.repeat(40)}, 30), ['  ⎿  ' + 'x'.repeat(24) + '…', '']);
  assert.deepEqual(event({kind: 'tool', provider: 'claude', text: '<persisted-output>\nOutput too large'}, 200), ['  ⎿  output saved to a file', '']);
  assert.deepEqual(event({kind: 'task.fold', task: 't1', state: 'running', reason: null, text: 'build · running · writing tests'}, 200), ['● build · running · writing tests']);
  assert.deepEqual(event({kind: 'task.fold', task: 't1', state: 'failed', reason: 'error', text: 'build · failed · error: Invalid request: invalid type: null, expected a string'}, 200), [
    '✗ build · failed · error: Invalid request: invalid type: null, expected a string',
    '  ⎿  next: the vendor CLI speaks a different protocol version than bounce expects · update bounce (or the vendor), then resubmit',
  ]);
  assert.deepEqual(event({kind: 'user', text: 'You are the orchestrator peer of session s; see x.\ncontinue with the handoff'}, 200), ['> continue with the handoff', '']);
  // Answers hang two columns under their ●, lists keep their marker column when they wrap, and
  // bookkeeping rows sit at the content column.
  const answer = event({kind: 'assistant', provider: 'claude', text: 'Done.\n\n- first item that is long enough to wrap past the width\n- second\n\n1. numbered item that is also long enough to wrap past the width\n2. next'}, 40);
  assert.deepEqual(answer, [
    '● Done.', '',
    '  - first item that is long enough to', '    wrap past the width',
    '  - second', '',
    '  1. numbered item that is also long', '     enough to wrap past the width',
    '  2. next', '',
  ]);
  assert.deepEqual(event({kind: 'status', provider: 'claude', text: 'Finished · completed'}, 80), ['  claude · Activity  Finished · completed']);
});

test('Markdown lists use Claude Code markers, nest by the marker width and wrap under their text; code has no header', () => {
  const out = plain.markdown('- item one\n  - nested item\n    - deeper\n- item two\n\n3. third\n4. fourth\n   - sub\n\n```js\nfunction x() {\n  return 1;\n}\n```', 80);
  assert.deepEqual(out, [
    '- item one', '  - nested item', '    - deeper', '- item two', '',
    '3. third', '4. fourth', '   - sub', '',
    '  function x() {', '    return 1;', '  }',
  ]);
  // A long code line continues under its own indentation.
  assert.deepEqual(plain.markdown('```\n    ' + 'word '.repeat(8).trim() + '\n```', 30), ['      word word word word word', '      word word word']);
});

test('classic formatter (no compact) still renders a tool row as a full block', () => {
  const {event} = createFormatter({color: false});
  const tool = event({kind: 'tool', provider: 'claude', text: 'Bash: {"command":"npm test","description":"Run the suite"}'}, 200);
  assert.ok(tool.length > 1, 'classic keeps the multi-line tool block (byte-identical path unchanged)');
});
