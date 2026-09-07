import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import {clean, createFormatter, displayEvents} from '../src/format.js';

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
