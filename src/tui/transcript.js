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
// main.disposition and main.wake.scheduled are orchestrator bookkeeping with no text/status/state
// of their own — format.js's main.* fallback renders them as an empty "Orchestrator · " row.
const HIDDEN = new Set(['turn', 'attempt', 'main.starting', 'main.started', 'main.delivery', 'main.disposition', 'main.wake.scheduled']);
// What the folded view leaves out. All of it stays in details mode and in the journal.
// Vendor plumbing that a CLI reports as status, and bounce rows that are machinery, not conversation:
// the hand-off prompt is written FOR the orchestrator, a review's start and raw verdict JSON are
// covered by the verdict line and the worker's block, control rows are the user's own commands, and
// a stall ping is what the rail's red row already says.
const PLUMBING = /^(hook_started|hook_response|background_tasks_changed|task_updated|Task (started|stopped|completed|updated) ·)/;
// A skill-sync summary (src/skills.js seedSummary) is one line per skill; "your own copy is kept"
// is the routine no-op (the user's own edit is left alone, nothing bounce did). A batch where
// every line is that no-op is quiet plumbing; one line worth acting on keeps the whole row visible.
// The journal is append-only, so sessions from before this line's wording was renamed still carry
// the old "left alone: not the copy bounce installed" text — match both.
const SKILL_SYNC_QUIET_LINE = /^[^\n:]+: (your own copy is kept \(bounce does not manage it\)|left alone: not the copy bounce installed)$/;
const isQuietSkillSync = text => {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  return lines.length > 0 && lines.every(line => SKILL_SYNC_QUIET_LINE.test(line));
};
const MACHINERY = new Set(['handoff', 'review.started', 'review.finished', 'policy.escalated', 'policy.corrected']);
const TOOL_CALL = /^[A-Za-z_][\w.-]*: \{/;
// What a finished turn leaves you with: the answer's TLDR (else its first sentence), without markdown.
// Only a long answer earns it: a short one is still on screen right above, and repeating it is noise.
const LONG_ANSWER = 600;
function tldrOf(answer) {
  const text = String(answer ?? '').trim();
  if (text.length < LONG_ANSWER) return '';
  const first = text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  const marked = /^\**\s*TL;?DR:?\s*\**:?\s*/i;
  const plain = (marked.test(first) ? first.replace(marked, '') : (/^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first)).replace(/\*\*/g, '');
  return plain.length > 320 ? `${plain.slice(0, 319)}…` : plain;
}
// The part of a progress reading that names what is happening: `Thinking` of `Thinking · ~50 tokens`.
const progressLabel = event => String(event.text ?? '').split(' · ')[0];

// Display-only reduction: retain the journal verbatim for diagnostics and handoffs.
export function conversationEvents(events, {details = false} = {}) {
  const rows = [];
  const workers = new Map();
  const viewSlots = new Map();
  const queuedUserSlots = new Map(); // requestId -> its `user` row's index, until withdrawn removes it
  let lastAnswer = null;
  let lastProvider;
  let sawOperation = false;

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
        // The turn ends on how to continue, not on "Finished": the answer's TLDR, who still works, who waits on you.
        if (details) rows.push({...event, text: '', reason: undefined});
        else {
          const states = [...workers.values()];
          rows.push({id: `${event.id}:next`, time: event.time, kind: 'next', tldr: tldrOf(text || lastAnswer),
            running: states.filter(w => ['running', 'queued'].includes(w.state)).length,
            waiting: states.filter(w => w.state === 'input_required').map(w => ({profile: w.profile, task: w.task}))});
        }
      } else {
        rows.push(event);
      }
      continue;
    }
    if (details) {
      rows.push(event);
      continue;
    }
    // A queued prompt the user pulled back (main.withdrawn, cli.js's Up-arrow handling) was never
    // actually sent: drop its `user` row from the default view too, as if it never happened. Both
    // rows stay in /details and in the journal.
    if (event.kind === 'main.withdrawn' && event.requestId) {
      const slot = queuedUserSlots.get(event.requestId);
      if (slot !== undefined) rows[slot] = null;
      continue;
    }
    if (event.kind === 'user' && event.queued && event.requestId) {
      queuedUserSlots.set(event.requestId, rows.length);
      rows.push(event);
      continue;
    }
    if (HIDDEN.has(event.kind) || MACHINERY.has(event.kind) || event.kind?.startsWith('control.')) continue;
    if (event.kind === 'status' && (PLUMBING.test(String(event.text ?? '')) || isQuietSkillSync(event.text))) continue;
    // reload.js appends a fresh `operation` row on every daemon resume; only the first belongs
    // in the default view (later ones just repeat "Operation: orchestrator on main …").
    if (event.kind === 'operation') {
      if (sawOperation) continue;
      sawOperation = true;
      rows.push(event);
      continue;
    }
    // /tasks, /review, /help and /quota journal their output on every use (cli.js) so re-running one
    // mid-session leaves several permanent copies of the same list. Keep only the latest of each
    // in the default view; earlier ones stay in the journal and in /details. Older journals never
    // marked a /tasks status row with `view`, so an unmarked one can't be told apart from an
    // ordinary status row — leave those alone.
    const view = ['review', 'help', 'quota'].includes(event.kind) ? event.kind : event.kind === 'status' && event.view === 'tasks' ? 'tasks' : null;
    if (view) {
      const previous = viewSlots.get(view);
      if (previous) rows[previous.index] = null;
      const row = {...event, index: rows.length};
      viewSlots.set(view, row);
      rows.push(row);
      continue;
    }
    // A run of tool rows — calls and their pasted output — is one line: how many calls, and the last.
    if (event.kind === 'tool') {
      const isCall = TOOL_CALL.test(String(event.text ?? '').trim());
      const previous = rows.at(-1);
      if (previous?.kind === 'tool.fold' && previous.provider === event.provider) {
        if (isCall) { previous.calls++; previous.last = event.text; }
        previous.id = `${previous.first}+${++previous.merged}`;
      } else rows.push({...event, kind: 'tool.fold', first: event.id, merged: 1, calls: isCall ? 1 : 0, last: isCall ? event.text : null});
      continue;
    }
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
      // An acceptance carries no summary of its own: the block keeps what the worker said.
      const row = {...event, kind: 'task.fold', profile, state, model, started, preview: summary || previous?.preview || '',
        text: [profile, state, model, duration, state === 'running' && (event.phase ?? previous?.phase) ? `phase: ${event.phase ?? previous.phase}` : null].filter(Boolean).join(' · '),
        phase: event.phase ?? previous?.phase};
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
