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

// TERMINAL is the one definition shared with src/scheduler.js (imported from here, never
// redefined): completed/failed/cancelled/timed_out end a task with no review pending;
// accepted/rejected end one that went through review policy.
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'accepted', 'rejected']);
const emptyTask = id => ({id, parent: null, replaces: null, lastMilestone: null, blocker: null, reason: null, error: null, children: [], review: null, depends_on: [], steps: null, rounds: 0, accepted: false, prelaunch: null});

// A task exists only once its own task.submitted is seen; any other task.* row for an unknown id is dropped. A parent stays waiting through its own progress events while any child is non-terminal, remembering which state (its last progress, or its own queued submission) to resume once every child terminates; terminal states never change again — except `task.accepted`, the one permitted exit from `completed`/`reviewing` into the frozen `accepted` state.
export function tasks(events) {
  const result = {};
  const priorState = {};
  const ensure = id => result[id] ??= emptyTask(id);
  const settleParent = parentId => {
    const parent = result[parentId];
    if (!parent || parent.state !== 'waiting') return;
    if (parent.children.every(id => TERMINAL.has(result[id]?.state))) parent.state = priorState[parentId];
  };
  for (const e of events) {
    if (!e.kind?.startsWith('task.')) continue;
    if (e.kind === 'task.submitted') {
      const t = ensure(e.task);
      if (TERMINAL.has(t.state)) continue;
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
      case 'task.blocked': t.state = 'blocked'; t.blocker = e.text; break;
      case 'task.input_required': t.state = 'input_required'; break;
      case 'task.milestone':
        if (t.state === 'waiting') priorState[e.task] = 'running';
        else if (t.state === 'blocked' || t.state === 'input_required') t.state = 'running';
        t.lastMilestone = {time: e.time, text: e.text, evidence: e.evidence};
        break;
      case 'task.completed':
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
        if (t.state === 'reviewing') { t.state = 'running'; t.rounds = (t.rounds || 0) + 1; }
        break;
      case 'task.accepted':
        if (e.stage === 'prelaunch') { if (t.state === 'queued') t.prelaunch = 'accepted'; break; }
        // completion (or an unstaged direct accept): reviewing→accepted is the actual
        // terminal entry (reviewing is not terminal, so the parent is still `waiting`
        // and must be settled); completed→accepted already settled its parent when it
        // first went terminal at `completed`, so settleParent does not re-fire here.
        if (t.state === 'reviewing') { t.state = 'accepted'; t.accepted = true; settleParent(t.parent); }
        else if (t.state === 'completed') { t.state = 'accepted'; t.accepted = true; }
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

export function cooldowns(events, now) {
  const result = {};
  for (const e of events) if (e.kind === 'cooldown') result[e.provider] = e.until;
  for (const provider in result) if (result[provider] <= now) delete result[provider];
  return result;
}
