import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

export const commands = [
  ['provider', 'Select default agent'], ['model', 'Select model'], ['order', 'Set fallback order'],
  ['mode', 'Set yolo or plan mode'], ['login', 'Sign in to an agent'], ['new', 'Start new session'],
  ['note', 'Save handoff note'], ['skills', 'Manage and install skills'],
  ['review', 'Show full session work items'], ['quota', 'Show reported quota'], ['retry', 'Clear quota cooldowns'],
  ['update', 'Install latest npm release'],
  ['restart', 'Validate and reload'],
  ['help', 'Show help'], ['quit', 'Exit bounce'],
];
export function completions(input) {
  if (!/^\/\S*$/.test(input)) return [];
  return commands.filter(([name]) => name.startsWith(input.slice(1)));
}
// A command typed out in full is not a completion waiting to be accepted. Enter on it must
// run the command, so /skills lists the skills on the first press rather than quietly
// appending a space and leaving the user to press Enter again.
export function typedCommand(input) {
  const match = /^\/([a-z]+)$/i.exec(input);
  const name = match?.[1].toLowerCase();
  return commands.some(([command]) => command === name) ? name : '';
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
// Clear legacy, drag and motion tracking too: another CLI may have left them enabled.
const releaseMouse = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
// Alternate scroll mode makes the terminal send bare arrow keys for the wheel while the
// alternate screen is up. They arrive indistinguishable from typed arrows, so a scroll walks
// prompt history instead of the transcript. Turn it off whenever bounce owns the screen and
// read the wheel from mouse reports instead; restore it before handing a child CLI the terminal.
const alternateScroll = enabled => enabled ? '\x1b[?1007h' : '\x1b[?1007l';
export const mouseTracking = enabled => releaseMouse + alternateScroll(false) + (enabled ? '\x1b[?1000h\x1b[?1006h' : '');

// Handing the terminal to a vendor CLI means handing over the keyboard too. Node keeps
// reading fd 0 while stdin is flowing, so an inherited child never sees the keystrokes
// typed at its own prompt: pausing is what releases them, leaving raw mode is not enough.
export function suspendTerminal(stdin = process.stdin, stdout = process.stdout) {
  stdin.setRawMode?.(false);
  stdin.pause();
  stdout.write(keyboardProtocol(false) + releaseMouse + alternateScroll(true) + '\x1b[?2004l\x1b[0 q\x1b[?25h\x1b[?1049l');
}
export function resumeTerminal(stdin = process.stdin, stdout = process.stdout, {mouse = false} = {}) {
  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h' + keyboardProtocol(true) + mouseTracking(mouse));
}
// Tracking the wheel means the terminal reports the whole mouse, so a plain click-drag no
// longer reaches its own selection. onPress fires on a left button press so the caller can
// say how to get selection back, at the moment the click is swallowed rather than in a
// startup line nobody rereads.
export function createMouseInput(onText, onScroll, onPress = () => {}) {
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
      const wheel = button & 64;
      if (match[4] === 'M' && wheel && !(button & 2)) onScroll(button & 1 ? -3 : 3);
      // Press only: a click reports press then release, and one hint per click is enough.
      else if (match[4] === 'M' && !wheel && (button & 3) === 0) onPress();
      pending = pending.slice(match[0].length);
    }
  };
  consume.flush = () => { if (pending) onText(pending); pending = ''; };
  return consume;
}

// Enter with a modifier has no encoding until the application asks for one: with no
// request, every terminal sends a bare \r for Shift+Enter, indistinguishable from Enter.
// Asking means enabling the kitty keyboard protocol's disambiguation flag and xterm's
// modifyOtherKeys; terminals that know neither ignore both. Both re-encode other modified
// keys too (Ctrl+C becomes \x1b[99;5u), so createKeyInput decodes the whole family back
// into the events readline would have named, not just Enter.
export const keyboardProtocol = enabled => enabled ? '\x1b[>1u\x1b[>4;2m' : '\x1b[>4;0m\x1b[<1u';

// kitty: CSI code[:alt];modifiers[:event][;text] u — xterm: CSI 27;modifiers;code ~
const MODIFIED_KEY = /^\x1b\[(?:(\d+)(?::\d+)*(?:;(\d+)(?::\d+)?)?(?:;[\d:]*)?u|27;(\d+)(?::\d+)?;(\d+)~)/;
const PARTIAL_KEY = /^\x1b\[[\d;:]*$/;
const NAMED = {8: ['backspace', '\x7f'], 9: ['tab', '\t'], 27: ['escape', '\x1b'], 127: ['backspace', '\x7f']};
export function createKeyInput(onText, onNewline, onControl = () => {}) {
  let pending = '';
  const consume = chunk => {
    pending += chunk;
    while (pending) {
      const start = pending.indexOf('\x1b[');
      if (start < 0) {
        const keep = pending.endsWith('\x1b') ? 1 : 0;
        if (pending.length > keep) onText(pending.slice(0, pending.length - keep));
        pending = keep ? pending.slice(-keep) : '';
        return;
      }
      if (start) { onText(pending.slice(0, start)); pending = pending.slice(start); }
      const match = MODIFIED_KEY.exec(pending);
      if (match) {
        pending = pending.slice(match[0].length);
        const code = Number(match[1] ?? match[4]);
        const bits = Math.max(0, Number(match[2] ?? match[3] ?? 1) - 1);
        const key = {shift: !!(bits & 1), meta: !!(bits & 2), ctrl: !!(bits & 4)};
        // Enter with any modifier — Shift, Ctrl, Alt or Cmd — opens a line instead of sending.
        if (code === 13 || code === 10) { if (bits) onNewline(); else onText('\r'); continue; }
        const named = NAMED[code];
        const text = named ? named[1] : String.fromCodePoint(code);
        // Only Ctrl and Alt need a synthesized event; anything else readline can read as text.
        if (!key.ctrl && !key.meta) onText(text);
        else if (named) onControl(text, {...key, name: named[0]});
        else onControl(key.ctrl && code > 63 && code < 128 ? String.fromCharCode(code & 31) : text,
          {...key, name: String.fromCodePoint(code).toLowerCase()});
        continue;
      }
      if (PARTIAL_KEY.test(pending) && pending.length < 32) return;
      onText(pending.slice(0, 2)); pending = pending.slice(2); // Any other escape sequence.
    }
  };
  consume.flush = () => { if (pending) { onText(pending); pending = ''; } };
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
// A checklist reuses the model picker's window and cursor; only the row differs, because
// each entry carries its own chosen/not-chosen state rather than one selection for the list.
export function checklistRows(entries, index, width, chosen) {
  const labels = entries.map(e => String(e.label ?? e.skill ?? '').replace(/\s+/g, ' '));
  const labelWidth = Math.min(Math.max(0, ...labels.map(stringWidth)), Math.max(16, Math.floor(width / 3)));
  return entries.map((entry, i) => fit(
    `${i === index ? '›' : ' '} [${chosen.has(i) ? '×' : ' '}] ${fit(labels[i], labelWidth)} ${String(entry.description ?? '').replace(/\s+/g, ' ')}`,
    Math.max(1, width)).trimEnd());
}
export function modelRows(entries, index, width) {
  const labels = entries.map(e => `${e.provider} · ${e.label}`.replace(/\s+/g, ' '));
  const labelWidth = Math.min(Math.max(0, ...labels.map(stringWidth)), Math.max(16, Math.floor(width / 2)));
  return entries.map((entry, i) => fit(
    `${i === index ? '›' : ' '} ${String(i + 1).padStart(2)}. ${fit(labels[i], labelWidth)} ${entry.current ? '✓' : ' '} ${String(entry.description ?? '').replace(/\s+/g, ' ')}`,
    Math.max(1, width)).trimEnd());
}
