// Pure folds over a session's event log: no IO, no clock except an explicit `now`; rows are {id, seq, time, kind, from, context, task?, ...payload fields at the top level}.

export function peers(events) {
  const result = {};
  for (const e of events) {
    if (!e.kind?.startsWith('peer.')) continue;
    const peer = result[e.from] ??= {name: e.from, role: undefined, adapter: undefined, profile: undefined, joined: undefined, left: null, native: null};
    if (e.kind === 'peer.joined') { peer.role = e.role; peer.adapter = e.adapter; peer.profile = e.profile; peer.joined = e.time; }
    else if (e.kind === 'peer.left') peer.left = e.time;
    else if (e.kind === 'peer.native') peer.native = {provider: e.provider, sessionId: e.sessionId};
  }
  return result;
}

// Queued `user` prompts (main-service.js's server-side FIFO of prompts that arrived while a run
// was current) still waiting to start: neither dispatched (a later main.requested/main.started
// for the same requestId) nor withdrawn (main.withdrawn). Only the keyboard submit path ever
// journals a `user` row, so every one found here belongs to this session's own user — never a
// worker or an automatic wake, which use different kinds. Mirrors main-service.js's own
// restart-rebuild fold, so the view can answer "what's still queued" without asking the daemon.
export function queuedPrompts(events) {
  const dispatched = new Set(), withdrawn = new Set();
  for (const e of events) {
    if (e.requestId && ['main.requested', 'main.started'].includes(e.kind)) dispatched.add(e.requestId);
    if (e.requestId && e.kind === 'main.withdrawn') withdrawn.add(e.requestId);
  }
  return events.filter(e => e.kind === 'user' && e.queued && e.requestId
    && !dispatched.has(e.requestId) && !withdrawn.has(e.requestId));
}

// TERMINAL is the one definition shared with src/scheduler.js (imported from here, never
// redefined): completed/failed/cancelled/timed_out end a task with no review pending;
// accepted/rejected end one that went through review policy.
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'accepted', 'rejected']);
const emptyTask = id => ({id, parent: null, replaces: null, lastMilestone: null, blocker: null, reason: null, error: null, children: [], review: null, depends_on: [], steps: null, rounds: 0, accepted: false, prelaunch: null});

// A task exists only once its own task.submitted is seen; any other task.* row for an unknown id is dropped. A parent stays waiting through its own progress events while any child is non-terminal, remembering which state (its last progress, or its own queued submission) to resume once every child terminates; terminal states never change again — except `task.accepted`, the one permitted exit from `completed`/`reviewing` into the frozen `accepted` state.
export function tasks(events) {
  const result = {};
  const priorState = {};
  const integrationBlocked = new Set();
  const ensure = id => result[id] ??= emptyTask(id);
  const settleParent = parentId => {
    const parent = result[parentId];
    if (!parent || parent.state !== 'waiting') return;
    if (parent.children.every(id => TERMINAL.has(result[id]?.state))) parent.state = priorState[parentId];
  };
  for (const e of events) {
    // A `profile: "auto"` submission takes its real profile from the routing row the scheduler
    // journals at dispatch (src/jev.js): the one non-task.* row that shapes a task.
    if (e.kind === 'jev.routed') {
      const t = typeof e.task === 'string' ? result[e.task] : undefined;
      if (t && !TERMINAL.has(t.state) && typeof e.chosen === 'string' && e.chosen) t.profile = e.chosen;
      continue;
    }
    if (!e.kind?.startsWith('task.')) continue;
    if (typeof e.task !== 'string' || !e.task) continue; // a malformed row never becomes a task
    if (e.kind === 'task.submitted') {
      const t = ensure(e.task);
      if (TERMINAL.has(t.state)) continue;
      t.jobId = e.jobId ?? e.task; t.campaignId = e.campaignId ?? null; t.gate = e.gate ?? null; t.planId = e.planId ?? null; t.chunkId = e.chunkId ?? null;
      t.context = e.context; t.profile = e.profile; t.deadline = e.deadline; t.budget = e.budget && {...e.budget}; t.replaces = e.replaces ?? null;
      t.review = e.review ?? null; t.depends_on = e.depends_on ? [...e.depends_on] : []; t.steps = e.steps ?? null;
      if (t.state === 'waiting') priorState[e.task] = 'queued'; else t.state = 'queued';
      if (e.parent) {
        t.parent = e.parent;
        const parent = ensure(e.parent);
        parent.children.push(e.task);
        if (!TERMINAL.has(parent.state) && parent.state !== 'waiting') { priorState[e.parent] = parent.state; parent.state = 'waiting'; }
      }
      continue;
    }
    const t = result[e.task];
    // task.accepted is the one row allowed to act on a task already in a terminal
    // state (completed): every other kind is dropped once terminal, as before.
    if (!t || (TERMINAL.has(t.state) && e.kind !== 'task.accepted')) continue;
    switch (e.kind) {
      case 'task.started':
        if (t.state === 'waiting') priorState[e.task] = 'running'; else t.state = 'running';
        t.attempt = e.attempt;
        break;
      case 'task.blocked':
        t.state = 'blocked'; t.blocker = e.text;
        if (e.reason === 'integration_interrupted') integrationBlocked.add(e.task);
        else integrationBlocked.delete(e.task);
        break;
      case 'task.integrated':
        // Only a completed durable publication can resolve this infrastructure blocker.
        // Worker-authored blockers still require their own explicit recovery.
        if (t.state === 'blocked' && integrationBlocked.delete(e.task)) {
          t.state = t.review?.completion ? 'reviewing' : 'running'; t.blocker = null;
        }
        break;
      case 'task.input_required': t.state = 'input_required'; break;
      case 'task.milestone':
        if (t.state === 'waiting') priorState[e.task] = 'running';
        else if (t.state === 'blocked' || t.state === 'input_required') t.state = 'running';
        t.lastMilestone = {time: e.time, text: e.text, evidence: e.evidence};
        break;
      case 'task.completed':
        // A worker-authored final report is the task verdict. Transport can finish cleanly
        // afterwards (or duplicate an event), but it must never turn a visible blocker into
        // success just because the process exited 0.
        if (t.state === 'blocked' || t.state === 'input_required') break;
        t.state = t.review?.completion ? 'reviewing' : 'completed';
        t.summary = e.summary; t.artifacts = e.artifacts && [...e.artifacts];
        if (t.state === 'completed') settleParent(t.parent);
        break;
      case 'task.failed': t.state = 'failed'; t.reason = e.reason ?? null; t.error = e.text ?? null; settleParent(t.parent); break;
      case 'task.cancelled': t.state = 'cancelled'; settleParent(t.parent); break;
      case 'task.deadline': t.state = 'timed_out'; settleParent(t.parent); break;
      case 'task.rejected':
        if (t.state === 'queued') { t.state = 'rejected'; settleParent(t.parent); }
        break;
      case 'task.rework':
        // An owner's own rework verdict over an unconfident review gate (bus.js admits it only then,
        // and marks it `overrides`, the same shape task.accepted's override uses) is the other exit
        // from that gate's `blocked`, symmetric to the accept override; a plain rework row never
        // moves a blocked task — only a confident review's own rework, which arrives while reviewing.
        if (t.state === 'reviewing' || (t.state === 'blocked' && e.overrides)) { t.state = 'running'; t.rounds = (t.rounds || 0) + 1; }
        break;
      case 'task.accepted':
        if (e.stage === 'prelaunch') { if (t.state === 'queued') t.prelaunch = 'accepted'; break; }
        // completion (or an unstaged direct accept): reviewing→accepted is the actual
        // terminal entry (reviewing is not terminal, so the parent is still `waiting`
        // and must be settled); completed→accepted already settled its parent when it
        // first went terminal at `completed`, so settleParent does not re-fire here.
        if (t.state === 'reviewing') { t.state = 'accepted'; t.accepted = true; settleParent(t.parent); }
        else if (t.state === 'completed') { t.state = 'accepted'; t.accepted = true; }
        // An owner's accept over an unconfident review gate (bus.js admits it only then, and marks it
        // `overrides`) is the exit from that gate's `blocked`; a plain accept never moves a blocked task.
        else if (t.state === 'blocked' && e.overrides) { t.state = 'accepted'; t.accepted = true; settleParent(t.parent); }
        break;
    }
  }
  return result;
}

const sumInto = (target, amount) => { for (const key in amount) target[key] = (target[key] || 0) + amount[key]; return target; };

// Descendants, retries and replacements draw on the root's own allowance; unknown usage reads as unmeasured, never zero; a budget/usage row against an id with no submitted task lands in orphans instead of a root.
export function budgets(events) {
  const taskView = tasks(events);
  const reserved = {}, released = {}, usage = {}, measured = new Set();
  const orphanReserved = {}, orphanReleased = {}, orphanUsage = {}, orphanTasks = new Set();
  for (const e of events) {
    if (e.kind === 'budget.reserved') { if (taskView[e.task]) sumInto(reserved[e.task] ??= {}, e.amount); else { sumInto(orphanReserved, e.amount); orphanTasks.add(e.task); } }
    else if (e.kind === 'budget.released') { if (taskView[e.task]) sumInto(released[e.task] ??= {}, e.amount); else { sumInto(orphanReleased, e.amount); orphanTasks.add(e.task); } }
    else if (e.kind === 'task.usage') { if (taskView[e.task]) { sumInto(usage[e.task] ??= {}, e.usage); measured.add(e.task); } else { sumInto(orphanUsage, e.usage); orphanTasks.add(e.task); } }
  }
  // A replacement (fallback retry) belongs to the root of the task it replaces, never to a root of its own.
  // A cycle (self-parent, mutual parents, self-replace) can only come from a peer's row; it ends at the first revisited id.
  const rootOf = (id, seen = new Set()) => { const t = taskView[id]; if (seen.has(id)) return id; seen.add(id); return t.replaces && taskView[t.replaces] ? rootOf(t.replaces, seen) : t.parent && taskView[t.parent] ? rootOf(t.parent, seen) : id; };
  const roots = {};
  for (const root of Object.values(taskView)) {
    if (rootOf(root.id) !== root.id) continue;
    const tree = Object.keys(taskView).filter(id => rootOf(id) === root.id);
    const allowance = root.budget ? {...root.budget} : {};
    const treeReserved = {}, treeReleased = {}, treeUsage = {};
    let isMeasured = true;
    for (const id of tree) {
      sumInto(treeReserved, reserved[id]);
      sumInto(treeReleased, released[id]);
      sumInto(treeUsage, usage[id]);
      if (!measured.has(id)) isMeasured = false;
    }
    const remaining = {};
    for (const key of new Set([...Object.keys(allowance), ...Object.keys(treeReserved), ...Object.keys(treeReleased)]))
      remaining[key] = (allowance[key] || 0) - ((treeReserved[key] || 0) - (treeReleased[key] || 0));
    roots[root.id] = {root: root.id, allowance, reserved: treeReserved, released: treeReleased, remaining, usage: treeUsage, measured: isMeasured};
  }
  return {roots, orphans: {reserved: orphanReserved, released: orphanReleased, usage: orphanUsage, tasks: [...orphanTasks]}};
}

// Spend is a fold, never a hand-kept ledger: per task, usage/starts/rounds/findings/verdicts
// summed straight off the log; wall is (first task.started -> the row that actually carried the
// task into its current terminal state) or null for a task never terminal. Per root, the same
// summed over its tree (fallback retries and replacements draw on the root's own numbers, same
// rootOf rule as budgets()), plus tokens = the sum of the four usage categories present anywhere
// in the tree. `measured` is true only when every task in the tree has at least one usage row.
const TERMINAL_ROW_KIND = {completed: 'task.completed', failed: 'task.failed', cancelled: 'task.cancelled', timed_out: 'task.deadline', accepted: 'task.accepted', rejected: 'task.rejected'};
export function spend(events) {
  const taskView = tasks(events);
  const perTask = {};
  const startedTimes = {};
  const ensure = id => perTask[id] ??= {task: id, usage: {}, measured: false, starts: 0, rounds: 0, wall: null, findings: 0, verdicts: [], state: taskView[id]?.state};
  for (const e of events) {
    if (!taskView[e.task]) continue;
    if (e.kind === 'task.usage') { const t = ensure(e.task); sumInto(t.usage, e.usage); t.measured = true; }
    else if (e.kind === 'task.started') { ensure(e.task).starts++; (startedTimes[e.task] ??= []).push(Date.parse(e.time)); }
    else if (e.kind === 'task.rework') { const t = ensure(e.task); t.rounds++; t.findings += (e.findings?.length ?? 0); }
    else if (e.kind === 'review.finished') ensure(e.task).verdicts.push(e.verdict);
  }
  for (const id of Object.keys(taskView)) {
    const t = ensure(id);
    const state = taskView[id].state;
    const starts = startedTimes[id];
    const kind = TERMINAL_ROW_KIND[state];
    if (kind && starts?.length) {
      const terminalRow = events.filter(e => e.task === id && e.kind === kind).at(-1);
      if (terminalRow) t.wall = Date.parse(terminalRow.time) - Math.min(...starts);
    }
  }
  // Same rootOf rule as budgets(): a replacement belongs to the root of the task it replaces;
  // a cycle (only possible from a directly-journaled row) ends at the first revisited id.
  const rootOf = (id, seen = new Set()) => { const t = taskView[id]; if (seen.has(id)) return id; seen.add(id); return t.replaces && taskView[t.replaces] ? rootOf(t.replaces, seen) : t.parent && taskView[t.parent] ? rootOf(t.parent, seen) : id; };
  const roots = {};
  for (const root of Object.values(taskView)) {
    if (rootOf(root.id) !== root.id) continue;
    const tree = Object.keys(taskView).filter(id => rootOf(id) === root.id);
    const usage = {}, verdicts = [];
    let starts = 0, rounds = 0, findings = 0, wall = null, isMeasured = true;
    for (const id of tree) {
      const t = perTask[id];
      sumInto(usage, t.usage);
      verdicts.push(...t.verdicts);
      starts += t.starts; rounds += t.rounds; findings += t.findings;
      if (!t.measured) isMeasured = false;
      if (t.wall != null) wall = (wall ?? 0) + t.wall;
    }
    const tokens = ['input', 'cache_read', 'cache_write', 'output'].reduce((sum, key) => sum + (usage[key] || 0), 0);
    // A1: rootRow is the same shape as a task row (task = the root's own id, state = the
    // root task's own state), summed over the tree, plus tokens and tasks (count in the tree).
    roots[root.id] = {task: root.id, state: taskView[root.id].state, usage, measured: isMeasured, starts, rounds, wall, findings, verdicts, tokens, tasks: tree.length};
  }
  return {tasks: perTask, roots};
}

// Pure escalation input: for every `running` task, the deadline/silence/stall verdicts computed
// against `now`, given the scheduler's live (never-journaled) activity map — {task -> {at,
// expectUntil}}. A `blocked` task yields a single minimal entry; everything else is omitted, not
// zeroed, so the caller (scheduler tick()) only ever iterates actionable rows.
export function watchdog(events, now, {activity = new Map(), watchdog: cfg} = {}) {
  const taskView = tasks(events);
  const lineageRoot = (id, seen = new Set()) => {
    if (seen.has(id)) return id;
    seen.add(id);
    return taskView[id]?.replaces && taskView[taskView[id].replaces] ? lineageRoot(taskView[id].replaces, seen) : id;
  };
  const result = [];
  for (const t of Object.values(taskView)) {
    // A parked task — blocked, or asking its owner a question — is a decision waiting on a person,
    // not a worker to watch: its process has already exited, and it holds no slot. It is never killed
    // by a lease or ceiling while parked; it stays parked until answered (a message that resumes it, a
    // task.rework, an accept) or explicitly cancelled. It used to get a lease measured from the moment
    // it parked, ending an unanswered wait as a deadline — found live (session 159f4746, 4 tasks) that
    // this silently discarded a blocked worker's resumable context after 60 minutes nobody was
    // watching, even though the block itself was the very reason no slot was being spent. `blocked`
    // still yields its existing escalation verdict, once, so the owner is told; `input_required` yields
    // none, and neither can ever expire here.
    if (t.state === 'blocked' || t.state === 'input_required') {
      if (t.state === 'blocked') result.push({task: t.id, stage: 'parked', verdicts: ['blocked']});
      continue;
    }
    // A completion review is a worker turn too, with its own lease from `review.started` — the worker's
    // own elapsed time is not the reviewer's budget. Found live: a 24-minute review nothing was watching.
    const activeReview = events.findLast(e => e.task === t.id && ['review.started', 'review.finished'].includes(e.kind));
    const reviewing = t.state === 'reviewing' || activeReview?.kind === 'review.started';
    if (t.state !== 'running' && !reviewing) continue;
    const lease = attemptLease(events, t.id, {...cfg, stage: reviewing ? 'review' : 'turn'});
    if (!lease) continue;
    const {startedAt, leaseMs, leaseStartAt, deadlineAt, renewals, ceilingAt, leaseFrom} = lease;
    // Liveness is about THIS worker, so it is measured from this attempt's own start — never the
    // lineage's. Found live: a fallback launched the second its predecessor died was escalated
    // as "stalled for 843 s" one second later, because the root's start seeded its progress clock. Only
    // the ceiling above spans the lineage; this and the lease both belong to the attempt.
    let progressAt = leaseFrom;
    for (const e of events) {
      if (e.task !== t.id) continue;
      if (e.kind === 'task.milestone' || e.kind === 'task.usage' || e.kind === 'task.blocked') progressAt = Math.max(progressAt, Date.parse(e.time));
      // A delivered message counts as progress only when it came from someone other than the
      // watchdog itself: its own corrective nudge (§3) must never reset the very signature it
      // was sent because of, or the escalation ladder could never reach grace/cancel.
      else if (e.kind === 'task.delivered' && (e.tier === 'live' || e.tier === 'next-turn')) {
        const message = events.find(m => m.kind === 'message' && m.id === e.message);
        if (message?.from !== 'bounce') progressAt = Math.max(progressAt, Date.parse(e.time));
      }
    }
    const act = activity.get(t.id);
    const activityAt = Math.max(progressAt, act?.at ?? -Infinity);
    const expectUntil = act?.expectUntil ?? null;
    const elapsed = now - startedAt;
    const verdicts = [];
    if (now >= deadlineAt) verdicts.push('deadline');
    const suppressed = expectUntil != null && now < expectUntil;
    if (!suppressed) {
      if (now - activityAt >= cfg.silence) verdicts.push('silent');
      else if (now - progressAt >= cfg.stall) verdicts.push('stalled');
    }
    // F4/A7: absolute timestamps (a moment), never durations — lastActivityAt/lastProgressAt.
    // The policy that consumes this row (scheduler tick()) is the one place that turns them
    // into elapsed ms, under the duration names, inside its own evidence object.
    if (verdicts.length) result.push({task: t.id, stage: reviewing ? 'review' : 'turn', startedAt, deadlineAt, leaseMs, leaseStartAt, renewals, ceilingAt, elapsed, lastActivityAt: activityAt, lastProgressAt: progressAt, expectUntil, verdicts});
  }
  return result;
}

export function attemptLease(events, task, {defaultDeadlineMs = 3600000, ceilingMs = 3600000, stage} = {}) {
  const view = tasks(events);
  let root = task;
  const seen = new Set();
  while (view[root]?.replaces && view[view[root].replaces] && !seen.has(root)) {
    seen.add(root); root = view[root].replaces;
  }
  const review = events.findLast(e => e.kind === 'review.started' && e.task === task);
  const reviewEnd = events.findLast(e => e.kind === 'review.finished' && e.task === task);
  const reviewing = stage === 'review' || (stage === undefined && review && (!reviewEnd || review.seq > reviewEnd.seq));
  const rootStart = events.find(e => e.kind === 'task.started' && e.task === root);
  const ownStart = events.findLast(e => e.kind === 'task.started' && e.task === task);
  const start = reviewing ? review : ownStart ?? rootStart;
  if (!start) return null;
  const startedAt = Date.parse((rootStart ?? start).time);
  const leaseFrom = Date.parse(start.time);
  const submitted = events.find(e => e.kind === 'task.submitted' && e.task === root);
  const leaseMs = submitted?.deadline ?? defaultDeadlineMs;
  const renewals = events.filter(e => e.kind === 'task.lease.renewed' && e.task === task && e.seq > start.seq && (reviewing ? e.stage === 'review' : !e.stage)).length;
  const ceilingAt = startedAt + Math.max(ceilingMs, leaseMs);
  return {stage: reviewing ? 'review' : 'turn', startedAt, leaseFrom, leaseMs, renewals, ceilingAt,
    leaseStartAt: Math.min(leaseFrom + leaseMs * renewals, ceilingAt),
    deadlineAt: Math.min(leaseFrom + leaseMs * (renewals + 1), ceilingAt)};
}

export function cooldowns(events, now) {
  const result = {};
  for (const e of events) if (e.kind === 'cooldown') result[e.provider] = e.until;
  for (const provider in result) if (result[provider] <= now) delete result[provider];
  return result;
}

// Every vendor's usage field name, mapped to the four canonical categories the rest of this file
// sums over — raw adapters (src/adapters/claude.js, codex.js) pass the vendor's own field names
// through unmapped, live adapters and workers (src/scheduler.js task.usage) already normalize, so
// this map carries both: an already-canonical key maps to itself, a vendor key maps across.
const USAGE_KEY_MAP = {
  input_tokens: 'input', cache_read_input_tokens: 'cache_read', cache_creation_input_tokens: 'cache_write',
  cached_input_tokens: 'cache_read', cache_write_input_tokens: 'cache_write', output_tokens: 'output',
  input: 'input', cache_read: 'cache_read', cache_write: 'cache_write', output: 'output',
};
export function normalizeUsage(raw) {
  const usage = {};
  if (!raw || typeof raw !== 'object') return usage;
  for (const [key, canon] of Object.entries(USAGE_KEY_MAP)) {
    const value = raw[key];
    if (Number.isFinite(value)) usage[canon] = (usage[canon] || 0) + value;
  }
  return usage;
}
const TOKEN_KEYS = ['input', 'cache_read', 'cache_write', 'output'];
const tokenSum = usage => TOKEN_KEYS.reduce((sum, key) => sum + (usage[key] || 0), 0);

// Which model a usage row belongs to: the most recent `model` row seen for the same (from, task)
// pair, else — since a worker always gets a task.started before it ever reports usage — the
// model it was launched with, else the main session's latest `route.model`, else unattributed.
// A row with no usable numbers carries no information and is dropped outright, never a zero entry.
export function modelUsage(events) {
  const lastModel = new Map(); // `${from}|${task ?? ''}` -> {model, provider}
  const lastRoute = new Map(); // from -> {model, provider}
  const requested = new Map(); // task -> requested model string
  const entries = new Map(); // `${provider}::${model}` -> row
  const ensure = (model, provider) => {
    const key = `${provider}::${model}`;
    let row = entries.get(key);
    if (!row) { row = {model, provider, usage: {input: 0, cache_read: 0, cache_write: 0, output: 0}, tokens: 0, turns: 0}; entries.set(key, row); }
    return row;
  };
  for (const e of events) {
    const attrKey = `${e.from}|${e.task ?? ''}`;
    if (e.kind === 'model' && typeof e.model === 'string') { lastModel.set(attrKey, {model: e.model, provider: e.provider}); continue; }
    if (e.kind === 'route' && typeof e.model === 'string') {
      // "default" is the router saying no model was pinned, not a model name: falling through
      // leaves attribution to land on `${provider} default` instead of a literal "default" row.
      if (e.model.trim() && e.model.trim().toLowerCase() !== 'default') lastRoute.set(e.from, {model: e.model, provider: e.provider});
      continue;
    }
    if (e.kind === 'task.started' && typeof e.task === 'string' && typeof e.requested === 'string' && e.requested) { requested.set(e.task, e.requested); continue; }
    if (e.kind !== 'usage' && e.kind !== 'task.usage') continue;
    const usage = normalizeUsage(e.usage);
    if (!Object.keys(usage).length) continue;
    const attribution = lastModel.get(attrKey)
      ?? (typeof e.task === 'string' && requested.has(e.task) ? {model: requested.get(e.task), provider: e.provider} : undefined)
      ?? lastRoute.get(e.from);
    const provider = attribution?.provider ?? e.provider ?? null;
    const model = attribution?.model ?? (provider ? `${provider} default` : 'default');
    const row = ensure(model, provider);
    sumInto(row.usage, usage);
    row.tokens += tokenSum(usage);
    row.turns++;
  }
  return [...entries.values()].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
}

// A session's name: an explicit `session.renamed` wins, else a model-given `session.titled`
// (src/session-title.js — asked once, from the first prompt), else the first line of its first
// prompt (the orchestrator brief line stripped), cut to 48 characters; null for an empty log.
export function sessionName(events) {
  const renamed = events.findLast(e => e.kind === 'session.renamed' && typeof e.name === 'string' && e.name.trim());
  if (renamed) return renamed.name.trim();
  const titled = events.findLast(e => e.kind === 'session.titled' && typeof e.name === 'string' && e.name.trim());
  if (titled) return titled.name.trim();
  const first = events.find(e => e.kind === 'user' && typeof e.text === 'string');
  if (!first) return null;
  const line = first.text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('You are the orchestrator peer of session'))[0];
  if (!line) return null;
  const compact = line.replace(/\s+/g, ' ');
  return compact.length > 48 ? `${compact.slice(0, 47).trimEnd()}…` : compact;
}
