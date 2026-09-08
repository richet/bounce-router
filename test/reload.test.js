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

test('supervisor installs only after child exits and resumes session on success or failure', async () => {
  const {EventEmitter} = await import('node:events');
  const {supervise} = await import('../src/reload.js');
  for (const fail of [false, true]) {
    let launches = 0, exited = false, installed = false;
    const state = {id: 'saved-session', provider: 'codex', settings: {mode: 'plan'}, dev: false};
    await supervise([], {
      updateInstall: async () => {
        assert.equal(exited, true); installed = true;
        if (fail) throw new Error('offline');
        return 'Updated bounce to 0.1.4.';
      },
      spawnChild: (_exe, _args, options) => {
        const child = new EventEmitter(); child.kill = () => {};
        const first = launches++ === 0;
        if (!first) {
          assert.equal(installed, true);
          const resumed = JSON.parse(options.env.BOUNCE_RESTART);
          assert.deepEqual({...resumed, updateNotice: undefined}, {...state, updateNotice: undefined});
          assert.match(resumed.updateNotice, fail ? /Update failed: offline/ : /Updated bounce/);
        }
        process.nextTick(() => {
          if (first) {child.emit('message', {type: 'restart', state, update: true}); exited = true;}
          child.emit('close', first ? 75 : 0);
        });
        return child;
      },
    });
    assert.equal(launches, 2);
  }
});
