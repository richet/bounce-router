// Standing workers (docs/plans/standing-workers.md §1, Daniel, 2026-10-01): a worker is a session per agent
// that outlives its tasks. Nothing is stored for it beyond the journal: a fresh launch names a worker on its
// `task.launch.requested` row (`builder#1`), a continuation carries the name of the worker it resumed, and
// `worker.retired` ends one. This view folds those rows into who exists, what each has done, and who is idle.
import {tasks, TERMINAL} from './reducers.js';

export const workerName = (profile, n) => `${profile}#${n}`;

// name -> {name, profile, tasks: [ids in order], lastTask, state: 'busy' | 'idle' | 'retired', retired: row | null, sessionId}
export function workersView(events) {
  const view = tasks(events);
  const workers = new Map();
  for (const e of events) {
    if (e.kind === 'task.launch.requested' && e.worker) {
      const row = events.find(s => s.kind === 'task.submitted' && s.task === e.task);
      const w = workers.get(e.worker) ?? {name: e.worker, profile: row?.profile ?? e.worker.split('#')[0], tasks: [], lastTask: null, retired: null};
      if (!w.tasks.includes(e.task)) w.tasks.push(e.task);
      w.lastTask = e.task;
      workers.set(e.worker, w);
    }
    if (e.kind === 'worker.retired' && workers.has(e.worker)) workers.get(e.worker).retired = e;
  }
  for (const w of workers.values()) {
    const last = view[w.lastTask];
    const held = last && ['blocked', 'input_required'].includes(last.state);
    w.state = w.retired ? 'retired' : last && !TERMINAL.has(last.state) && !held ? 'busy' : held ? 'held' : 'idle';
    w.sessionId = events.findLast(e => e.kind === 'peer.native' && e.from === `worker:${w.lastTask}` && typeof e.sessionId === 'string')?.sessionId ?? null;
    const ended = w.state === 'idle' ? events.findLast(e => e.task === w.lastTask && ['task.accepted', 'task.failed', 'task.cancelled', 'task.completed', 'task.deadline'].includes(e.kind)) : null;
    w.lastEnded = ended?.time ?? null;
    w.lastEndedSeq = ended?.seq ?? 0;
    const usage = events.filter(e => e.kind === 'task.usage' && e.task === w.lastTask).at(-1)?.usage;
    w.lastContext = usage ? (usage.input ?? 0) + (usage.cache_read ?? 0) : null;
  }
  return workers;
}

// The idle standing worker of a profile that finished most recently, able to be continued; null when none.
export function idleWorkerOf(events, profile) {
  const idle = [...workersView(events).values()].filter(w => w.profile === profile && w.state === 'idle' && w.sessionId);
  // journal order, not wall clock: two workers can end in the same millisecond
  idle.sort((a, b) => b.lastEndedSeq - a.lastEndedSeq);
  return idle[0] ?? null;
}

export function nextWorkerName(events, profile) {
  const n = events.filter(e => e.kind === 'task.launch.requested' && e.worker && e.worker.startsWith(`${profile}#`) && !e.continued).length;
  return workerName(profile, n + 1);
}

// The handoff a retired worker left for the next one of its profile, if no fresh worker has started since.
export function pendingHandoffFor(events, profile) {
  const retired = events.findLast(e => e.kind === 'worker.retired' && e.handoff && String(e.worker).startsWith(`${profile}#`));
  if (!retired) return null;
  const since = events.some(e => e.seq > retired.seq && e.kind === 'task.launch.requested' && e.worker && e.worker.startsWith(`${profile}#`) && !e.continued);
  return since ? null : retired.handoff;
}

// One line per worker for the orchestrator (the handoff and tasks_list).
export function rosterLines(events, {now = Date.now()} = {}) {
  const lines = [];
  for (const w of workersView(events).values()) {
    if (w.state === 'retired') continue;
    const idle = w.lastEnded ? Math.max(0, Math.round((now - Date.parse(w.lastEnded)) / 60000)) : null;
    const state = w.state === 'busy' ? `busy on ${w.lastTask}` : w.state === 'held' ? `its work on ${w.lastTask} is held` : idle !== null ? `idle ${idle} min` : 'idle';
    lines.push(`- ${w.name} · ${w.tasks.length} task${w.tasks.length === 1 ? '' : 's'} · ${state}${w.lastContext ? ` · last context ${Math.round(w.lastContext / 1000)}k tokens` : ''}${w.sessionId ? '' : ' · no session to continue'}`);
  }
  return lines;
}
