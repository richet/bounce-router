import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewLocalProfile} from '../src/local-setup.js';

test('setup previews explicit Docker builder permissions without mutating settings', () => {
  const settings = {operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', profiles: {main: {adapter: 'claude'}}};
  const before = structuredClone(settings);
  const result = previewLocalProfile({settings, name: 'local_build', options: {policy: 'write', writePaths: ['src'], commands: ['node --test']}});
  assert.deepEqual(settings, before);
  assert.equal(result.profile.adapter, 'local');
  assert.equal(result.profile.model, 'auto');
  assert.equal(result.profile.container.image, 'node:22-alpine');
  assert.deepEqual(result.profile.commands, ['node --test']);
  assert.throws(() => previewLocalProfile({settings, name: 'main', options: {}}), /exists/);
  assert.throws(() => previewLocalProfile({settings, name: 'bad', options: {adapter: 'claude'}}), /adapter/);
});
