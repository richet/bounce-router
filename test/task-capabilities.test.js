import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequirements, taskCapabilities, missingCapabilities} from '../src/task-capabilities.js';

test('requirements are optional for legacy tasks and otherwise must be capability enums', () => {
  assert.equal(validateRequirements(undefined), null);
  assert.equal(validateRequirements([]), null);
  assert.match(validateRequirements('read'), /array/);
  assert.match(validateRequirements(['read', 'shell']), /read, exec, write/);
});

test('effective capability derives from policy and adapter rather than claimed task text', () => {
  assert.deepEqual(taskCapabilities({adapter: 'claude', policy: 'read-only'}), ['read']);
  assert.deepEqual(taskCapabilities({adapter: 'claude', policy: 'probe'}), ['read', 'exec']);
  assert.deepEqual(taskCapabilities({adapter: 'claude', policy: 'write', mode: 'yolo'}), ['read', 'exec', 'write']);
  assert.deepEqual(taskCapabilities({adapter: 'opencode', policy: 'write', mode: 'plan'}), ['read']);
  assert.deepEqual(taskCapabilities({adapter: 'opencode', policy: 'probe'}), ['read', 'exec']);
  assert.deepEqual(taskCapabilities({adapter: 'opencode', policy: 'write', mode: 'yolo'}), ['read', 'exec', 'write']);
  assert.deepEqual(taskCapabilities({adapter: 'local', policy: 'write', mode: 'yolo'}), ['read']);
  assert.deepEqual(taskCapabilities({adapter: 'typesafe', policy: 'write', mode: 'yolo'}), ['read']);
  assert.deepEqual(missingCapabilities({adapter: 'claude', policy: 'read-only'}, ['read', 'exec']), ['exec']);
  assert.deepEqual(missingCapabilities({adapter: 'claude', policy: 'read-only'}, 'exec'), []);
});
