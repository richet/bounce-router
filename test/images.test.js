import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {imagePaths, saveImages} from '../src/images.js';
import {Session, Router, defaults} from '../src/core.js';
import {createPasteInput} from '../src/terminal.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function setup(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(),'bounce-images-'));
 t.after(() => fs.rmSync(root,{recursive:true,force:true}));
 const file = path.join(root,'Screen shot.png'); fs.writeFileSync(file,png);
 return {root,file,session:new Session(root,{root})};
}
test('drop paths decode quotes, escapes, file URLs, unicode and multiple images literally', t => {
 const {file,root} = setup(t);
 for (const value of [JSON.stringify(file), "'"+file+"'", file.replaceAll(' ','\\ '), pathToFileURL(file).href])
   assert.deepEqual(imagePaths('Explain '+value,root),[file]);
 assert.deepEqual(imagePaths('make missing.png like https://example.com/a.png',root),[]);
 assert.deepEqual(imagePaths("'./$(touch nope) 雪.png'",root),[path.join(root,'$(touch nope) 雪.png')]);
});
test('validate before routing and retain prompt images across all fallback providers', async t => {
 const {file,session,root} = setup(t); const calls=[];
 const router = new Router(session,defaults(),{runner:async options => {
  calls.push(options); if (calls.length===1) fs.unlinkSync(file);
  return {status:options.provider==='muse'?'completed':'limited'};
 }});
 assert.equal(await router.run('Explain '+JSON.stringify(file)),'completed');
 const content=JSON.parse(calls[0].prompt).message.content;
 assert.equal(content[1].source.data,png.toString('base64'));
 assert.ok(calls[0].args.includes('--input-format'));
 const saved=session.events.find(e=>e.kind==='user').images[0];
 for (const call of calls.slice(1)) assert.equal(call.args[call.args.indexOf('--image')+1],saved.path);
 assert.deepEqual(fs.readFileSync(saved.path),png);
 const resumed=new Session(root,{root,id:session.id});
 assert.equal(resumed.events.find(e=>e.kind==='user').images[0].path,saved.path);
 const count=calls.length;
 await assert.rejects(router.run('Explain /missing/screenshot.png'), /ENOENT/);
 assert.equal(calls.length,count); assert.equal(router.controller,null);
});
test('invalid and oversized images are rejected', t => {
 const {file,session}=setup(t); fs.writeFileSync(file,'not an image');
 assert.throws(()=>saveImages([file],session),/Unsupported/);
 fs.writeFileSync(file,Buffer.alloc(5*1024*1024+1));
 assert.throws(()=>saveImages([file],session),/5 MiB/);
});
test('bracketed paste is atomic, including split markers and embedded Enter', () => {
 const keys=[],pastes=[]; const feed=createPasteInput(s=>keys.push(s),s=>pastes.push(s));
 feed('a\x1b[20'); feed('0~"/tmp/Screen shot.png"\n'); feed('\x03\x1b[201'); feed('~\r');
 assert.deepEqual(pastes,['"/tmp/Screen shot.png"\n\x03']);
 assert.equal(keys.join(''),'a\r');
 feed('\x1b'); feed.flush(); assert.equal(keys.at(-1),'\x1b');
});
