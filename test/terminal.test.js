import test from 'node:test';
import assert from 'node:assert/strict';
import {completions, frameDiff} from '../src/terminal.js';
import {resolveExecutable} from '../src/executable.js';
test('slash shows all commands; prefixes narrow and arguments dismiss',()=>{
 assert.equal(completions('/').length,12);
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
