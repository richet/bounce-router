import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

// Text selection the way a modern terminal app does it (docs/ARCHITECTURE.md § TUI). The workspace
// reports the regions it drew — the conversation, each pane's text, the sidebar — as rectangles on the screen with
// the rows shown in them (Workspace.js); a drag stays in the region it started in, so a selection never runs across
// a neighbouring pane or the sidebar the way the terminal's own selection would. Rows and columns are 0-based inside
// a region; a selection's end column is exclusive, and a column is a terminal cell (a wide character is two).

// Which of a region's rows each shown line is: `visible` when it shows only some of `rows` (scrolled, or a pane's
// header above its scrolled activity), else the first `height` rows.
const shown = region => region.visible ?? region.rows.slice(0, region.height).map((_, index) => index);

// The region under a 1-based terminal cell (what an SGR mouse report carries), and the row of `rows` and column there.
export function hitTest(regions = [], x, y) {
  const col = x - 1, line = y - 1;
  for (const region of regions) {
    if (col >= region.x && col < region.x + region.width && line >= region.y && line < region.y + region.height) {
      const row = shown(region)[line - region.y];
      return row === undefined ? null : {region, row, col: col - region.x};
    }
  }
  return null;
}

// Whether a row of `rows` is in the region's fixed header, above the part that scrolls.
export const inHeader = (region, row) => Boolean(region.scrollFrom) && row < (shown(region)[region.scrollFrom] ?? Infinity);

// A drag that leaves its region keeps selecting inside it: above or below the rows shown, the selection runs to the
// first or last shown row's edge; left or right of it, to its first or past its last column. `past` says the pointer
// is on or beyond the top or bottom row, so the caller scrolls the region: a region at the screen's top or bottom has
// no cell beyond it for the terminal to report.
// `scrollFrom` is the first shown line that scrolls (a pane's activity, under its fixed title and details): for a
// drag that began in the scrolling part, on or above that line the region scrolls and the selection runs from its
// first scrolled row. A drag that began in the header (`fromHeader`) selects header lines as they are.
export function clampToRegion(region, x, y, {fromHeader = false} = {}) {
  const lines = shown(region);
  const top = fromHeader ? 0 : Math.min(region.scrollFrom ?? 0, Math.max(0, lines.length - 1));
  const line = y - 1 - region.y, col = Math.min(Math.max(0, x - 1 - region.x), region.width);
  if (!lines.length) return {row: 0, col: 0};
  if (line < top) return {row: lines[top], col: 0, past: 'above'};
  if (line >= lines.length) return {row: lines.at(-1), col: region.width, past: 'below'};
  const edge = line === top && lines.length - top > 1 ? {past: 'above'} : line === lines.length - 1 && lines.length - top > 1 ? {past: 'below'} : {};
  return {row: lines[line], col, ...edge};
}

const before = (a, b) => a.row < b.row || (a.row === b.row && a.col <= b.col);
export function orderSelection({anchor, head}) {
  return before(anchor, head) ? {start: anchor, end: head} : {start: head, end: anchor};
}

// The columns of `row` (a rendered, possibly styled row) selected by `selection`, or null when none are.
export function rowRange(selection, row) {
  if (!selection) return null;
  const {start, end} = orderSelection(selection);
  if (row < start.row || row > end.row) return null;
  const from = row === start.row ? start.col : 0;
  const to = row === end.row ? end.col : Infinity;
  return to > from ? {from, to} : null;
}

// The row with columns [from, to) shown inverted. The selected part loses its own colours, as in a terminal; the
// rest keeps them.
export function highlightRow(text, from, to = Infinity) {
  const value = String(text ?? '');
  const width = stringWidth(value);
  if (from >= width || to <= from) return value;
  const end = Math.min(to, width);
  return `${sliceAnsi(value, 0, from)}\x1b[7m${stripAnsi(sliceAnsi(value, from, end))}\x1b[27m${sliceAnsi(value, end)}`;
}

// What a selection copies: plain text, the rows joined by newlines, each without its trailing spaces.
export function selectedText(region, selection) {
  const {start, end} = orderSelection(selection);
  if (start.row === end.row && start.col === end.col) return '';
  const lines = [];
  for (let row = start.row; row <= end.row && row < region.rows.length; row++) {
    const plain = stripAnsi(String(region.rows[row] ?? ''));
    const range = rowRange(selection, row) ?? {from: 0, to: 0};
    lines.push(sliceAnsi(plain, range.from, range.to === Infinity ? undefined : range.to).trimEnd());
  }
  return lines.join('\n');
}

// The cells of a plain row: each grapheme with its starting column and width.
function cells(plain) {
  const out = [];
  let col = 0;
  for (const {segment} of new Intl.Segmenter().segment(plain)) {
    const width = stringWidth(segment);
    out.push({text: segment, col, width});
    col += width;
  }
  return out;
}

// The word under a column: the run of non-space characters around it, so a path with its line number
// (`src/a.js:12`) or a URL is one word. Whitespace selects nothing.
export function wordBounds(plain, col) {
  const all = cells(plain);
  const at = all.findIndex(cell => col >= cell.col && col < cell.col + cell.width);
  if (at < 0 || /\s/.test(all[at].text)) return {start: col, end: col};
  let first = at, last = at;
  while (first > 0 && !/\s/.test(all[first - 1].text)) first--;
  while (last < all.length - 1 && !/\s/.test(all[last + 1].text)) last++;
  return {start: all[first].col, end: all[last].col + all[last].width};
}

// A double-click selects the word under the pointer; a triple-click the whole row.
export function extendSelection(region, at, clicks) {
  const plain = stripAnsi(String(region.rows[at.row] ?? ''));
  if (clicks >= 3) return {anchor: {row: at.row, col: 0}, head: {row: at.row, col: stringWidth(plain.trimEnd())}};
  const {start, end} = wordBounds(plain, at.col);
  return {anchor: {row: at.row, col: start}, head: {row: at.row, col: end}};
}
