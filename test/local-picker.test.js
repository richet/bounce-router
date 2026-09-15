import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localModelEntries, selectWorkerModel} from '../src/local-picker.js';

const catalogs = [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', stale: false,
  models: [{id: 'coder', ref: 'lmstudio/coder', label: 'Coder', type: 'llm', ready: true,
    tools: true, capabilitySource: 'server', context: 8192, instances: [{id: 'loaded', context: 8192}]},
  {id: 'embed', ref: 'lmstudio/embed', label: 'Embedding', type: 'embedding', ready: false, tools: false}]}];
const settings = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', models: {claude: 'sonnet'},
  profiles: {main: {adapter: 'claude'}, scout: {adapter: 'local', role: 'analyst'}}};

test('worker picker distinguishes readiness and never changes the orchestrator selection', () => {
  const entries = localModelEntries({catalogs, settings, profileName: 'scout'});
  assert.equal(entries[0].id, 'auto');
  assert.equal(entries[1].disabled, false);
  assert.match(entries[1].description, /loaded.*tools: yes.*server/);
  assert.equal(entries[2].disabled, true);
  const next = selectWorkerModel({settings, profileName: 'scout', ref: 'lmstudio/coder'});
  assert.equal(next.profiles.scout.model, 'coder');
  assert.equal(next.profiles.scout.endpoint, 'lmstudio');
  assert.deepEqual(next.models, settings.models);
  assert.equal(settings.profiles.scout.model, undefined);
  assert.equal(selectWorkerModel({settings: next, profileName: 'scout', ref: 'auto'}).profiles.scout.model, 'auto');
});
