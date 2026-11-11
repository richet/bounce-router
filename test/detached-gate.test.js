// The orchestrator's Claude Code hook: a gate started in the background is refused with what to do instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {detachedGate, REFUSAL} from '../src/hooks/detached-gate.js';
import {settingsFor, DETACHED_GATE_HOOK} from '../src/adapters/claude-live.js';

const bash = (command, extra = {}) => ({tool_name: 'Bash', tool_input: {command, ...extra}});

test('a gate started in the background is refused; in the foreground, or any other command, it passes', () => {
  const refused = [
    'setsid just run test:e2e > /tmp/gate.log 2>&1 < /dev/null &',
    'nohup npm test > gate.log 2>&1 &',
    'cd web && npm run lint &',
    'docker compose run web lint & npm test',
    'tmux new -d -s gate "make e2e"',
    './scripts/integration-check.sh &> out.log &',
  ];
  for (const command of refused) assert.equal(detachedGate(bash(command)), REFUSAL, command);
  assert.equal(detachedGate(bash('docker compose run --rm web test', {run_in_background: true})), REFUSAL, 'run_in_background');
  const passed = [
    'docker compose run web test',
    'docker compose run web rails console &',
    'npm test 2>&1 | tail -20',
    'npm ci && npm test',
    'git log --oneline -5 &',
    'sleep 600 &',
    'nohup ./server.js &',
  ];
  for (const command of passed) assert.equal(detachedGate(bash(command)), null, command);
  assert.equal(detachedGate({tool_name: 'Read', tool_input: {file_path: 'x &'}}), null);
});

test('the hook script blocks with exit 2 and the refusal on stderr, and lets the rest through with exit 0', () => {
  const run = input => spawnSync(process.execPath, [DETACHED_GATE_HOOK], {input: JSON.stringify(input), encoding: 'utf8', timeout: 10000});
  const blocked = run(bash('nohup make e2e &'));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /^bounce refused this: a gate or check started in the background runs outside bounce.*check-only task.*at.*check.*checkTimeoutMinutes \(up to 120\)/);
  const passed = run(bash('make test'));
  assert.equal(passed.status, 0);
  assert.equal(passed.stderr, '');
  assert.equal(spawnSync(process.execPath, [DETACHED_GATE_HOOK], {input: 'not json', encoding: 'utf8', timeout: 10000}).status, 0, 'unreadable input never blocks');
});

test('only the orchestrator\'s claude gets the hook', () => {
  const orchestrator = JSON.parse(settingsFor('/d', {orchestrator: true}));
  assert.deepEqual(orchestrator.hooks.PreToolUse.map(entry => entry.matcher), ['Bash']);
  assert.match(orchestrator.hooks.PreToolUse[0].hooks[0].command, /^node '.*src\/hooks\/detached-gate\.js'$/);
  assert.equal(orchestrator.hooks.SessionStart.length, 1);
  assert.equal(JSON.parse(settingsFor('/d')).hooks.PreToolUse, undefined);
});
