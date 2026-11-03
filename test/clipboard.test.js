// Copying a selection reaches the system clipboard however bounce is run: OSC 52 through the terminal (which
// also works over SSH), wrapped for tmux, and a clipboard tool when one is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {osc52, clipboardTools, copyToClipboard} from '../src/clipboard.js';

test('osc52 is the base64 of the text to the clipboard selection; inside tmux it is wrapped so tmux passes it on', () => {
  assert.equal(osc52('héllo', {}), `\x1b]52;c;${Buffer.from('héllo').toString('base64')}\x07`);
  assert.equal(osc52('hi', {TMUX: '/tmp/tmux-1/default,1,0'}), `\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\`);
});

test('the clipboard tools tried are the ones this desktop has, in order', () => {
  const has = new Set(['wl-copy', 'xclip']);
  const found = name => has.has(name);
  assert.deepEqual(clipboardTools({env: {WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0'}, platform: 'linux', found}).map(t => t[0]), ['wl-copy', 'xclip']);
  assert.deepEqual(clipboardTools({env: {DISPLAY: ':0'}, platform: 'linux', found}).map(t => t[0]), ['xclip']);
  assert.deepEqual(clipboardTools({env: {}, platform: 'linux', found}), [], 'no desktop: the terminal alone');
  assert.deepEqual(clipboardTools({env: {}, platform: 'darwin', found: () => true}).map(t => t[0]), ['pbcopy']);
});

test('copyToClipboard writes OSC 52 and hands the text to the first tool, and says how it copied', async () => {
  const written = [];
  const fed = [];
  const spawn = (command, args) => {
    const child = {stdin: {end: text => { fed.push([command, args, text]); queueMicrotask(() => child.onClose(0)); }}, on: (event, fn) => { if (event === 'close') child.onClose = fn; if (event === 'error') child.onError = fn; }};
    return child;
  };
  const result = await copyToClipboard('two\nlines', {write: chunk => written.push(chunk), env: {WAYLAND_DISPLAY: 'w'}, platform: 'linux', found: name => name === 'wl-copy', spawn});
  assert.deepEqual(written, [osc52('two\nlines', {WAYLAND_DISPLAY: 'w'})]);
  assert.deepEqual(fed, [['wl-copy', [], 'two\nlines']]);
  assert.deepEqual(result, {lines: 2, via: ['terminal', 'wl-copy']});
});

test('a clipboard tool that fails leaves the terminal copy standing', async () => {
  const spawn = () => { const child = {stdin: {end: () => queueMicrotask(() => child.onError(new Error('boom')))}, on: (event, fn) => { if (event === 'error') child.onError = fn; }}; return child; };
  const result = await copyToClipboard('x', {write: () => true, env: {DISPLAY: ':0'}, platform: 'linux', found: () => true, spawn});
  assert.deepEqual(result.via, ['terminal']);
});
