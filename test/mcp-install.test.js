// bounce registers its own MCP server (Daniel, 2026-09-22: "let bounce do it"), the way `skills sync` writes
// agent skill directories: idempotent, never touching an entry it did not write, and undoable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {codexEntry, withCodexEntry, withoutCodexEntry, MARKER} from '../src/mcp-install.js';

const existing = `model = "gpt-5.6-sol"

[mcp_servers.node_repl]
command = "node-repl-mcp"

[mcp_servers.node_repl.env]
NODE_ENV = "production"
`;

test('I1 the entry bounce writes, and writing it twice changes nothing', () => {
  assert.equal(codexEntry('/usr/local/bin/bounce'), `${MARKER}\n[mcp_servers.bounce]\ncommand = "/usr/local/bin/bounce"\nargs = ["mcp-serve"]\n`);
  const once = withCodexEntry(existing, '/usr/local/bin/bounce');
  assert.equal(once.changed, true);
  assert.equal(once.text.includes('[mcp_servers.node_repl]'), true, 'what was already there is untouched');
  assert.equal(once.text.endsWith(codexEntry('/usr/local/bin/bounce')), true);
  const twice = withCodexEntry(once.text, '/usr/local/bin/bounce');
  assert.deepEqual([twice.changed, twice.text], [false, once.text], 'idempotent');
  // a path change rewrites bounce's own entry, still leaving the others alone
  const moved = withCodexEntry(once.text, '/opt/bounce');
  assert.equal(moved.changed, true);
  assert.equal(moved.text.includes('command = "/opt/bounce"'), true);
  assert.equal(moved.text.includes('command = "/usr/local/bin/bounce"'), false);
  assert.equal(moved.text.includes('[mcp_servers.node_repl]'), true);
});

test('I2 an entry bounce did not write is left exactly as it is', () => {
  const hand = `${existing}\n[mcp_servers.bounce]\ncommand = "/somewhere/else/bounce"\nargs = ["mcp-serve", "--mine"]\n`;
  const result = withCodexEntry(hand, '/usr/local/bin/bounce');
  assert.deepEqual([result.changed, result.text, result.reason], [false, hand, 'left alone: not the entry bounce wrote']);
  assert.deepEqual(withoutCodexEntry(hand), {changed: false, text: hand, reason: 'left alone: not the entry bounce wrote'});
});

test('I3 undoing removes only what bounce wrote', () => {
  const {text} = withCodexEntry(existing, '/usr/local/bin/bounce');
  const removed = withoutCodexEntry(text);
  assert.equal(removed.changed, true);
  assert.equal(removed.text.includes('mcp_servers.bounce'), false);
  assert.equal(removed.text.includes('[mcp_servers.node_repl]'), true);
  assert.deepEqual(withoutCodexEntry(existing), {changed: false, text: existing, reason: 'nothing bounce wrote'});
});
