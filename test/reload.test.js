import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fingerprint, validate, orchestratorOwns, orchestratorTasks} from '../src/reload.js';
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

test('supervisor installs only after child exits and resumes session on success or failure', async t => {
  // Isolate BOUNCE_HOME: since Phase 9, a bare supervise() consults config to decide classic vs
  // interactive-orchestrator. An empty home resolves to classic defaults → legacySupervise, the
  // install/restart loop this test exercises (without this it would read the real ~/.bounce).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-sv-'));
  const prevHome = process.env.BOUNCE_HOME;
  process.env.BOUNCE_HOME = home;
  t.after(() => { if (prevHome === undefined) delete process.env.BOUNCE_HOME; else process.env.BOUNCE_HOME = prevHome; fs.rmSync(home, {recursive: true, force: true}); });
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

// Found live: a builder failed, bounce submitted its fallback replacement (from `bounce`, not from the
// orchestrator), and the orchestrator's bus grant was never widened to include it — the grant is extended
// only for rows it submitted itself. When the reviewer then failed the work and the orchestrator submitted
// the rework under that replacement, the bus refused it `-32001 unauthorized` on both transports. The
// orchestrator stopped rather than bypass bounce, and the campaign stalled with the fix already written.
test('a replacement bounce made for the orchestrator\'s task is still the orchestrator\'s task', () => {
  const events = [
    {kind: 'task.submitted', task: 'own', from: 'orchestrator', parent: null},
    {kind: 'task.submitted', task: 'fallback', from: 'bounce', replaces: 'own', parent: null},
    {kind: 'task.submitted', task: 'second', from: 'bounce', replaces: 'fallback', parent: null},
    {kind: 'task.submitted', task: 'theirs', from: 'user', parent: null},
    {kind: 'task.submitted', task: 'theirFallback', from: 'bounce', replaces: 'theirs', parent: null},
  ];
  assert.equal(orchestratorOwns(events, 'own'), true);
  assert.equal(orchestratorOwns(events, 'fallback'), true, 'the replacement it never typed is still its work');
  assert.equal(orchestratorOwns(events, 'second'), true, 'and a replacement of a replacement');
  assert.equal(orchestratorOwns(events, 'theirs'), false, "someone else's task is not widened into its grant");
  assert.equal(orchestratorOwns(events, 'theirFallback'), false);
  assert.equal(orchestratorOwns(events, 'unknown'), false);
  // a cycle must not hang the walk
  const cyclic = [{kind: 'task.submitted', task: 'a', from: 'bounce', replaces: 'b'}, {kind: 'task.submitted', task: 'b', from: 'bounce', replaces: 'a'}];
  assert.equal(orchestratorOwns(cyclic, 'a'), false);
});

// The grant is built fresh on every start and widened only by rows that arrive live, so after a restart
// the orchestrator owned nothing from before it. Found live: it restarted, tried to submit a rework under
// a task from an earlier turn, and the bus refused `-32001 unauthorized` — the fix for fallback ownership
// was already running and could not help, because the task predated the process.
test('the grant is seeded from the journal, so a restart does not disown the work', () => {
  const events = [
    {kind: 'task.submitted', task: 'own', from: 'orchestrator'},
    {kind: 'task.submitted', task: 'fallback', from: 'bounce', replaces: 'own'},
    {kind: 'task.completed', task: 'own'},
    {kind: 'task.submitted', task: 'theirs', from: 'user'},
    {kind: 'task.submitted', task: 'child', from: 'orchestrator', parent: 'own'},
  ];
  const seeded = orchestratorTasks(events);
  assert.deepEqual(seeded.sort(), ['child', 'fallback', 'own'], 'including a finished one: it may still be parented under');
  assert.equal(seeded.includes('theirs'), false);
  assert.deepEqual(orchestratorTasks([]), []);
});
