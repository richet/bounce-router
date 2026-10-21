import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveExecutable} from '../src/executable.js';
import {CONTRACT} from '../src/adapters/opencode-live.js';
import {parseOpencodeVersion} from '../src/opencode-version.js';

// Every local-worker defect that reached a user in 2026-09 was a belief about the opencode binary
// that nobody had checked against the binary (docs/plans/local-design-v2.md §0). This holds the
// INSTALLED binary to what the adapter takes on faith. Skipped where opencode is not installed.
const binary = resolveExecutable('opencode');
const installed = path.isAbsolute(binary) && fs.existsSync(binary);
const skip = installed ? false : 'opencode is not installed on this machine';
const reported = () => execFileSync(binary, ['--version'], {encoding: 'utf8', timeout: 20000}).trim().split('\n')[0];

test('the installed opencode is a version the adapter was verified against', {skip}, () => {
  const version = parseOpencodeVersion(reported())?.version ?? reported();
  assert.equal(CONTRACT.versions.includes(version), true,
    `opencode ${version} has not been verified. Run the live suite (BOUNCE_LIVE_OPENCODE=1 node --test test/local-opencode.live.test.js); if it passes, add '${version}' to VERIFIED in src/opencode-version.js.`);
});

test('every flag, env var, event name and tool id the adapter depends on exists in the installed binary', {skip}, () => {
  const image = fs.readFileSync(binary);
  // The adapter drives each major differently, so the binary is held to its own major's contract.
  const literals = CONTRACT.literals[parseOpencodeVersion(reported())?.major] ?? [];
  const missing = literals.filter(literal => !image.includes(literal));
  assert.deepEqual(missing, [], `not found in ${binary}: ${missing.join(', ')}`);
  assert.equal(literals.length >= 20, true, 'the contract is not silently emptied');
  // The mistake that cost two live runs: a name the binary never emits.
  assert.equal(image.includes('"permission.updated"'), false, 'control: a literal the binary does NOT contain is reported as absent');
});
