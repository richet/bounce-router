import test from 'node:test';
import assert from 'node:assert/strict';
import {completions, frameDiff} from '../src/terminal.js';
import {resolveExecutable} from '../src/executable.js';
test('slash shows all commands; prefixes narrow and arguments dismiss',()=>{
 assert.equal(completions('/').length,11);
 assert.deepEqual(completions('/mo').map(x=>x[0]),['model','mode']);
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
