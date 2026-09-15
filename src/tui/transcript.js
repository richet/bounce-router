const WORKER_STATES = {
  'task.submitted': 'queued',
  'task.started': 'running',
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.blocked': 'blocked',
  'task.input_required': 'input_required',
  'task.cancelled': 'cancelled',
  'task.deadline': 'timed_out',
  'task.accepted': 'accepted',
  'task.rejected': 'rejected',
};
const WORKER_PROGRESS = new Set(['task.milestone', 'task.reported']);
const HIDDEN = new Set(['turn', 'attempt', 'main.starting', 'main.started', 'main.delivery']);
// The part of a progress reading that names what is happening: `Thinking` of `Thinking · ~50 tokens`.
const progressLabel = event => String(event.text ?? '').split(' · ')[0];

// Display-only reduction: retain the journal verbatim for diagnostics and handoffs.
export function conversationEvents(events, {details = false} = {}) {
  const rows = [];
  const workers = new Map();
  let lastAnswer = null;
  let lastProvider;

  for (const event of events) {
    // A reported model is header metadata with no text; it would only split a progress run.
    if (event.kind === 'model') continue;
    if (event.kind === 'user' || event.kind === 'main.starting') lastAnswer = null;
    if (event.kind === 'assistant') {
      lastAnswer = event.text?.trim();
      lastProvider = event.provider;
    }
    // Muse streams an answer as many small deltas, each its own journal row. They read as one
    // block; the row's id changes as it grows so a cached rendering of it is not reused.
    if (event.kind === 'delta' && !details) {
      const previous = rows.at(-1);
      if (previous?.kind === 'delta' && previous.provider === event.provider) {
        previous.text += event.text ?? '';
        previous.id = `${previous.first}+${++previous.merged}`;
      } else rows.push({...event, first: event.id, merged: 1});
      lastAnswer = rows.at(-1).text.trim();
      lastProvider = event.provider;
      continue;
    }
    // Live progress arrives as a counter that ticks every few tokens or seconds (`Thinking ·
    // ~50 tokens`, `~100`, `~265`…). A run of readings for the same thing is one row showing
    // the latest; the id changes with each reading so the row cache re-renders it.
    if (event.kind === 'progress') {
      const previous = rows.at(-1);
      if (previous?.kind === 'progress' && previous.provider === event.provider && progressLabel(previous) === progressLabel(event)) {
        previous.text = event.text;
        previous.id = `${previous.first}+${++previous.merged}`;
      } else rows.push({...event, first: event.id, merged: 1});
      continue;
    }
    if (event.kind === 'main.terminal') {
      if (event.status === 'completed') {
        const text = event.text?.trim();
        if (text && text !== lastAnswer) {
          rows.push({...event, id: `${event.id}:answer`, kind: 'assistant', provider: event.provider ?? lastProvider});
        }
        rows.push({...event, text: '', reason: undefined});
      } else {
        rows.push(event);
      }
      continue;
    }
    if (details) {
      rows.push(event);
      continue;
    }
    if (HIDDEN.has(event.kind)) continue;
    if (event.kind === 'result' && event.success !== false) {
      const text = event.text?.trim();
      if (!text || text === lastAnswer || text === 'Turn completed') continue;
    }
    if (event.kind?.startsWith('task.') && event.kind !== 'task.fold') {
      if (!event.task || (!WORKER_STATES[event.kind] && !WORKER_PROGRESS.has(event.kind))) continue;
      const previous = workers.get(event.task);
      const state = WORKER_STATES[event.kind] ?? previous?.state ?? 'running';
      const started = event.kind === 'task.started' ? event.time : previous?.started;
      const elapsed = Date.parse(event.time) - Date.parse(started);
      const duration = ['completed', 'failed', 'cancelled', 'timed_out', 'accepted', 'rejected'].includes(state) && Number.isFinite(elapsed)
        ? `${Math.max(0, elapsed / 1000).toFixed(1)}s` : null;
      const profile = event.profile ?? previous?.profile ?? `worker ${event.task.slice(0, 8)}`;
      const model = event.requested || previous?.model;
      const summary = String(event.summary ?? event.text ?? event.reason ?? '').replace(/\s+/g, ' ').trim();
      const row = {...event, kind: 'task.fold', profile, state, model, started, preview: summary,
        text: [profile, state, model, duration].filter(Boolean).join(' · ')};
      // Keep the latest update in chronological position, rather than repeated lifecycle dumps.
      if (previous) rows[previous.index] = null;
      row.index = rows.length;
      workers.set(event.task, row);
      rows.push(row);
      continue;
    }
    rows.push(event);
  }
  return rows.filter(Boolean);
}
