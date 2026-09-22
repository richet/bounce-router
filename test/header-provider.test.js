// Found live: the header said `codex` while the orchestrator ran on Claude. It read the classic
// routing order (`codex` first in the config); in orchestrator mode what runs is the orchestrator
// profile's adapter and model, and that is what the header must name.
import test from 'node:test';
import assert from 'node:assert/strict';
import {headerProvider} from '../src/cli-view.js';

test('the header names what actually runs: the orchestrator profile in orchestrator mode, the routing selection in classic mode', () => {
  const settings = {order: ['codex', 'claude'], models: {codex: 'gpt-6-astra', claude: ''}};
  const orchestration = {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'claude', model: 'opus'}}};
  assert.deepEqual(headerProvider({settings, orchestration, active: null}), {provider: 'claude', model: 'opus'});
  assert.deepEqual(headerProvider({settings, orchestration: {...orchestration, profiles: {main: {adapter: 'claude', model: ''}}}, active: null}), {provider: 'claude', model: ''});
  assert.deepEqual(headerProvider({settings, orchestration: {operation: 'classic'}, active: null}), {provider: 'codex', model: 'gpt-6-astra'});
  assert.deepEqual(headerProvider({settings, orchestration: {operation: 'classic'}, active: 'claude'}), {provider: 'claude', model: ''}, 'classic: the session\'s active provider wins');
});
