import {randomUUID} from 'node:crypto';
import * as reducers from './reducers.js';
import {takeCheckpoint, sameTree} from './checkpoint.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const FALLBACK_REASONS = new Set(['limited', 'missing', 'backend_unavailable']);

// Dispatch, fallback, permission ratchet, cancellation and reconcile as policies over the
// log, driven by adapters. Everything the scheduler knows is re-derived from session.events
// via the reducers — it keeps only a live-handle map, which cannot survive a restart by design.
export function createScheduler({session, adapters, profiles, sessionMode = 'yolo', depthCap = 1, checkpointRunner}) {
  const handles = new Map(); // task -> {adapter, handle}
  const workerFrom = task => `worker:${task}`;
  const submittedRow = task => session.events.find(e => e.kind === 'task.submitted' && e.task === task);

  const validate = (spec, view) => {
    if (!profiles[spec.profile]) return 'profile';
    if (typeof spec.orders !== 'string' || !spec.orders) return 'orders';
    if (spec.deadline !== null && spec.deadline !== undefined && !Number.isFinite(spec.deadline)) return 'deadline';
    if (spec.parent != null && !view[spec.parent]) return 'parent';
    if (spec.budget !== undefined && spec.parent != null) return 'budget';
    if (spec.checkpoint != null && typeof spec.checkpoint !== 'object') return 'checkpoint';
    return null;
  };

  function submit(spec) {
    const view = reducers.tasks(session.events);
    const problem = validate(spec, view);
    if (problem) throw new Error(`malformed: ${problem}`);
    const task = spec.task ?? randomUUID();
    return session.append({
      kind: 'task.submitted', task,
      parent: spec.parent ?? null,
      context: spec.context,
      profile: spec.profile,
      orders: spec.orders,
      deadline: spec.deadline ?? null,
      budget: spec.budget,
      replaces: spec.replaces ?? null,
      checkpoint: spec.checkpoint ?? null,
      ref: spec.ref,
    });
  }

  // The task's own root for BUDGET purposes: follows a replacement to the task it replaced
  // before falling back to the parent chain — mirrors reducers.budgets' rootOf exactly. A
  // cycle (only possible from a directly-journaled row, never from submit()) ends at the
  // first revisited id rather than recursing forever.
  const budgetRootOf = (id, view, seen = new Set()) => {
    if (seen.has(id)) return id;
    seen.add(id);
    const t = view[id];
    if (t?.replaces && view[t.replaces]) return budgetRootOf(t.replaces, view, seen);
    if (t?.parent && view[t.parent]) return budgetRootOf(t.parent, view, seen);
    return id;
  };
  // A root with no `starts` in its own declared allowance draws unlimited starts: unlike
  // `remaining`, this stays Infinity even after the root's own dispatch has reserved one.
  const availableStarts = rootId => {
    const view = reducers.budgets(session.events).roots[rootId];
    return view?.allowance?.starts === undefined ? Infinity : view.remaining.starts;
  };

  // The task's own lineage root for FALLBACK purposes: only follows `replaces`, so a
  // retry's "profiles already tried" never conflates sibling fallback chains. Cycle-guarded
  // like budgetRootOf, for the same reason (a directly-journaled self/mutual replace).
  const lineageRootOf = (id, view, seen = new Set()) => {
    if (seen.has(id)) return id;
    seen.add(id);
    return view[id]?.replaces && view[view[id].replaces] ? lineageRootOf(view[id].replaces, view, seen) : id;
  };
  const lineageProfiles = (rootId, view) => Object.keys(view).filter(id => lineageRootOf(id, view) === rootId).map(id => view[id].profile);

  function maybeFallback(row) {
    if (!FALLBACK_REASONS.has(row.reason)) return;
    const view = reducers.tasks(session.events);
    const t = view[row.task];
    if (!t) return;
    // A task that has since gone terminal some other way (cancelled mid-flight, or already
    // replaced) never spawns a fallback on a late/racy result — only its own failure does.
    if (TERMINAL.has(t.state) && t.state !== 'failed') return;
    const profile = profiles[t.profile];
    if (!profile) return; // the profile this task ran under no longer exists: nothing to fall back from
    const lineageRoot = lineageRootOf(row.task, view);
    const tried = new Set(lineageProfiles(lineageRoot, view));
    const next = (profile.fallback ?? []).find(name => !tried.has(name));
    if (!next) return;
    session.append({kind: 'policy.fallback', task: row.task, from_profile: t.profile, to_profile: next, reason: row.reason});
    const original = submittedRow(row.task);
    const originalRef = submittedRow(lineageRoot)?.ref;
    submit({
      parent: original.parent, context: original.context, profile: next, orders: original.orders, deadline: original.deadline,
      replaces: row.task, ref: `${originalRef ?? row.task}:fallback:${next}`,
    });
  }

  async function dispatch(row) {
    const {task, parent, context} = row;
    const view = reducers.tasks(session.events);
    // Cycle-guarded: only a directly-journaled row (never submit(), which requires a
    // pre-existing parent) can make a task its own ancestor.
    const depthOf = (id, seen = new Set()) => {
      if (seen.has(id)) return 0;
      seen.add(id);
      return view[id]?.parent ? 1 + depthOf(view[id].parent, seen) : 0;
    };
    if (parent != null && 1 + depthOf(parent) > depthCap) {
      session.append({kind: 'task.failed', task, reason: 'depth', text: `depth exceeds cap ${depthCap}`, context});
      return;
    }
    const profile = profiles[row.profile];
    if (!profile) {
      session.append({kind: 'task.failed', task, reason: 'error', text: `malformed: profile`, context});
      return;
    }
    if (profile.mode === 'yolo' && sessionMode === 'plan') {
      session.append({kind: 'task.failed', task, reason: 'policy', text: 'worker mode exceeds session mode', context});
      return;
    }
    const root = budgetRootOf(task, view);
    if (availableStarts(root) < 1) {
      session.append({kind: 'task.failed', task, reason: 'budget', text: 'root budget exhausted', context});
      return;
    }
    // A checkpoint on the row means the task was submitted against a specific tree state:
    // never launch a worker against a tree that has since drifted (tests/check are not part
    // of the comparison — only head/status/diff, via sameTree).
    if (row.checkpoint) {
      const current = await takeCheckpoint({cwd: session.cwd, run: checkpointRunner});
      if (!sameTree(row.checkpoint, current)) {
        session.append({kind: 'task.failed', task, reason: 'baseline', text: 'tree differs from the task checkpoint', context});
        return;
      }
    }
    session.append({kind: 'budget.reserved', task, root, amount: {starts: 1}, context});

    const adapter = adapters[profile.adapter];
    let handle;
    try {
      handle = await adapter.launch({peer: workerFrom(task), profile, orders: row.orders, cwd: session.cwd});
    } catch (error) {
      if (error.code === 'missing' || error.code === 'backend_unavailable') session.append({kind: 'task.failed', task, reason: error.code, from: workerFrom(task), context});
      else session.append({kind: 'task.failed', task, reason: 'error', text: error.message, from: workerFrom(task), context});
      return;
    }
    // The task may have been cancelled (or otherwise gone terminal) while launch() was
    // pending: don't adopt it as live, just shut down the now-unwanted process.
    if (TERMINAL.has(reducers.tasks(session.events)[task]?.state)) {
      await adapter.cancel(handle);
      return;
    }
    handles.set(task, {adapter, handle});
    try {
      session.append({kind: 'peer.joined', name: workerFrom(task), role: 'worker', adapter: profile.adapter, profile: row.profile, from: workerFrom(task), context});
      const attempt = session.events.filter(e => e.kind === 'task.started' && e.task === task).length + 1;
      session.append({kind: 'task.started', task, attempt, requested: profile.model ?? '', from: workerFrom(task), context});

      for await (const event of adapter.events(handle)) {
        const from = workerFrom(task);
        switch (event.kind) {
          case 'activity': session.publish({kind: 'task.activity', task, text: event.text, from, context}); break;
          // Quota rides on the vendor stream; journaling the worker's raw lines with its provider lets recordQuota see them exactly as it sees the main provider's.
          case 'raw': session.append({kind: 'raw', raw: event.raw ?? null, provider: profile.adapter, task, from, context}); break;
          case 'model': session.append({kind: 'model', model: String(event.model), provider: profile.adapter, task, from, context}); break;
          case 'milestone': session.append({kind: 'task.milestone', task, text: event.text, evidence: event.evidence, from, context}); break;
          case 'blocked': session.append({kind: 'task.blocked', task, text: event.text, from, context}); break;
          case 'usage': session.append({kind: 'task.usage', task, usage: event.usage, from, context}); break;
          case 'native': session.append({kind: 'peer.native', from, provider: event.provider, sessionId: event.sessionId, context}); break;
          case 'result':
            if (event.status === 'completed') session.append({kind: 'task.completed', task, summary: event.text, from, context});
            else session.append({kind: 'task.failed', task, reason: event.status === 'limited' ? 'limited' : 'error', text: event.text, from, context});
            break;
        }
      }
    } catch (error) {
      // A broken adapter stream (or anything else unexpected past this point) must never
      // escape the subscriber as an unhandled rejection: it becomes this task's own failure.
      session.append({kind: 'task.failed', task, reason: 'error', text: error.message, from: workerFrom(task), context});
    } finally {
      handles.delete(task);
    }
  }

  const unsubscribe = session.subscribe(row => {
    if (row.kind === 'task.submitted') {
      // Any throw here (including one from before the first `await`, which an async
      // function turns into a rejection rather than a synchronous throw) must land on the
      // task as its own failure — never disappear, leaving the task queued forever.
      dispatch(row).catch(error => session.append({kind: 'task.failed', task: row.task, reason: 'error', text: error.message, context: row.context}));
    }
    else if (row.kind === 'task.failed') maybeFallback(row);
  });

  // Reconcile: every task the reducer reports mid-flight has no live handle right after a
  // restart (all of them, at construction) — mark it blocked rather than assume it's alive.
  const initialView = reducers.tasks(session.events);
  for (const t of Object.values(initialView)) if ((t.state === 'running' || t.state === 'waiting') && !handles.has(t.id))
    session.append({kind: 'task.blocked', task: t.id, text: 'interrupted: no live handle after restart'});

  // Cycle-guarded for the same reason as the root-walkers above.
  const postOrder = (view, id, seen = new Set()) => {
    if (seen.has(id)) return [];
    seen.add(id);
    return [...(view[id]?.children ?? []).flatMap(child => postOrder(view, child, seen)), id];
  };

  async function cancelOne(id, view) {
    const entry = handles.get(id);
    const result = entry ? await entry.adapter.cancel(entry.handle) : {verified: true};
    if (result.verified === false) {
      session.append({kind: 'task.blocked', task: id, text: 'termination unverified', from: workerFrom(id), context: view[id].context});
      return false;
    }
    session.append({kind: 'task.cancelled', task: id, from: workerFrom(id), context: view[id].context});
    return true;
  }

  async function cancel(taskId) {
    const view = reducers.tasks(session.events);
    if (!view[taskId]) return {verified: true}; // nothing was ever submitted under this id: nothing to cancel
    let verified = true;
    for (const id of postOrder(view, taskId)) {
      if (TERMINAL.has(view[id]?.state)) continue;
      if (!(await cancelOne(id, view))) verified = false;
    }
    return {verified};
  }

  async function stop() {
    const view = reducers.tasks(session.events);
    const roots = Object.values(view).filter(t => !t.parent && !TERMINAL.has(t.state));
    const cancelled = [], unverified = [];
    for (const root of roots) for (const id of postOrder(view, root.id)) {
      if (TERMINAL.has(view[id]?.state)) continue;
      (await cancelOne(id, view) ? cancelled : unverified).push(id);
    }
    return {cancelled, unverified};
  }

  return {
    submit, cancel, stop,
    tasks: () => reducers.tasks(session.events),
    budgets: () => reducers.budgets(session.events),
    close: () => unsubscribe(),
  };
}
