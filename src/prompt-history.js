import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// What you typed in this workspace before, across sessions, for ↑ and Ctrl+R (docs/plans/interactive-polish.md
// step 4). One JSON array per workspace under the data dir, newest last. A prompt that starts with a space is not
// kept — the shell convention for "don't remember this" — and neither is one over 10 000 characters.
const MAX_LENGTH = 10_000;

export function createPromptHistory({root, cwd, limit = 500}) {
  const file = path.join(root, 'history', `${createHash('sha256').update(String(cwd)).digest('hex').slice(0, 16)}.json`);
  let entries = [];
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(saved)) entries = saved.filter(entry => typeof entry === 'string'); } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(entries), {mode: 0o600});
      fs.renameSync(temporary, file);
    } catch {}
  };
  return {
    entries: () => [...entries],
    add(prompt) {
      const text = String(prompt ?? '');
      if (!text.trim() || /^\s/.test(text) || text.length > MAX_LENGTH) return;
      entries = [...entries.filter(entry => entry !== text), text].slice(-limit);
      save();
    },
    // Matches for a Ctrl+R query, newest first.
    search(query) {
      const needle = String(query ?? '').toLowerCase();
      return entries.filter(entry => entry.toLowerCase().includes(needle)).reverse();
    },
  };
}
