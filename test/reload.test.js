import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fingerprint, validate} from '../src/reload.js';
test('reload detects added and modified source but ignores journals', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-reload-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'package.json'),'{}');
  fs.writeFileSync(path.join(root,'src','a.js'),'one');
  const before=fingerprint(root);
  fs.writeFileSync(path.join(root,'history.jsonl'),'event');assert.equal(fingerprint(root),before);
  fs.writeFileSync(path.join(root,'src','a.js'),'two');assert.notEqual(fingerprint(root),before);
  const modified=fingerprint(root);
  fs.writeFileSync(path.join(root,'src','b.js'),'new');assert.notEqual(fingerprint(root),modified);
});
test('reload validation rejects failing checks before running tests', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounce-check-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{check:'node -e "process.exit(1)"',test:'node -e "process.exit(0)"'}}));
  await assert.rejects(validate(root),/keeping this running version/);
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{check:'node -e "process.exit(0)"',test:'node -e "process.exit(0)"'}}));
  const messages = [];
  await validate(root, text => messages.push(text));
  assert.deepEqual(messages, ['Checking syntax…', 'Syntax checks passed.', 'Running tests…', 'Tests passed.']);
});
