// Selecting and copying text the way a modern terminal app does (docs/plans/interactive-polish.md step 0): a drag
// stays inside the region it started in (the conversation, one pane, the sidebar), the release copies what was
// selected, and the wheel scrolls the region under the pointer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Chalk} from 'chalk';
import stripAnsi from 'strip-ansi';
import {hitTest, clampToRegion, orderSelection, highlightRow, selectedText, wordBounds, extendSelection} from '../src/tui/selection.js';

const color = new Chalk({level: 1});
const regions = [
  {id: 'orchestrator', x: 0, y: 0, width: 40, rows: ['first line', 'second line', 'third'], height: 10},
  {id: 'worker:a', x: 42, y: 0, width: 30, rows: ['● builder', 'editing src/a.js'], height: 10},
  {id: 'sidebar', x: 75, y: 0, width: 30, rows: ['BOUNCE', 'claude · yolo'], height: 20},
];

test('hitTest finds the region under a 1-based terminal cell, and the 0-based row and column inside it', () => {
  assert.deepEqual(hitTest(regions, 1, 1), {region: regions[0], row: 0, col: 0});
  assert.deepEqual(hitTest(regions, 45, 2), {region: regions[1], row: 1, col: 2});
  assert.equal(hitTest(regions, 41, 1), null, 'the gap between panes belongs to no region');
  assert.equal(hitTest(regions, 1, 12), null, 'below a region is outside it');
});

test('a drag that leaves its region is clamped to the region\'s edges, never crossing into a neighbour', () => {
  const region = regions[1];
  assert.deepEqual(clampToRegion(region, 10, 1), {row: 0, col: 0, past: 'above'}, 'left of the pane, on its top row: its first column, and the top edge');
  assert.deepEqual(clampToRegion(region, 200, 2), {row: 1, col: 30, past: 'below'}, 'right of the pane, on its last row: past its last column, and the bottom edge');
  assert.deepEqual(clampToRegion(region, 50, 40), {row: 1, col: 30, past: 'below'}, 'below the last row: the end of the last row');
});

test('a selection dragged upwards or leftwards is ordered start before end', () => {
  assert.deepEqual(orderSelection({anchor: {row: 2, col: 4}, head: {row: 0, col: 1}}), {start: {row: 0, col: 1}, end: {row: 2, col: 4}});
  assert.deepEqual(orderSelection({anchor: {row: 1, col: 6}, head: {row: 1, col: 2}}), {start: {row: 1, col: 2}, end: {row: 1, col: 6}});
});

test('highlightRow inverts exactly the selected columns, keeps the rest styled, and counts wide characters as two', () => {
  const row = `${color.green('ok')} done`;
  const marked = highlightRow(row, 3, 7);
  assert.equal(stripAnsi(marked), 'ok done', 'the text is unchanged');
  assert.match(marked, /\x1b\[7mdone\x1b\[27m/, 'the selected columns are inverted');
  assert.match(marked, /\x1b\[32mok/, 'the unselected part keeps its colour');
  assert.equal(stripAnsi(highlightRow('日本 語', 2, 4)), '日本 語');
  assert.match(highlightRow('日本 語', 2, 4), /\x1b\[7m本\x1b\[27m/, 'columns 2–3 are the second wide character');
  assert.equal(highlightRow('abc', 5, 9), 'abc', 'a range past the text changes nothing');
});

test('selectedText takes the columns of the first and last rows and every row between, without colour or trailing spaces', () => {
  const region = {rows: [color.cyan('alpha beta   '), 'gamma delta', 'epsilon zeta']};
  assert.equal(selectedText(region, {anchor: {row: 0, col: 6}, head: {row: 2, col: 7}}), 'beta\ngamma delta\nepsilon');
  assert.equal(selectedText(region, {anchor: {row: 1, col: 9}, head: {row: 1, col: 6}}), 'del', 'dragged leftwards on one row');
  assert.equal(selectedText(region, {anchor: {row: 1, col: 3}, head: {row: 1, col: 3}}), '', 'a plain click selects nothing');
});

test('a double-click selects the word under it; a triple-click the whole row', () => {
  assert.deepEqual(wordBounds('run npm test now', 6), {start: 4, end: 7});
  assert.deepEqual(wordBounds('path/to/file.js:12 failed', 3), {start: 0, end: 18}, 'a path with its line number is one word');
  assert.deepEqual(wordBounds('a  b', 1), {start: 1, end: 1}, 'whitespace selects nothing');
  const region = {rows: ['first line', 'second line']};
  assert.deepEqual(extendSelection(region, {row: 1, col: 2}, 2), {anchor: {row: 1, col: 0}, head: {row: 1, col: 6}});
  assert.deepEqual(extendSelection(region, {row: 1, col: 2}, 3), {anchor: {row: 1, col: 0}, head: {row: 1, col: 11}});
  assert.equal(selectedText(region, extendSelection(region, {row: 0, col: 7}, 2)), 'line');
});


// A region can hold more rows than it shows (a scrolled transcript, a pane's activity under its header): `visible`
// maps each shown row to its row in `rows`, so a selection can grow past the edge as the region scrolls.
test('a region with more rows than it shows hits and clamps to the rows it shows, and says when the pointer is past an edge', () => {
  const region = {id: 'r', x: 0, y: 0, width: 20, height: 3, rows: ['h', 'a0', 'a1', 'a2', 'a3', 'a4'], visible: [0, 3, 4]};
  assert.deepEqual(hitTest([region], 3, 2), {region, row: 3, col: 2});
  assert.deepEqual(clampToRegion(region, 5, 0), {row: 0, col: 0, past: 'above'});
  assert.deepEqual(clampToRegion(region, 5, 9), {row: 4, col: 20, past: 'below'});
  assert.deepEqual(clampToRegion(region, 5, 2), {row: 3, col: 4}, 'a middle row is not an edge');
  assert.deepEqual(clampToRegion(region, 5, 3), {row: 4, col: 4, past: 'below'}, 'the last shown row is the bottom edge');
});

test('a pane\'s fixed header is above its scrolling part: reaching the first scrolled line is the top edge', () => {
  const region = {id: 'p', x: 0, y: 0, width: 20, height: 4, rows: ['title', 'detail', 'a0', 'a1', 'a2', 'a3'], visible: [0, 1, 4, 5], scrollFrom: 2};
  assert.deepEqual(clampToRegion(region, 3, 1), {row: 4, col: 0, past: 'above'}, 'on the title: scroll, from the first scrolled row');
  assert.deepEqual(clampToRegion(region, 3, 3), {row: 4, col: 2, past: 'above'}, 'on the first scrolled line');
  assert.deepEqual(clampToRegion(region, 3, 4), {row: 5, col: 2, past: 'below'});
});
