import {doingStep} from './status.js';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'rejected', 'accepted']);
const HIDDEN_TRANSCRIPT_KINDS = new Set(['raw', 'usage', 'checkpoint', 'task.activity']);
// `task.observed` is a throttled journal copy of the same live `task.activity` rows (src/scheduler.js
// consumeWorkerEvents): a row seen live moments earlier lands again on restart replay. Only the
// text is compared — a recent window, not the whole history, so a genuinely repeated line still shows.
const OBSERVED_DEDUPE_WINDOW = 6;

function taskState(kind) {
  if (kind === 'task.started') return 'running';
  if (kind === 'task.blocked') return 'blocked';
  if (kind === 'task.input_required') return 'input_required';
  if (kind === 'task.completed') return 'completed';
  if (kind === 'task.failed') return 'failed';
  if (kind === 'task.cancelled') return 'cancelled';
  if (kind === 'task.deadline' || kind === 'task.timed_out') return 'timed_out';
  if (kind === 'task.rejected') return 'rejected';
  if (kind === 'task.accepted') return 'accepted';
  return null;
}

function taskText(event) {
  return String(event.summary ?? event.text ?? event.reason ?? '').slice(0, 16000).replace(/\s+/g, ' ').trim();
}

// A deliberately small, append-only view projection. Durable history stays owned by Session;
// this retains only the current pane facts plus a capped transcript/activity tail for frames.
export function createWorkspaceProjection({activityLimit = 400, transcriptLimit = 2000, outcomeLimit = 400, dedupeLimit = 4096} = {}) {
  const tasks = new Map();
  const transcript = [];
  const outcomes = new Map();
  const seen = new Set();
  const seenOrder = [];
  const lineages = new Map();
  const lineageOrder = [];
  const renderPanes = [];
  const renderModel = {panes: renderPanes, transcript};
  const limit = Math.max(1, Number(activityLimit) || 400);
  const transcriptCap = Math.max(1, Number(transcriptLimit) || 2000);
  const outcomeCap = Math.max(1, Number(outcomeLimit) || 400);
  const dedupeCap = Math.max(1, Number(dedupeLimit) || 4096);

  function remember(key) {
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    seenOrder.push(key);
    if (seenOrder.length > dedupeCap) seen.delete(seenOrder.shift());
    return true;
  }

  const submittedRows = new Map(); // task -> its task.submitted row, so a reworked task can come back
  function addTask(event) {
    submittedRows.set(event.task, event);
    const logicalTask = event.replaces ? (lineages.get(event.replaces) ?? event.replaces) : event.task;
    lineages.set(event.task, logicalTask);
    lineageOrder.push(event.task);
    if (lineageOrder.length > dedupeCap) lineages.delete(lineageOrder.shift());
    const task = {
      id: `worker:${logicalTask}`,
      kind: 'worker',
      task: event.task,
      role: event.role ?? 'worker',
      profile: event.profile ?? 'worker',
      state: 'queued',
      activity: [],
      ...(event.replaces ? {recovery: `replacement for ${event.replaces}`} : {}),
    };
    tasks.set(event.task, task);
    renderPanes.push(task);
  }

  function removeTask(task) {
    tasks.delete(task.task);
    const index = renderPanes.indexOf(task);
    if (index >= 0) renderPanes.splice(index, 1);
  }

  function ingest(event) {
    if (!event || typeof event !== 'object') return false;
    const key = event.id ?? (Number.isFinite(event.seq) ? `seq:${event.seq}` : null);
    if (!remember(key)) return false;
    if (!HIDDEN_TRANSCRIPT_KINDS.has(event.kind)) {
      transcript.push(event);
      if (transcript.length > transcriptCap) transcript.splice(0, transcript.length - transcriptCap);
    }
    if (typeof event.task !== 'string' || !event.task) return true;
    if (event.kind === 'task.submitted') {
      if (!tasks.has(event.task)) addTask(event);
      return true;
    }
    let task = tasks.get(event.task);
    // A task that completed and was sent back for rework runs again: its pane comes back for the
    // next attempt (found live: a reworked task vanished from the rail while its second attempt ran).
    if (!task && event.kind === 'task.started') {
      const submitted = submittedRows.get(event.task);
      if (submitted) { addTask(submitted); task = tasks.get(event.task); }
    }
    if (!task) return true;
    if (event.kind === 'task.activity' || event.kind === 'task.observed') {
      if (event.text) {
        const text = String(event.text).slice(0, 16000);
        task.operation = taskText(event);
        task.activityAt = event.time ?? task.activityAt;
        // Either copy may reach a view first (found live: the journal's before the live row), and a
        // live row can repeat — whichever arrives second is the copy.
        const duplicate = task.activity.slice(-OBSERVED_DEDUPE_WINDOW).some(row => row.text === text);
        if (!duplicate) {
          task.activity.push({text, source: event.source ?? null});
          if (task.activity.length > limit) task.activity.splice(0, task.activity.length - limit);
        }
        task.doing = doingStep(task.doing, event); // what the worker is doing now, from its own rows
      }
      return true;
    }
    // A `profile: "auto"` task takes its real profile from the routing row (src/jev.js).
    if (event.kind === 'jev.routed' && typeof event.chosen === 'string' && event.chosen) task.profile = event.chosen;
    const state = taskState(event.kind);
    if (state) task.state = state;
    if (event.kind === 'task.started') {
      task.doing = doingStep(task.doing, event);
      task.model = event.requested ?? task.model;
      if (event.attempt != null) task.attempt = event.attempt;
    }
    if (event.kind === 'task.blocked' || event.kind === 'task.input_required') task.reason = event.reason ?? null;
    if (event.kind === 'task.started') { delete task.reason; delete task.blocked; }
    if (event.kind === 'task.milestone' || event.kind === 'task.reported' || event.kind === 'task.blocked' || event.kind === 'task.input_required') {
      task.phase = event.phase ?? task.phase;
      task.text = taskText(event) || task.text;
      task.next = event.next ?? task.next;
      task.evidence = event.evidence ?? task.evidence;
      task.updatedAt = event.time ?? task.updatedAt;
    }
    // The blocking reason is its own field, separate from `text` (which a later milestone still
    // overwrites) — a blocked pane must keep showing why, not the next unrelated status prose.
    if (event.kind === 'task.blocked' || event.kind === 'task.input_required') task.blocked = taskText(event) || task.blocked;
    if (event.kind === 'task.delivered') task.delivery = event.tier ?? task.delivery;
    // A completion review is a worker still working: found live (2026-09-22) a 22-minute review whose
    // pane said `completed`, so nothing in the UI showed that anyone was on it.
    if (event.kind === 'review.started') { task.state = 'reviewing'; task.reviewer = event.profile ?? task.reviewer ?? null; task.updatedAt = event.time ?? task.updatedAt; return true; }
    if (event.kind === 'review.finished') { task.state = 'completed'; task.updatedAt = event.time ?? task.updatedAt; return true; }
    if (event.kind === 'task.recovery') task.recovery = taskText(event) || event.reason || task.recovery;
    // `completed` is not the end while a review may still send the task back: the pane leaves on
    // acceptance, failure or cancellation, or on completion with no review pending.
    // A completion under review (`review.started` follows it in the same tick) can be sent back, so the
    // pane stays until `task.accepted`/`task.rejected` ends it; a completion with no review leaves now.
    if (task.state === 'completed' && event.kind === 'task.completed' && submittedRows.get(task.task)?.review?.completion) { task.underReview = true; return true; }
    if (TERMINAL.has(task.state) && !(task.state === 'completed' && task.underReview)) {
      outcomes.set(task.task, {task: task.task, state: task.state, text: taskText(event)});
      while (outcomes.size > outcomeCap) outcomes.delete(outcomes.keys().next().value);
      removeTask(task);
    }
    return true;
  }

  function replay(events = []) { for (const event of events) ingest(event); return snapshot(); }
  function panes() {
    return renderPanes.map(task => ({...task, activity: [...task.activity], freshness: {
      meaningfulAt: task.updatedAt ?? null,
      activityAt: task.activityAt ?? null,
    }}));
  }
  function paneIds() { return ['orchestrator', ...panes().map(pane => pane.id)]; }
  function transcriptEvents() { return transcript; }
  function snapshot() { return {panes: panes(), transcript: [...transcript], outcomes: [...outcomes.values()]}; }
  // React 19's development profiler recursively diffs changed object props and retains the
  // resulting performance entries. Keep this render-only model stable and mutate its bounded
  // collections in place so a sustained transcript cannot become profiler-retained history.
  function model() { return renderModel; }
  function reset(events = []) {
    tasks.clear();
    transcript.length = 0;
    outcomes.clear();
    seen.clear();
    seenOrder.length = 0;
    lineages.clear();
    lineageOrder.length = 0;
    renderPanes.length = 0;
    return replay(events);
  }

  return {ingest, replay, reset, paneIds, snapshot, transcriptEvents, model};
}
