// Found live: the header said `codex` while the orchestrator ran on Claude. It read the classic
// routing order (`codex` first in the config); in orchestrator mode what runs is the orchestrator
// profile's adapter and model, and that is what the header must name.
import test from 'node:test';
import assert from 'node:assert/strict';
import {headerProvider, chooseModel, chooseOrder} from '../src/cli-view.js';

test('the header names what actually runs: the orchestrator profile in orchestrator mode, the routing selection in classic mode', () => {
  const settings = {order: ['codex', 'claude'], models: {codex: 'gpt-6-astra', claude: ''}};
  const orchestration = {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'claude', model: 'opus'}}};
  assert.deepEqual(headerProvider({settings, orchestration, active: null}), {provider: 'claude', model: 'opus'});
  assert.deepEqual(headerProvider({settings, orchestration: {...orchestration, profiles: {main: {adapter: 'claude', model: ''}}}, active: null}), {provider: 'claude', model: ''});
  assert.deepEqual(headerProvider({settings, orchestration: {operation: 'classic'}, active: null}), {provider: 'codex', model: 'gpt-6-astra'});
  assert.deepEqual(headerProvider({settings, orchestration: {operation: 'classic'}, active: 'claude'}), {provider: 'claude', model: ''}, 'classic: the session\'s active provider wins');
});

// Found live: `/model gpt-6-astra` and `/order codex,claude` were typed to move the orchestrator to
// codex; both wrote classic settings nothing in orchestrator mode reads, and the orchestrator went
// on running on Claude from `profiles.main.adapter`. A choice lands where the turn runs from.
test('a model choice in orchestrator mode becomes the orchestrator profile; in classic mode the routing order and model', () => {
  const settings = {order: ['codex', 'claude'], models: {codex: '', claude: ''}, profiles: {main: {adapter: 'claude'}, build: {adapter: 'codex'}}, orchestrator: 'main'};
  const orchestration = {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'claude', model: ''}}};
  assert.deepEqual(chooseModel(settings, orchestration, {provider: 'codex', model: 'gpt-6-astra'}), {provider: 'codex', model: 'gpt-6-astra'});
  assert.deepEqual(settings.profiles.main, {adapter: 'codex', model: 'gpt-6-astra'});
  assert.deepEqual(settings.profiles.build, {adapter: 'codex'}, 'other profiles are untouched');
  assert.equal(settings.models.codex, 'gpt-6-astra');
  assert.deepEqual(settings.order, ['codex', 'claude'], 'the chosen agent leads the fallback order');
  chooseModel(settings, orchestration, {provider: 'claude', model: ''});
  assert.deepEqual(settings.profiles.main, {adapter: 'claude', model: ''});
  assert.deepEqual(settings.order, ['claude', 'codex']);

  const classic = {order: ['codex', 'claude'], models: {codex: '', claude: ''}, profiles: {main: {adapter: 'claude'}}};
  chooseModel(classic, {operation: 'classic'}, {provider: 'claude', model: 'opus'});
  assert.deepEqual(classic.profiles.main, {adapter: 'claude'}, 'classic mode never touches a profile');
  assert.equal(classic.models.claude, 'opus');
  assert.deepEqual(classic.order, ['claude', 'codex']);
});

test('an order choice in orchestrator mode moves the orchestrator to the first agent, with that agent\'s model', () => {
  const settings = {order: ['claude', 'codex'], models: {codex: 'gpt-6-astra', claude: 'opus'}, profiles: {main: {adapter: 'claude', model: 'opus'}}, orchestrator: 'main'};
  const orchestration = {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'claude', model: 'opus'}}};
  assert.deepEqual(chooseOrder(settings, orchestration, ['codex', 'claude']), {provider: 'codex', model: 'gpt-6-astra'});
  assert.deepEqual(settings.profiles.main, {adapter: 'codex', model: 'gpt-6-astra'});
  assert.deepEqual(settings.order, ['codex', 'claude']);
  const classic = {order: ['claude', 'codex'], models: {}, profiles: {main: {adapter: 'claude'}}};
  assert.deepEqual(chooseOrder(classic, {operation: 'classic'}, ['codex', 'claude']), {provider: 'codex', model: ''});
  assert.deepEqual(classic.profiles.main, {adapter: 'claude'});
});

test('the header falls back to the per-agent model when the orchestrator profile names none, as the daemon does', () => {
  const settings = {order: ['codex'], models: {codex: 'gpt-6-astra'}};
  const orchestration = {operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'codex', model: ''}}};
  assert.deepEqual(headerProvider({settings, orchestration, active: null}), {provider: 'codex', model: 'gpt-6-astra'});
});
