import test from 'node:test';
import assert from 'node:assert/strict';
import {commandCatalog, classifyInput, inputDisposition} from '../src/commands.js';

test('classifyInput classifies every TUI command exactly once', () => {
  const expected = {
    immediate: ['provider', 'model', 'local', 'order', 'mode', 'note', 'btw', 'steer', 'rename', 'sessions', 'skills', 'review', 'quota', 'retry', 'operation', 'stop', 'msg', 'agents', 'tasks', 'help', 'detach', 'details', 'sidebar', 'jev'],
    turn: ['continue'],
    lifecycle: ['login', 'new', 'resume', 'update', 'restart', 'quit'],
  };
  assert.deepEqual(commandCatalog, expected);

  const seen = [];
  for (const [kind, commands] of Object.entries(commandCatalog)) {
    for (const command of commands) {
      const result = classifyInput(`/${command} first second`);
      assert.deepEqual(result, {kind, command, parts: ['first', 'second'], arg: 'first second'});
      seen.push(command);
    }
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 31);
});

test('classifyInput folds /typesafe into /jev, keeping its arguments', () => {
  assert.deepEqual(classifyInput('/typesafe key clear'), {kind: 'immediate', command: 'jev', parts: ['key', 'clear'], arg: 'key clear'});
  assert.deepEqual(classifyInput('/JEV'), {kind: 'immediate', command: 'jev', parts: [], arg: ''});
});

test('classifyInput preserves prompt input and parses command arguments once', () => {
  assert.deepEqual(classifyInput('ordinary text'), {kind: 'prompt', text: 'ordinary text'});
  assert.deepEqual(classifyInput('  ordinary text  '), {kind: 'prompt', text: '  ordinary text  '});
  assert.deepEqual(classifyInput('/BTW   save this thought  '), {
    kind: 'immediate', command: 'btw', parts: ['save', 'this', 'thought'], arg: 'save this thought',
  });
});

test('classifyInput keeps unknown slash input out of the turn queue', () => {
  assert.deepEqual(classifyInput('/unknown details'), {
    kind: 'immediate', command: 'unknown', parts: ['details'], arg: 'details', unknown: true,
  });
  assert.deepEqual(classifyInput('/'), {kind: 'immediate', command: '', parts: [], arg: '', unknown: true});
});

test('inputDisposition queues only turn-starting input while busy', () => {
  assert.deepEqual(inputDisposition('ordinary text', {busy: false}), {
    kind: 'prompt', text: 'ordinary text', action: 'run-turn',
  });
  assert.deepEqual(inputDisposition('ordinary text', {busy: true}), {
    kind: 'prompt', text: 'ordinary text', action: 'queue-turn',
  });
  assert.deepEqual(inputDisposition('/btw keep going', {busy: true}), {
    kind: 'immediate', command: 'btw', parts: ['keep', 'going'], arg: 'keep going', action: 'run-command',
  });
  assert.deepEqual(inputDisposition('/steer keep going', {busy: true}), {
    kind: 'immediate', command: 'steer', parts: ['keep', 'going'], arg: 'keep going', action: 'run-command',
  });
  assert.deepEqual(inputDisposition('/continue build', {busy: true}), {
    kind: 'turn', command: 'continue', parts: ['build'], arg: 'build', action: 'queue-turn',
  });
  assert.deepEqual(inputDisposition('/restart', {busy: true}), {
    kind: 'lifecycle', command: 'restart', parts: [], arg: '', action: 'run-command',
  });
  assert.deepEqual(inputDisposition('/unknown', {busy: true}), {
    kind: 'immediate', command: 'unknown', parts: [], arg: '', unknown: true, action: 'run-command',
  });
});
