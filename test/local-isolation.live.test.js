import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLocalRuntime} from '../src/local-runtime.js';

test('live containment denies host/network access, unsafe results and concurrent overwrite', {skip: process.env.BOUNCE_LIVE_DOCKER !== '1', timeout: 120000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-isolation-proof-'));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(path.join(cwd, 'src'), {recursive: true});
  const sentinel = path.join(root, 'host-only');
  await fs.writeFile(sentinel, 'host sentinel');
  await fs.writeFile(path.join(cwd, 'src/owned.js'), 'before\n');
  await fs.writeFile(path.join(cwd, 'unowned.txt'), 'preserve\n');
  const server = http.createServer((req, res) => res.end('reachable fixture'));
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await fs.rm(root, {recursive: true, force: true});});
  const url = `http://host.docker.internal:${server.address().port}`;
  const positive = await promisify(execFile)('docker', ['run', '--rm', '--network', 'bridge', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--pids-limit', '32', '--entrypoint', 'node', 'node:22-alpine', '-e', `Promise.all([require('node:dns').promises.lookup('host.docker.internal'),fetch(${JSON.stringify(url)}, {signal: AbortSignal.timeout(3000)}).then(r=>r.text())]).then(([address,text])=>console.log(JSON.stringify({address:address.address,text})))`], {timeout: 10000});
  assert.match(positive.stdout, /reachable fixture/);
  const address = JSON.parse(positive.stdout).address;
  const program = `const fs=require('fs'),assert=require('assert'); assert.equal(process.getuid(),1000); assert.equal(fs.existsSync(${JSON.stringify(sentinel)}),false); assert.equal(fs.existsSync('/var/run/docker.sock'),false); assert.throws(()=>fs.writeFileSync('/etc/bounce-proof','bad')); const denied=()=>{console.log('network denied');process.exit(0)}; const socket=require('net').connect({host:${JSON.stringify(address)},port:${server.address().port}}); socket.on('connect',()=>process.exit(1)); socket.on('error',denied); socket.setTimeout(1000,denied);`;
  const command = `node -e ${JSON.stringify(program)}`;
  let attempt = 0;
  const prepare = commands => createLocalRuntime().prepare({cwd, dir: path.join(root, `attempt-${++attempt}`), profile: {policy: 'write', mode: 'yolo', writePaths: ['src'], commands, container: {workspaceMiB: 16, memoryMiB: 128}, localOptions: {timeoutMs: 5000}}});
  const workspace = await prepare([command]);
  try {
    assert.match(await workspace.execute({name: 'run_command', arguments: {command}}), /network denied/);
    await workspace.execute({name: 'write_file', arguments: {path: 'src/owned.js', content: 'worker\n'}});
    await fs.writeFile(path.join(cwd, 'src/owned.js'), 'concurrent host edit\n');
    await assert.rejects(workspace.finish({publish: true}), {code: 'BASELINE_CONFLICT'});
    assert.equal(await fs.readFile(path.join(cwd, 'src/owned.js'), 'utf8'), 'concurrent host edit\n');
  } finally {await workspace.cancel();}
  for (const [command, code] of [["ln src/owned.js src/hardlink.js", 'UNSAFE_LINK'], ["ln -s /etc/passwd src/link.js", 'UNSAFE_LINK'], ["printf changed > unowned.txt", 'SCOPE_VIOLATION']]) {
    const workspace = await prepare([command]);
    try {
      await workspace.execute({name: 'run_command', arguments: {command}});
      await assert.rejects(workspace.finish({publish: true}), error => error.code === code && !!error.artifact);
    } finally {await workspace.cancel();}
  }
  assert.equal(await fs.readFile(path.join(cwd, 'unowned.txt'), 'utf8'), 'preserve\n');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'host sentinel');
});
