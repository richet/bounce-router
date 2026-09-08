import test from 'node:test';
import assert from 'node:assert/strict';
import {completions, frameDiff} from '../src/terminal.js';
import {resolveExecutable} from '../src/executable.js';
test('slash shows all commands; prefixes narrow and arguments dismiss',()=>{
 assert.equal(completions('/').length,13);
 assert.deepEqual(completions('/sk').map(x=>x[0]),['skills']);
 assert.deepEqual(completions('/mo').map(x=>x[0]),['model','mode']);
 assert.deepEqual(completions('/q').map(x=>x[0]),['quota','quit']);
 assert.deepEqual(completions('/restart').map(x=>x[0]),['restart']);
 for (const input of ['hello','/model ','/unknown']) assert.deepEqual(completions(input),[]);
});
test('idle frames produce no writes and typing leaves transcript untouched',()=>{
 const before=['title','transcript','❯ /'];
 assert.equal(frameDiff(before,before),'');
 assert.equal(frameDiff(before,['title','transcript','❯ /m']),'\x1b[3;1H\x1b[2K❯ /m');
 assert.equal(frameDiff(['a','b'],['a']),'\x1b[2;1H\x1b[2K');
});
test('Codex discovery respects override and PATH then finds bundled desktop CLI',()=>{
 const options={env:{PATH:'/bin'},home:'/user',platform:'darwin',accessible:p=>p==='/Applications/ChatGPT.app/Contents/Resources/codex'};
 assert.equal(resolveExecutable('codex',undefined,options),'/Applications/ChatGPT.app/Contents/Resources/codex');
 assert.equal(resolveExecutable('codex','/custom/codex',options),'/custom/codex');
 assert.equal(resolveExecutable('codex',undefined,{...options,accessible:p=>['/bin/codex','/Applications/ChatGPT.app/Contents/Resources/codex'].includes(p)}),'/bin/codex');
 assert.equal(resolveExecutable('codex',undefined,{...options,accessible:()=>false}),'codex');
});

test('mouse input handles split/coalesced wheel reports without changing prompt text', async () => {
 const {createMouseInput, mouseTracking} = await import('../src/terminal.js');
 const text = [], scroll = [];
 const feed = createMouseInput(s => text.push(s), n => scroll.push(n));
 feed('hello\x1b['); feed('<64;10;'); feed('5M\x1b[<65;10;5Mworld');
 feed('\x1b[<0;10;5M\x1b[<0;10;5m'); // Click and release are consumed.
 feed('\x1b[<68;10;5M\x1b[<66;10;5M'); // Modified up, horizontal wheel.
 assert.equal(text.join(''), 'helloworld');
 assert.deepEqual(scroll, [3, -3, 3]);
 feed('\x1b[A'); feed('\x1b'); feed.flush();
 assert.equal(text.join(''), 'helloworld\x1b[A\x1b');
 assert.equal(mouseTracking(true), '\x1b[?1000h\x1b[?1006h');
 assert.equal(mouseTracking(false), '\x1b[?1000l\x1b[?1006l');
});

test('input grows with wrapping and newlines, keeping the cursor within the viewport', async () => {
 const {inputLayout} = await import('../src/terminal.js');
 assert.deepEqual(inputLayout('', 6, 3), {rows:[''], cursorColumn:0, cursorRow:0});
 assert.deepEqual(inputLayout('abcdef', 6, 3), {rows:['abcdef',''], cursorColumn:0, cursorRow:1});
 assert.deepEqual(inputLayout('你好ab!', 6, 3), {rows:['你好ab','!'], cursorColumn:1, cursorRow:1});
 assert.deepEqual(inputLayout('one\ntwo\n', 6, 2), {rows:['two',''], cursorColumn:0, cursorRow:1});
 assert.deepEqual(inputLayout('a\nb\nc\nd', 6, 2), {rows:['c','d'], cursorColumn:1, cursorRow:1});
});

test('modified Enter reports a newline while plain Enter and other sequences pass through', async () => {
  const {createKeyInput, keyboardProtocol} = await import('../src/terminal.js');
  const text = [], control = [];
  let newlines = 0;
  const feed = createKeyInput(s => text.push(s), () => newlines++, (s, key) => control.push([s, key]));
  feed('hi\x1b[13;2u');                       // Shift+Enter (CSI u).
  feed('\x1b[13;9u\x1b[13;5u\x1b[13;3:1u');   // Cmd, Ctrl, Alt with an event type.
  feed('\x1b[27;5;13~');                      // Ctrl+Enter via modifyOtherKeys.
  assert.equal(newlines, 5);
  feed('\x1b[13');                            // Split sequence is held, not shown.
  assert.equal(text.join(''), 'hi');
  feed(';2u');
  assert.equal(newlines, 6);
  feed('\r\x1b[13u\x1b[13;1u');               // Unmodified Enter still submits.
  feed('\x1b[A\x1b[<0;1;1M');                 // Other escape sequences are untouched.
  feed('\x1b'); feed.flush();
  assert.equal(text.join(''), 'hi\r\r\r\x1b[A\x1b[<0;1;1M\x1b');
  // The same request re-encodes keys bounce already relies on, so they must survive it.
  text.length = 0;
  feed('\x1b[27u\x1b[9u\x1b[127u\x1b[97;2u'); // Escape, Tab, Backspace, Shift+a.
  assert.equal(text.join(''), '\x1b\t\x7fa');
  assert.deepEqual(control, []);
  feed('\x1b[99;5u\x1b[117;5u\x1b[27;5;117~\x1b[127;5u'); // Ctrl+C, Ctrl+U twice, Ctrl+Backspace.
  assert.deepEqual(control.map(([s, key]) => [s, key.name, key.ctrl]),
    [['\x03', 'c', true], ['\x15', 'u', true], ['\x15', 'u', true], ['\x7f', 'backspace', true]]);
  assert.equal(keyboardProtocol(true), '\x1b[>1u\x1b[>4;2m');
  assert.equal(keyboardProtocol(false), '\x1b[>4;0m\x1b[<1u');
});

test('handing the terminal to a vendor login releases stdin and restores the main screen', async () => {
  const {suspendTerminal, resumeTerminal} = await import('../src/terminal.js');
  const calls = [];
  const stdin = {setRawMode: raw => calls.push(`raw:${raw}`), pause: () => calls.push('pause'), resume: () => calls.push('resume')};
  let out = '';
  const stdout = {write: text => {out += text;}};
  suspendTerminal(stdin, stdout);
  // Leaving raw mode is not enough: while stdin flows, Node reads fd 0 and the inherited
  // login process never sees the keystrokes typed at its own prompt.
  assert.deepEqual(calls, ['raw:false', 'pause']);
  assert.equal(out, '\x1b[>4;0m\x1b[<1u\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[0 q\x1b[?25h\x1b[?1049l');
  calls.length = 0; out = '';
  resumeTerminal(stdin, stdout, {mouse: false});
  assert.deepEqual(calls, ['raw:true', 'resume']);
  assert.equal(out, '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[>1u\x1b[>4;2m\x1b[?1000l\x1b[?1006l');
  calls.length = 0; out = '';
  resumeTerminal(stdin, stdout);
  assert.ok(out.endsWith('\x1b[?1000h\x1b[?1006h'));
  // A stream without setRawMode (a pipe under test) must not throw.
  suspendTerminal({pause: () => {}}, stdout);
});

test('the import checklist marks the cursor and each ticked row independently', async () => {
  const {checklistRows} = await import('../src/terminal.js');
  const entries = [
    {label: 'deploy (muse)', description: 'Ship the site'},
    {label: 'notes (codex)', description: 'Take\n  notes'},
    {skill: 'imagegen', description: 'Make pictures'},
  ];
  const rows = checklistRows(entries, 1, 60, new Set([0, 2]));
  // Unlike the model picker, the cursor and the selection are separate: row 1 is where the
  // cursor sits and is not ticked, while rows 0 and 2 are ticked and are not under it.
  assert.deepEqual(rows, [
    '  [×] deploy (muse) Ship the site',
    '› [ ] notes (codex) Take notes',
    '  [×] imagegen      Make pictures',
  ]);
  assert.equal(checklistRows(entries, 0, 20, new Set()).every(row => row.length <= 20), true);
});
