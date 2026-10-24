import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

export const commands = [
  ['provider', 'Select default agent'], ['model', 'Select model'], ['local', 'Set up local workers · /local setup [loaded]'], ['order', 'Set fallback order'],
  ['mode', 'Set yolo or plan mode'], ['login', 'Sign in to an agent'], ['new', 'Start new session'],
  ['note', 'Save handoff note'], ['btw', 'Ask a side question about this session'], ['steer', 'Steer live, or aside for the next turn'], ['rename', 'Name this session'], ['resume', 'Resume a session'], ['sessions', 'List sessions here'], ['skills', 'Manage and install skills'],
  ['review', 'Show full session work items'], ['quota', 'Show reported quota'], ['retry', 'Clear quota cooldowns'],
  ['update', 'Install latest npm release'],
  ['details', 'Expand or fold transcript details'], ['sidebar', 'Show or hide the status sidebar'],
  ['restart', 'Validate and reload'],
  ['operation', 'Switch classic/orchestrator'], ['jev', 'Jev (TypeSafe) decisions · /jev help'], ['stop', 'Cancel a task or all'], ['unblock', 'Continue after a restart when the old run is gone'], ['config', 'Show or change settings · /config key value'], ['stats', 'What this session cost and got · /stats tasks'], ['msg', 'Message a worker'],
  ['agents', 'Interactive orchestrator and worker panes'], ['tasks', 'Toggle task tree'], ['continue', 'Start an orchestrator turn'],
  ['help', 'Show help'], ['detach', 'Close view; keep agents running'], ['quit', 'Stop session and exit'],
];
// `extra` supplies the agents' own commands for this workspace (vendor-commands.js); it is a
// function so the directories are only read once the input looks like a slash command.
// Matching (docs/plans/interactive-polish.md step 5): names that start with what was typed; when none does, names
// containing it, then names with its letters in order (`/cfg` finds config). Bounce's own before the agents' at a tie.
export function fuzzyScore(name, query) {
  const text = name.toLowerCase(), needle = query.toLowerCase();
  if (!needle) return 3;
  if (text.startsWith(needle)) return 3;
  if (text.includes(needle)) return 2;
  let at = 0;
  for (const char of text) if (char === needle[at]) at++;
  return at === needle.length ? 1 : 0;
}
export function completions(input, extra = () => []) {
  if (!/^\/\S*$/.test(input)) return [];
  const query = input.slice(1);
  const all = [...commands, ...extra().filter(([name]) => !commands.some(([mine]) => mine === name))];
  const scored = all.map((row, index) => ({row, index, score: fuzzyScore(row[0], query)})).filter(entry => entry.score > 0);
  // Prefix matches alone when there are any: a fuzzy tail after two letters is noise, not help.
  const best = scored.some(entry => entry.score === 3) ? scored.filter(entry => entry.score === 3) : scored;
  return best.sort((a, b) => b.score - a.score || a.index - b.index).map(entry => entry.row);
}
// The `@mention` the caret is in: an @ at the start of the draft or after whitespace, up to the caret, with no
// space in between. Returns where it is and what was typed after the @.
export function mentionAt(input, cursor) {
  const before = input.slice(0, cursor);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const start = cursor - match[2].length - 1;
  if (input[cursor] && !/\s/.test(input[cursor])) return null;
  return {start, end: cursor, query: match[2]};
}
// A command typed out in full is not a completion waiting to be accepted. Enter on it must
// run the command, so /skills lists the skills on the first press rather than quietly
// appending a space and leaving the user to press Enter again.
export function typedCommand(input, extra = () => []) {
  const match = /^\/([a-z0-9._-]+)$/i.exec(input);
  const name = match?.[1].toLowerCase();
  if (!name) return '';
  return commands.some(([command]) => command === name) || extra().some(([command]) => command === name) ? name : '';
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
// 1002 (button-event tracking) adds motion while a button is held, which a drag selection needs; 1006 is SGR coordinates.
export const mouseTracking = enabled => releaseMouse + alternateScroll(false) + (enabled ? '\x1b[?1002h\x1b[?1006h' : '');

// Handing the terminal to a vendor CLI means handing over the keyboard too. Node keeps
// reading fd 0 while stdin is flowing, so an inherited child never sees the keystrokes
// typed at its own prompt: pausing is what releases them, leaving raw mode is not enough.
export function suspendTerminal(stdin = process.stdin, stdout = process.stdout) {
  stdin.setRawMode?.(false);
  stdin.pause();
  stdout.write(keyboardProtocol(false) + releaseMouse + alternateScroll(true) + '\x1b[?2004l\x1b[0 q\x1b[?25h\x1b[?1049l');
}
// `inline` (classic, docs/plans/interactive-polish.md step 7) stays on the main screen with the mouse left to the
// terminal: its scrollback, search and selection are the point.
export function resumeTerminal(stdin = process.stdin, stdout = process.stdout, {mouse = false, inline = false} = {}) {
  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write((inline ? '' : '\x1b[?1049h') + '\x1b[?25l\x1b[?2004h' + keyboardProtocol(true) + mouseTracking(mouse && !inline));
}
// Tracking the mouse means the terminal reports all of it, so bounce selects text itself (src/tui/selection.js):
// the wheel goes to onScroll with where the pointer is, and the left button's press, drag and release go to
// onPointer with their 1-based cells. Other buttons are consumed.
export function createMouseInput(onText, onScroll, onPointer = () => {}) {
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
      const at = {x: Number(match[2]), y: Number(match[3])};
      const wheel = button & 64, motion = button & 32, left = (button & 3) === 0;
      if (match[4] === 'M' && wheel && !(button & 2)) onScroll(button & 1 ? -3 : 3, at);
      else if (!wheel && left) onPointer({kind: match[4] === 'm' ? 'release' : motion ? 'drag' : 'press', ...at});
      pending = pending.slice(match[0].length);
    }
  };
  // The flush timer hands a lone ESC to the keyboard, but never the start of a mouse report: the terminal can split
  // one across reads (seen in a pty: `…M\x1b[<` then `0;37;3m`), and nobody types `ESC [ <`.
  consume.flush = () => { if (pending && !/^\x1b\[<[\d;]*$/.test(pending)) { onText(pending); pending = ''; } };
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
        if (code === 106 && bits === 4) { onNewline(); continue; } // Ctrl+J: a line feed, as in a raw terminal
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

// Prose (help, a wizard's questions) wraps at word boundaries; the prompt draft above wraps at the column.
export function wordRows(text, width) {
  return wrapAnsi(String(text), Math.max(2, width), {hard: true}).split('\n');
}
