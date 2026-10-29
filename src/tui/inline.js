// Inline rendering: which conversation rows are final, and so go to the
// terminal's scrollback once, and which are still the turn in flight. While a turn runs, every row after its prompt
// can still change (deltas grow, a tool count rises, an answer replaces its deltas) and stays live; the prompt and
// everything before it are final. A progress row is never final: it goes when its turn ends.
export function splitInline(rows, {busy = false} = {}) {
  const boundary = busy ? rows.findLastIndex(row => row.kind === 'user') + 1 : rows.length;
  return {
    committed: rows.slice(0, boundary).filter(row => row.kind !== 'progress'),
    live: rows.slice(boundary),
  };
}
