import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

export const commands = [
  ['provider', 'Select default agent'], ['model', 'Select model'], ['order', 'Set fallback order'],
  ['mode', 'Set yolo or plan mode'], ['login', 'Sign in to an agent'], ['new', 'Start new session'],
  ['note', 'Save handoff note'], ['retry', 'Clear quota cooldowns'], ['restart', 'Validate and reload'],
  ['help', 'Show help'], ['quit', 'Exit localrouter'],
];
export function completions(input) {
  if (!/^\/\S*$/.test(input)) return [];
  return commands.filter(([name]) => name.startsWith(input.slice(1)));
}
// Update only changed rows. An unchanged frame produces no terminal writes.
export function frameDiff(previous, next) {
  let output = '';
  for (let i = 0; i < Math.max(previous.length, next.length); i++) {
    if (previous[i] !== next[i]) output += `\x1b[${i + 1};1H\x1b[2K${next[i] || ''}`;
  }
  return output;
}

// SGR mouse reports can arrive across multiple stdin chunks. Remove every mouse
// report before readline sees it, so clicks cannot become prompt text.
export const mouseTracking = enabled => enabled
  ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l';
export function createMouseInput(onText, onScroll) {
  let pending = '';
  const consume = chunk => {
    pending += chunk;
    while (pending) {
      const start = pending.indexOf('\x1b[<');
      if (start < 0) {
        const keep = pending.endsWith('\x1b[') ? 2 : pending.endsWith('\x1b') ? 1 : 0;
        if (pending.length > keep) onText(pending.slice(0, pending.length - keep));
        pending = keep ? pending.slice(-keep) : '';
        return;
      }
      if (start) onText(pending.slice(0, start));
      pending = pending.slice(start);
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(pending);
      if (!match) {
        if (/^\x1b\[<[\d;]*$/.test(pending) && pending.length < 64) return;
        onText(pending.slice(0, 3)); pending = pending.slice(3); continue;
      }
      const button = Number(match[1]);
      if (match[4] === 'M' && (button & 64) && !(button & 2)) onScroll(button & 1 ? -3 : 3);
      pending = pending.slice(match[0].length);
    }
  };
  consume.flush = () => { if (pending) onText(pending); pending = ''; };
  return consume;
}

// Keep pasted newlines/control keys out of readline's command dispatch.
export function createPasteInput(onKeys, onPaste) {
  let pending = '', pasted = '', active = false;
  const start = '\x1b[200~', end = '\x1b[201~';
  const feed = chunk => {
    pending += chunk;
    while (pending) {
      const marker = active ? end : start;
      const index = pending.indexOf(marker);
      if (index >= 0) {
        if (active) { pasted += pending.slice(0, index); onPaste(pasted); pasted = ''; }
        else if (index) onKeys(pending.slice(0, index));
        pending = pending.slice(index + marker.length); active = !active;
      } else {
        let keep = Math.min(marker.length - 1, pending.length);
        while (keep && !marker.startsWith(pending.slice(-keep))) keep--;
        const text = pending.slice(0, pending.length - keep);
        if (active) pasted += text; else if (text) onKeys(text);
        pending = pending.slice(pending.length - keep);
        return;
      }
    }
  };
  feed.flush = () => { if (!active && pending) { onKeys(pending); pending = ''; } };
  return feed;
}

// Reserve a cell for the native cursor, including after an exactly full line.
export function inputLayout(text, width, maxRows) {
  width = Math.max(2, width);
  const rows = wrapAnsi(text, width, {hard: true, trim: false, wordWrap: false}).split('\n');
  if (stringWidth(rows.at(-1)) >= width) rows.push('');
  const visible = rows.slice(-Math.max(1, maxRows));
  return {rows: visible, cursorColumn: stringWidth(visible.at(-1)), cursorRow: visible.length - 1};
}

// Keep the highlighted row on screen while a long list scrolls under it.
export function windowAround(count, index, height) {
  if (count <= 0 || height <= 0) return {start: 0, end: 0};
  const start = Math.max(0, Math.min(index - (height >> 1), count - height));
  return {start, end: Math.min(count, start + height)};
}

// One row per model: marker, number, agent · label, current mark, description.
const fit = (text, width) => {
  let out = '', used = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (used + w > width) break;
    out += ch; used += w;
  }
  return out + ' '.repeat(Math.max(0, width - used));
};
export function modelRows(entries, index, width) {
  const labels = entries.map(e => `${e.provider} · ${e.label}`.replace(/\s+/g, ' '));
  const labelWidth = Math.min(Math.max(0, ...labels.map(stringWidth)), Math.max(16, Math.floor(width / 2)));
  return entries.map((entry, i) => fit(
    `${i === index ? '›' : ' '} ${String(i + 1).padStart(2)}. ${fit(labels[i], labelWidth)} ${entry.current ? '✓' : ' '} ${String(entry.description ?? '').replace(/\s+/g, ' ')}`,
    Math.max(1, width)).trimEnd());
}
