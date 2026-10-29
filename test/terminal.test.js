import test from 'node:test';
import assert from 'node:assert/strict';
import {completions, typedCommand, frameDiff} from '../src/terminal.js';
import {commandCatalog} from '../src/commands.js';
import {resolveExecutable} from '../src/executable.js';
test('slash shows all commands; prefixes narrow and arguments dismiss',()=>{
 assert.equal(completions('/').length,35);
 assert.deepEqual(completions('/re').map(x=>x[0]),['rename','resume','review','retry','restart']);
 assert.deepEqual(completions('/je').map(x=>x[0]),['jev']);
 assert.deepEqual(completions('/b').map(x=>x[0]),['btw']);
 assert.deepEqual(completions('/ag').map(x=>x[0]),['agents']);
 assert.deepEqual(completions('/co').map(x=>x[0]),['config','continue']);
 assert.deepEqual(completions('/st').map(x=>x[0]),['steer','stop','stats']);
 assert.deepEqual(completions('/sk').map(x=>x[0]),['skills']);
 assert.deepEqual(completions('/mo').map(x=>x[0]),['model','mode']);
 assert.deepEqual(completions('/q').map(x=>x[0]),['quota','quit']);
 assert.deepEqual(completions('/up').map(x=>x[0]),['update']);
 assert.equal(typedCommand('/update'), 'update');
 assert.equal(typedCommand('/review'), 'review');
 assert.equal(typedCommand('/agents'), 'agents');
 assert.deepEqual(completions('/rev').map(x=>x[0]), ['review']);
 assert.deepEqual(completions('/restart').map(x=>x[0]),['restart']);
 for (const input of ['hello','/model ','/unknown']) assert.deepEqual(completions(input),[]);
 assert.deepEqual(completions('/').map(([name]) => name).sort(), Object.values(commandCatalog).flat().sort());
});
test('idle frames produce no writes and typing leaves transcript untouched',()=>{
 const before=['title','transcript','❯ /'];
 assert.equal(frameDiff(before,before),'');
 assert.equal(frameDiff(before,['title','transcript','❯ /m']),'\x1b[3;1H\x1b[2K❯ /m');
 assert.equal(frameDiff(['a','b'],['a']),'\x1b[2;1H\x1b[2K');
});
// 2026-09-27: the Codex desktop app is off limits — its bundled CLI is never a candidate.
test('Codex discovery respects override and PATH and never falls back to the desktop app\'s bundled CLI',()=>{
 const options={env:{PATH:'/bin'},home:'/user',accessible:p=>p==='/Applications/ChatGPT.app/Contents/Resources/codex'||p==='/Applications/Codex.app/Contents/Resources/codex'};
 assert.equal(resolveExecutable('codex',undefined,options),'codex');
 assert.equal(resolveExecutable('codex','/custom/codex',options),'/custom/codex');
 assert.equal(resolveExecutable('codex',undefined,{...options,accessible:p=>['/bin/codex','/Applications/ChatGPT.app/Contents/Resources/codex'].includes(p)}),'/bin/codex');
 assert.equal(resolveExecutable('codex',undefined,{...options,accessible:()=>false}),'codex');
});
// opencode's installer puts the binary in ~/.opencode/bin and adds that to the interactive shell's
// PATH — so a context with a reduced PATH (GUI-launched terminal, stripped env, a daemon that did
// not inherit the login profile) reported it missing while it was installed.
test('OpenCode discovery finds the installer location when PATH does not carry it',()=>{
 const installed='/user/.opencode/bin/opencode';
 const options={env:{PATH:'/bin'},home:'/user',platform:'darwin',accessible:p=>p===installed};
 assert.equal(resolveExecutable('opencode',undefined,options),installed);
 // PATH still wins when it has one, and an explicit override still wins over everything.
 assert.equal(resolveExecutable('opencode',undefined,{...options,accessible:p=>['/bin/opencode',installed].includes(p)}),'/bin/opencode');
 assert.equal(resolveExecutable('opencode','/custom/oc',options),'/custom/oc');
 assert.equal(resolveExecutable('opencode',undefined,{...options,accessible:()=>false}),'opencode');
 // The fallback is opencode's alone; it must not leak into other providers.
 assert.equal(resolveExecutable('claude',undefined,{env:{PATH:'/bin'},home:'/user',platform:'darwin',accessible:p=>p==='/user/.opencode/bin/claude'}),'claude');
});

test('mouse input handles split/coalesced wheel reports without changing prompt text', async () => {
 const {createMouseInput, mouseTracking} = await import('../src/terminal.js');
 const text = [], scroll = [], pointer = [];
 const feed = createMouseInput(s => text.push(s), (n, at) => scroll.push([n, at.x, at.y]), event => pointer.push(event));
 feed('hello\x1b['); feed('<64;10;'); feed('5M\x1b[<65;10;5Mworld');
 feed('\x1b[<68;10;5M\x1b[<66;10;5M'); // Modified up, horizontal wheel.
 assert.equal(text.join(''), 'helloworld');
 assert.deepEqual(scroll, [[3, 10, 5], [-3, 10, 5], [3, 10, 5]], 'the wheel says where the pointer is, so the region under it scrolls');
 assert.deepEqual(pointer, []);
 feed('\x1b[A'); feed('\x1b'); feed.flush();
 assert.equal(text.join(''), 'helloworld\x1b[A\x1b');
 // Button-event tracking (1002) reports a drag while the button is down, which selection needs. Alternate scroll
 // mode stays off in both states: it would turn the wheel into arrow keys that walk prompt history.
 assert.equal(mouseTracking(true), '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?1002h\x1b[?1006h');
 assert.equal(mouseTracking(false), '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l');
});

test('a left-button press, drag and release reach selection with their cells; other buttons do not', async () => {
 const {createMouseInput} = await import('../src/terminal.js');
 const pointer = [];
 const feed = createMouseInput(() => {}, () => {}, event => pointer.push(event));
 feed('\x1b[<0;10;5M\x1b[<32;12;5M'); feed('\x1b[<32;14;6M\x1b[<0;14;6m');
 feed('\x1b[<2;3;3M\x1b[<2;3;3m\x1b[<34;4;3M'); // Right button press, release and drag.
 assert.deepEqual(pointer, [
  {kind: 'press', x: 10, y: 5}, {kind: 'drag', x: 12, y: 5}, {kind: 'drag', x: 14, y: 6}, {kind: 'release', x: 14, y: 6},
 ]);
});

test('a mouse report split across reads survives the input flush: no half of it is typed into the prompt', async () => {
 const {createMouseInput} = await import('../src/terminal.js');
 const text = [], pointer = [];
 const feed = createMouseInput(s => text.push(s), () => {}, event => pointer.push(event));
 feed('\x1b[<32;37;3M\x1b[<'); feed.flush(); // The flush timer fires between the two reads.
 feed('0;37;3m');
 assert.deepEqual(pointer, [{kind: 'drag', x: 37, y: 3}, {kind: 'release', x: 37, y: 3}]);
 assert.deepEqual(text, []);
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
  // The child CLI gets alternate scroll mode back: bounce only suppresses it for its own screen.
  assert.equal(out, '\x1b[>4;0m\x1b[<1u\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007h\x1b[?2004l\x1b[0 q\x1b[?25h\x1b[?1049l');
  calls.length = 0; out = '';
  resumeTerminal(stdin, stdout);
  assert.deepEqual(calls, ['raw:true', 'resume']);
  assert.equal(out, '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[>1u\x1b[>4;2m\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l');
  calls.length = 0; out = '';
  resumeTerminal(stdin, stdout, {mouse: true});
  assert.ok(out.endsWith('\x1b[?1002h\x1b[?1006h'));
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

test('a command typed in full is recognised, so Enter runs it instead of completing it', () => {
  // /skills has to list the skills on the first Enter. Treating it as a completion to accept
  // swallowed that press, and the silent no-op is what sent people back to the prompt.
  assert.equal(typedCommand('/skills'), 'skills');
  assert.equal(typedCommand('/QUIT'), 'quit');
  // Half-typed, ambiguous, argument-bearing or unknown: Enter still completes or submits.
  for (const input of ['/sk', '/mo', '/skills ', '/skills sync', '/nonsense', '/', 'skills', ''])
    assert.equal(typedCommand(input), '', input);
  // /mode is also a prefix of /model, so its menu still offers both and the first entry is the
  // one Enter used to accept. Typing the command out in full has to beat that.
  assert.deepEqual(completions('/mode').map(x => x[0]), ['model', 'mode']);
  assert.equal(typedCommand('/mode'), 'mode');
});

// Found in the real-console pass 2026-10-21: under the kitty protocol (tmux, kitty, Ghostty) Ctrl+J arrives encoded and
// became a bare control key, so the newline the help promises never opened.
test('Ctrl+J opens a line under the kitty protocol and under modifyOtherKeys, as the raw line feed does', async () => {
  const {createKeyInput} = await import('../src/terminal.js');
  let newlines = 0; const control = [];
  const feed = createKeyInput(() => {}, () => newlines++, (s, key) => control.push(key.name));
  feed('\x1b[106;5u'); feed('\x1b[27;5;106~');
  assert.equal(newlines, 2);
  assert.deepEqual(control, []);
});

// Found in the real-console pass 2026-10-21: /config's help and /local setup's text were wrapped like the prompt
// draft, at the column, so words broke across rows ("The f / irst", "promp / t.").
test('prose wraps at word boundaries, and only a word longer than the row is cut', async () => {
  const {wordRows} = await import('../src/terminal.js');
  assert.deepEqual(wordRows('Type cancel at any prompt.', 16), ['Type cancel at', 'any prompt.']);
  assert.deepEqual(wordRows('abcdefghij xy', 4), ['abcd', 'efgh', 'ij', 'xy']);
});
