import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateOrchestration, effectivePolicy} from '../src/profiles.js';

const settings = (worker) => ({operation: 'orchestrator', mode: 'yolo', orchestrator: 'main',
  profiles: {main: {adapter: 'claude'}, worker: {adapter: 'local', ...worker}}});

test('local profiles preserve endpoint identity and explicit Docker write policy', () => {
  const view = validateOrchestration(settings({policy: 'write', writePaths: ['src'],
    commands: ['npm test'], container: {image: 'node:22-alpine'}}));
  const profile = view.profiles.worker;
  assert.equal(profile.backend, 'lmstudio');
  assert.equal(profile.endpoint, 'lmstudio');
  assert.deepEqual(profile.writePaths, ['src']);
  assert.deepEqual(profile.commands, ['npm test']);
  assert.equal(profile.container.image, 'node:22-alpine');
  assert.equal(effectivePolicy(profile), 'write');
  assert.equal(validateOrchestration(settings({})).profiles.worker.policy, 'read-only');
});

test('local profile rejects policy broadening and unsafe paths/options', () => {
  assert.throws(() => validateOrchestration(settings({commands: ['npm test']})), /read-only/);
  assert.throws(() => validateOrchestration(settings({policy: 'write'})), /writePaths/);
  for (const entry of ['../out', '/out', 'C:\\out', 'src/../../out', 'src/.git/config', 'a\u0000b']) {
    assert.throws(() => validateOrchestration(settings({policy: 'write', writePaths: [entry]})), /writePaths/);
  }
  assert.throws(() => validateOrchestration(settings({fallback: ['main']})), /localOnly/);
  assert.throws(() => validateOrchestration(settings({localOptions: {maxSteps: 1000000}})), /maxSteps/);
  assert.throws(() => validateOrchestration(settings({container: {privileged: true}})), /unsupported/);
  assert.equal(validateOrchestration(settings({localOnly: false, fallback: ['main']})).profiles.worker.localOnly, false);
});
