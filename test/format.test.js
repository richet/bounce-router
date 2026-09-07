import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import {clean, createFormatter, displayEvents, createTranscriptRenderer, activeModel} from '../src/format.js';

const plain = createFormatter({color: false});
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
