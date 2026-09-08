import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {version, newer, checkUpdate, globalInstall, installUpdate} from '../src/update.js';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-update-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
test('CLI version comes from package metadata', () => {
  assert.equal(execFileSync(process.execPath, ['src/cli.js', '--version'], {encoding: 'utf8'}).trim(), `bounce ${version}`);
});
test('release comparison is numeric and rejects invalid or prerelease versions', () => {
  assert.equal(newer('0.1.10', '0.1.9'), true);
  for (const value of ['0.1.3', '0.1.2', '0.1.4-beta.1', 'garbage', '01.2.3']) assert.equal(newer(value, '0.1.3'), false);
  assert.equal(newer('1.0.0', '0.99.99'), true);
});
test('checks cache for 24 hours, force refresh, and tolerate unwritable cache', async t => {
  const root = temp(t); let calls = 0;
  const run = async () => {calls++; return '"0.1.10"';};
  assert.equal((await checkUpdate({root, run, now: 100})).available, true);
  await checkUpdate({root, run, now: 200}); assert.equal(calls, 1);
  await checkUpdate({root, run, now: 200, force: true}); assert.equal(calls, 2);
  await checkUpdate({root, run, now: 86400200}); assert.equal(calls, 3);
  await checkUpdate({root: path.join(root, 'update-check.json'), run});
  await assert.rejects(checkUpdate({run: async () => '"bad"'}), /invalid/);
  await assert.rejects(checkUpdate({run: async () => {throw new Error('offline');}}), /offline/);
});
test('global detection rejects local installations and linked checkouts', async t => {
  const prefix = temp(t), root = path.join(prefix, 'lib/node_modules/bouncerouter');
  fs.mkdirSync(root, {recursive: true});
  const run = async () => prefix;
  assert.equal(await globalInstall({root, run, platform: 'linux'}), prefix);
  await assert.rejects(globalInstall({root: prefix, run, platform: 'linux'}), /global npm/);
  fs.rmdirSync(root); const checkout = path.join(prefix, 'checkout'); fs.mkdirSync(checkout);
  fs.symlinkSync(checkout, root);
  await assert.rejects(globalInstall({root: checkout, run, platform: 'linux'}), /global npm/);
});
test('install pins checked version and detected prefix; failures propagate without sudo', async () => {
  const calls = [], detect = async () => '/custom/prefix';
  const run = async (args) => {calls.push(args); return '"0.1.10"';};
  assert.match(await installUpdate({run, detect}), /0.1.10/);
  assert.deepEqual(calls[1], ['install', '--global', '--prefix', '/custom/prefix', 'bouncerouter@0.1.10']);
  let installs = 0;
  await installUpdate({detect, run: async args => {if (args[0] === 'install') installs++; return JSON.stringify(version);}});
  assert.equal(installs, 0);
  await assert.rejects(installUpdate({detect, run: async args => {if (args[0] === 'install') throw new Error('EACCES'); return '"0.1.10"';}}), /EACCES/);
});
