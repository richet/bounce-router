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

// Taken names come from the validated table: a shipped profile the config never names is
// refused, so a local worker can never shadow it by accident; one the overlay dropped is free.
test('setup refuses a shipped profile name the config never wrote, and accepts one the overlay dropped', () => {
  const settings = {operation: 'orchestrator', mode: 'yolo', profiles: {}};
  assert.throws(() => previewLocalProfile({settings, name: 'build', options: {}}), /Profile build already exists/);
  assert.throws(() => previewLocalProfile({settings, name: 'claude_haiku', options: {}}), /Profile claude_haiku already exists/);
  const dropped = {operation: 'orchestrator', mode: 'yolo', profiles: {build: null}};
  const result = previewLocalProfile({settings: dropped, name: 'build', options: {}});
  assert.equal(result.profile.adapter, 'local');
  assert.deepEqual(Object.keys(result.settings.profiles), ['build'], 'the overlay only, never a copy of the roster');
});
