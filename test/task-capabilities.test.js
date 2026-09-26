import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequirements, taskCapabilities, missingCapabilities} from '../src/task-capabilities.js';

test('requirements are optional for legacy tasks and otherwise must be capability enums', () => {
  assert.equal(validateRequirements(undefined), null);
  assert.equal(validateRequirements([]), null);
  assert.equal(validateRequirements(['docker']), null);
  assert.match(validateRequirements('read'), /array/);
  assert.match(validateRequirements(['read', 'shell']), /read, exec, write, docker/);
});

test('effective capability derives from policy and adapter rather than claimed task text', () => {
  assert.deepEqual(taskCapabilities({adapter: 'claude', policy: 'read-only'}), ['read']);
  assert.deepEqual(taskCapabilities({adapter: 'claude', policy: 'probe'}), ['read', 'exec']);
  assert.deepEqual(taskCapabilities({adapter: 'claude', policy: 'write', mode: 'yolo'}), ['read', 'exec', 'write', 'docker']);
  assert.deepEqual(taskCapabilities({adapter: 'opencode', policy: 'write', mode: 'plan'}), ['read']);
  assert.deepEqual(taskCapabilities({adapter: 'opencode', policy: 'probe'}), ['read', 'exec']);
  assert.deepEqual(taskCapabilities({adapter: 'opencode', policy: 'write', mode: 'yolo'}), ['read', 'exec', 'write', 'docker']);
  assert.deepEqual(taskCapabilities({adapter: 'local', policy: 'write', mode: 'yolo'}), ['read']);
  assert.deepEqual(taskCapabilities({adapter: 'typesafe', policy: 'write', mode: 'yolo'}), ['read']);
  assert.deepEqual(missingCapabilities({adapter: 'claude', policy: 'read-only'}, ['read', 'exec']), ['exec']);
  assert.deepEqual(missingCapabilities({adapter: 'claude', policy: 'read-only'}, 'exec'), []);
});

test('docker only for workers that may write: no probe gets it on any adapter, since a container can write the checkout', () => {
  assert.deepEqual(taskCapabilities({adapter: 'codex', policy: 'probe'}), ['read', 'exec']);
  assert.deepEqual(missingCapabilities({adapter: 'codex', policy: 'probe'}, ['docker']), ['docker']);
  assert.deepEqual(missingCapabilities({adapter: 'opencode', policy: 'probe'}, ['docker']), ['docker']);
  // a full write/yolo worker (any adapter) already runs unsandboxed or write-fenced only against
  // the source checkout, so the socket is already reachable with no extra wiring.
  assert.deepEqual(missingCapabilities({adapter: 'codex', policy: 'write', mode: 'yolo'}, ['docker']), []);
  assert.deepEqual(missingCapabilities({adapter: 'claude', policy: 'read-only'}, ['docker']), ['docker']);
});
