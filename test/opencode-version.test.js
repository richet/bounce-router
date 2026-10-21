import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseOpencodeVersion, opencodeVersion, opencodeStatus, fixOpencode, FIX_VERSION} from '../src/opencode-version.js';

// 1.x and 2.x are driven differently (src/adapters/opencode-live.js), and `--version` says which:
// 1.x prints the bare version, 2.x the command name and a v. Both read live from the real binaries.
test('parseOpencodeVersion reads both majors\' --version, colours or not, and nothing else', () => {
  assert.deepEqual(parseOpencodeVersion('1.18.31\n'), {version: '1.18.31', major: 1});
  assert.deepEqual(parseOpencodeVersion('opencode v2.0.29\n'), {version: '2.0.29', major: 2});
  assert.deepEqual(parseOpencodeVersion('\x1b[1mopencode\x1b[0m v2.0.29'), {version: '2.0.29', major: 2});
  for (const other of ['', 'garbage', '{"type":"step_start"}', 'v2']) assert.equal(parseOpencodeVersion(other), null, other);
});

test('opencodeVersion asks a binary once, and says why when it cannot tell', () => {
  let calls = 0;
  const run = () => { calls++; return 'opencode v2.0.29\n'; };
  assert.deepEqual(opencodeVersion('/fake/once/opencode', {run}), {version: '2.0.29', major: 2});
  assert.deepEqual(opencodeVersion('/fake/once/opencode', {run}), {version: '2.0.29', major: 2});
  assert.equal(calls, 1);
  assert.deepEqual(opencodeVersion('/fake/missing/opencode', {run: () => { throw Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'}); }}), {error: 'not installed'});
  assert.deepEqual(opencodeVersion('/fake/odd/opencode', {run: () => 'hello'}), {error: 'unrecognised --version output'});
});

test('opencodeStatus: verified, supported but unverified, and the two that --fix repairs', () => {
  assert.deepEqual(opencodeStatus({version: '2.0.29', major: 2}), {ok: true, text: '2.0.29 · verified'});
  assert.deepEqual(opencodeStatus({version: '1.18.31', major: 1}), {ok: true, text: '1.18.31 · verified'});
  assert.equal(opencodeStatus({version: '2.1.0', major: 2}).ok, true);
  assert.match(opencodeStatus({version: '2.1.0', major: 2}).text, /2\.x is supported, this version unverified/);
  assert.deepEqual(opencodeStatus({version: '3.0.0', major: 3}), {ok: false, fixable: true, text: '3.0.0 · unsupported: local workers run on opencode 1.x or 2.x'});
  assert.deepEqual(opencodeStatus({error: 'not installed'}), {ok: false, fixable: true, text: 'not installed'});
});

test('fixOpencode installs the verified release under the data root, runs its postinstall when npm skipped it, and changes only executables.opencode', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-oc-fix-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({order: ['claude'], executables: {codex: '/opt/codex'}}));
  const calls = []; let linked = false;
  const exec = (file, args, options = {}) => {
    calls.push([path.basename(file), ...args.slice(0, 1), options.cwd ? path.relative(root, options.cwd) : null]);
    if (file === 'npm') return '';
    if (args[0] === 'postinstall.mjs') { linked = true; return ''; }
    if (!linked) throw new Error('opencode-ai\'s postinstall script was not run');
    return `${FIX_VERSION}\n`;
  };
  const fixed = fixOpencode({root, exec});
  const binary = path.join(root, 'opencode', FIX_VERSION, 'node_modules', '.bin', 'opencode');
  assert.deepEqual(fixed, {binary, version: FIX_VERSION});
  assert.deepEqual(calls.map(call => call[0] === path.basename(process.execPath) ? 'node' : call[0]), ['npm', 'opencode', 'node', 'opencode']);
  assert.equal(calls[2][2], path.join('opencode', FIX_VERSION, 'node_modules', 'opencode-ai'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')), {order: ['claude'], executables: {codex: '/opt/codex', opencode: binary}});
  assert.throws(() => fixOpencode({root, exec: (file, args) => file === 'npm' || args[0] === 'postinstall.mjs' ? '' : 'opencode v9.9.9'}), /did not report 1\.18\.31/);
});
