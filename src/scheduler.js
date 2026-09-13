import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as reducers from './reducers.js';
import {takeCheckpoint, sameTree} from './checkpoint.js';
import {POLICY_RANK, effectivePolicy} from './profiles.js';
import {defaultStrategy} from './strategy.js';

const FALLBACK_REASONS = new Set(['limited', 'missing', 'backend_unavailable']);
const RISKS = new Set(['boundary', 'process-model', 'logic', 'extraction']);
const SIZE_FIELDS = ['lines', 'probes', 'minutes'];
const LIMIT_FIELDS = [...SIZE_FIELDS, 'rounds'];
const TIERS = new Set(['live', 'next-turn', 'queued']);
const READONLY_ROLES = new Set(['critic', 'verifier', 'analyst']);
// The depends_on hold/fail decision (which dependency states fail a dependent outright vs.
// merely hold it — A1) now lives in the strategy (src/strategy.js's DEPENDENCY_FAIL_STATES),
// not here: this scheduler only executes the intent onSubmitted returns.

const isNonNegativeInt = n => Number.isInteger(n) && n >= 0;
const isPositiveInt = n => Number.isInteger(n) && n > 0;

// The verdict protocol (CONTRACT.md §4): the LAST line of a completed review's text that
// parses as JSON with a string `verdict` field is the verdict. A missing/failed result, or
// no such line, is `unreadable` — never thrown, always a value the policy can act on.
function parseVerdict(status, text) {
  if (status === 'completed' && typeof text === 'string') {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.verdict === 'string') return parsed;
      } catch { /* not JSON: keep scanning earlier lines */ }
    }
  }
  return {verdict: 'unreadable'};
}

// Dispatch, fallback, permission ratchet, cancellation, review and reconcile as policies over
// the log, driven by adapters. Everything the scheduler knows is re-derived from session.events
// via the reducers — it keeps only a live-handle map, which cannot survive a restart by design.
export function createScheduler({session, adapters, profiles, sessionMode = 'yolo', depthCap = 1, checkpointRunner, limits: suppliedLimits = {}, strict = false, clock = () => Date.now(), watchdog: suppliedWatchdog = {}, strategy = defaultStrategy}) {
  const limits = {lines: 150, probes: 6, minutes: 15, rounds: 2, ...suppliedLimits};
  if (LIMIT_FIELDS.some(field => !isPositiveInt(limits[field]))) throw new Error('malformed: limits');
  const watchdogConfig = {interval: 5000, silence: 120000, stall: 600000, grace: 120000, ...suppliedWatchdog};
  const intervalOk = watchdogConfig.interval === null || isPositiveInt(watchdogConfig.interval);
  if (!intervalOk || !isPositiveInt(watchdogConfig.silence) || !isPositiveInt(watchdogConfig.stall) || !isPositiveInt(watchdogConfig.grace)) throw new Error('malformed: watchdog');
  const handles = new Map(); // task -> {adapter, handle}
  const reviews = new Map(); // task -> {adapter, handle}, one review in flight per task (A3)
  const heldTasks = new Set(); // tasks queued behind an unaccepted depends_on, re-evaluated on terminal rows
  // Live activity, never journaled (task.activity is a LIVE_KIND): task -> {at, expectUntil}.
  // Updated straight off the subscriber below, the same way it sees every other peer-published row.
  const activity = new Map();
  const workerFrom = task => `worker:${task}`;
  const reviewFrom = task => `review:${task}`;
  const submittedRow = task => session.events.find(e => e.kind === 'task.submitted' && e.task === task);
  // Every row the scheduler itself writes is stamped from the injected clock, not the journal's
  // own wall-clock default — the watchdog's `now` and every row `time` it compares against must
  // live on the same timeline. Under the default `clock = Date.now`, this is the same wall-clock
  // instant the journal would have picked anyway, so the real-clock path is byte-for-byte
  // unchanged; only the fake-clock path (tests) actually diverges from `new Date().toISOString()`.
  const stamp = () => new Date(clock()).toISOString();
  const append = event => session.append({...event, time: stamp()});
  const publish = event => session.publish({...event, time: stamp()});

  // Session effective policy: the user session is write-privileged; only its mode narrows it
  // (docs/local-orchestration.md "Permissions", CONTRACT.md §1).
  const sessionEffective = sessionMode === 'plan' ? 'plan' : 'yolo';

  // The pre-launch policy check (CONTRACT.md §3), shared by every path that launches a profile
  // (the worker's own launch and a prelaunch review's launch): ratchet-down first (never more
  // privileged than the session), then per-provider support (`unsupported` over downgrade — an
  // adapter that declares no executionPolicies is unconstrained, so bare test fakes keep
  // working). Order matters: a yolo profile under a plan session reports `policy`, not
  // `unsupported`, even on an adapter that cannot enforce yolo.
  function policyRefusal(profile) {
    const eff = effectivePolicy(profile);
    if (POLICY_RANK[eff] > POLICY_RANK[sessionEffective]) {
      return {reason: 'policy', text: `worker policy ${eff} exceeds session policy ${sessionEffective}`};
    }
    const caps = adapters[profile.adapter]?.capabilities?.() ?? {};
    if (Array.isArray(caps.executionPolicies) && !caps.executionPolicies.includes(eff)) {
      return {reason: 'unsupported', text: `${profile.adapter} cannot enforce ${eff}`};
    }
    return null;
  }

  const validate = (spec, view) => {
    if (!profiles[spec.profile]) return 'profile';
    if (typeof spec.orders !== 'string' || !spec.orders) return 'orders';
    if (spec.deadline !== null && spec.deadline !== undefined && !Number.isFinite(spec.deadline)) return 'deadline';
    if (spec.parent != null && !view[spec.parent]) return 'parent';
    if (spec.budget !== undefined && spec.parent != null) return 'budget';
    if (spec.budget?.rounds !== undefined && !isNonNegativeInt(spec.budget.rounds)) return 'budget';
    if (spec.checkpoint != null && typeof spec.checkpoint !== 'object') return 'checkpoint';
    if (spec.risk !== undefined && !RISKS.has(spec.risk)) return 'risk';
    if (spec.size !== undefined && SIZE_FIELDS.some(field => !isNonNegativeInt(spec.size[field]))) return 'size';
    if (spec.depends_on !== undefined) {
      if (!Array.isArray(spec.depends_on)) return 'depends_on';
      if (spec.depends_on.some(id => id === spec.task || !view[id])) return 'depends_on';
    }
    const review = spec.review;
    if (review !== undefined) {
      if (typeof review !== 'object' || review === null || Array.isArray(review)) return 'review';
      const {prelaunch, completion, ...rest} = review;
      if (Object.keys(rest).length) return 'review';
      // Phase 8: a stage may name one profile (today's only shape) or, for a quorum strategy,
      // an array of several — every named profile must still be a review-role profile.
      for (const name of [prelaunch, completion]) {
        if (name === undefined) continue;
        const names = Array.isArray(name) ? name : [name];
        if (!names.length) return 'review';
        for (const n of names) {
          const p = profiles[n];
          if (!p || !READONLY_ROLES.has(p.role)) return 'review';
        }
      }
    }
    if (strict && (!review || !review.prelaunch || !review.completion)) return 'review';
    const completionName = Array.isArray(review?.completion) ? review.completion[0] : review?.completion;
    const completionProfile = completionName && profiles[completionName];
    if (completionProfile?.role === 'verifier' && (typeof spec.steps !== 'string' || !spec.steps)) return 'steps';
    return null;
  };

  function submit(spec) {
    const view = reducers.tasks(session.events);
    const problem = validate(spec, view);
    if (problem) throw new Error(`malformed: ${problem}`);
    const task = spec.task ?? randomUUID();
    return append({
      kind: 'task.submitted', task,
      parent: spec.parent ?? null,
      from: spec.from,
      context: spec.context,
      profile: spec.profile,
      orders: spec.orders,
      deadline: spec.deadline ?? null,
      budget: spec.budget,
      replaces: spec.replaces ?? null,
      checkpoint: spec.checkpoint ?? null,
      ref: spec.ref,
      risk: spec.risk ?? 'logic',
      size: spec.size ?? {lines: 0, probes: 0, minutes: 0},
      depends_on: spec.depends_on ?? [],
      review: spec.review ?? null,
      steps: spec.steps ?? null,
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
    if (reducers.TERMINAL.has(t.state) && t.state !== 'failed') return;
    const profile = profiles[t.profile];
    if (!profile) return; // the profile this task ran under no longer exists: nothing to fall back from
    const lineageRoot = lineageRootOf(row.task, view);
    const tried = new Set(lineageProfiles(lineageRoot, view));
    const next = (profile.fallback ?? []).find(name => !tried.has(name));
    if (!next) return;
    append({kind: 'policy.fallback', task: row.task, from_profile: t.profile, to_profile: next, reason: row.reason});
    const original = submittedRow(row.task);
    const originalRef = submittedRow(lineageRoot)?.ref;
    submit({
      parent: original.parent, context: original.context, profile: next, orders: original.orders, deadline: original.deadline,
      replaces: row.task, ref: `${originalRef ?? row.task}:fallback:${next}`,
    });
  }

  // A held task (queued behind an unaccepted depends_on) has no budget.reserved yet, so
  // re-running dispatch() on it is always safe: sizing/depth/profile/mode were already
  // satisfied the first time and cannot change, only the dependency's state can.
  function reevaluateHeld() {
    for (const task of [...heldTasks]) {
      heldTasks.delete(task);
      const row = submittedRow(task);
      if (!row) continue;
      dispatch(row).catch(error => append({kind: 'task.failed', task, reason: 'error', text: error.message, context: row.context}));
    }
  }

  // STRATEGY (CONTRACT.md §2 onCompleted): fires on every task.completed row (even a second/
  // later one on the same task). `defaultStrategy` reproduces the exact pre-Phase-8 condition
  // (only a row whose review.completion is set ever entered a completion review) via its own
  // onCompleted hook — the CORE here just executes whatever intent comes back.
  async function handleCompleted(task) {
    const view = reducers.tasks(session.events);
    const t = view[task];
    if (!t) return;
    const row = submittedRow(task);
    const context = row?.context;
    const hook = invokeHook(() => strategy.onCompleted(task, view, api), task, context);
    if (!hook.ok) return;
    const intent = hook.intent;
    if (intent === 'none') return;
    if (intent && typeof intent === 'object' && intent.action === 'accept') {
      // Only meaningful while the task is still sitting in `completed`/`reviewing` awaiting a
      // completion decision — a task that moved on for an unrelated reason (e.g. already
      // accepted directly) gets no further row from this stale trigger (A3-style guard).
      const state = reducers.tasks(session.events)[task]?.state;
      if (state !== 'completed' && state !== 'reviewing') return;
      append({kind: 'task.accepted', task, stage: 'completion', by: 'strategy', context});
      return;
    }
    if (intent && typeof intent === 'object' && intent.action === 'review') {
      await runCompletionReview(task, intent);
      return;
    }
    append({kind: 'task.failed', task, reason: 'strategy', text: 'malformed onCompleted intent', context});
  }

  // STRATEGY (CONTRACT.md §1 onTerminal): fires after a task actually leaves the tree for good
  // (accepted/failed/cancelled/timed_out/rejected — NOT a bare `completed`, which may still be
  // heading into review). Held-task re-evaluation is CORE and always runs regardless of what
  // the strategy decides; the strategy only adds an optional next-wave fan-out.
  function handleTerminal(row) {
    reevaluateHeld();
    const view = reducers.tasks(session.events);
    const hook = invokeHook(() => strategy.onTerminal(row.task, view, api), row.task, row.context);
    if (!hook.ok) return;
    if (!hook.intent || typeof hook.intent !== 'object' || !Array.isArray(hook.intent.submit)) return;
    for (const spec of hook.intent.submit) {
      try { submit(spec); }
      catch { /* a malformed fan-out spec is dropped: a strategy can never crash the daemon */ }
    }
  }

  // Worker transcript stays live-only: journaling it as assistant/tool would leak into
  // handoff(), which filters by kind, not context. Quota rides on the vendor stream;
  // journaling the worker's raw lines with its provider lets recordQuota see them exactly as
  // it sees the main provider's. Shared by the initial launch and by a rework resume — a
  // review's own event consumption (runReview) is a narrower variant of the same switch.
  async function consumeWorkerEvents({adapter, handle, task, context, profile}) {
    const from = workerFrom(task);
    try {
      for await (const event of adapter.events(handle)) {
        switch (event.kind) {
          case 'activity': publish({kind: 'task.activity', task, text: event.text, from, context}); break;
          case 'assistant': case 'tool': case 'progress': publish({kind: 'task.activity', task, text: event.text, from, context}); break;
          case 'error': publish({kind: 'task.activity', task, text: `error: ${event.text}`, from, context}); break;
          case 'diagnostic': case 'status': publish({kind: 'task.activity', task, text: event.text, from, context}); break;
          case 'delta': break; // streaming fragments; the assembled text arrives as 'assistant'
          case 'raw': append({kind: 'raw', raw: event.raw ?? null, provider: profile.adapter, task, from, context}); break;
          case 'model': append({kind: 'model', model: String(event.model), provider: profile.adapter, task, from, context}); break;
          case 'milestone': append({kind: 'task.milestone', task, text: event.text, evidence: event.evidence, from, context}); break;
          case 'blocked': append({kind: 'task.blocked', task, text: event.text, from, context}); break;
          case 'usage': append({kind: 'task.usage', task, usage: event.usage, from, context}); break;
          case 'native': append({kind: 'peer.native', from, provider: event.provider, sessionId: event.sessionId, context}); break;
          case 'result':
            if (event.status === 'completed') append({kind: 'task.completed', task, summary: event.text, from, context});
            else append({kind: 'task.failed', task, reason: event.status === 'limited' ? 'limited' : 'error', text: event.text, from, context});
            break;
        }
      }
    } catch (error) {
      // A broken adapter stream (or anything else unexpected past this point) must never
      // escape the subscriber as an unhandled rejection: it becomes this task's own failure.
      append({kind: 'task.failed', task, reason: 'error', text: error.message, from, context});
    } finally {
      handles.delete(task);
    }
  }

  // Reserve the worker's own start and launch it: the tail shared by a plain dispatch and by
  // an accepted prelaunch review. Sizing/depth/profile/mode/depends_on/budget/checkpoint were
  // already checked by the caller.
  async function launchWorker(row, {reserve = true} = {}) {
    const {task, context} = row;
    const root = budgetRootOf(task, reducers.tasks(session.events));
    // `reserve: false` means the caller (dispatch) already made this reservation, synchronously,
    // before its own first await (§4) — never reserve twice for the same start.
    if (reserve) append({kind: 'budget.reserved', task, root, amount: {starts: 1}, context});

    const dir = path.join(session.dir, 'tasks', task);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const profile = profiles[row.profile];
    const adapter = adapters[profile.adapter];
    let handle;
    try {
      handle = await adapter.launch({peer: workerFrom(task), profile, orders: row.orders, cwd: session.cwd, dir});
    } catch (error) {
      // The reservation this launch was going to consume never ran a process: release it (§4).
      append({kind: 'budget.released', task, root, amount: {starts: 1}, text: error.code ?? error.message, context});
      if (error.code === 'missing' || error.code === 'backend_unavailable') append({kind: 'task.failed', task, reason: error.code, from: workerFrom(task), context});
      else append({kind: 'task.failed', task, reason: 'error', text: error.message, from: workerFrom(task), context});
      return;
    }
    // The task may have been cancelled (or otherwise gone terminal) while launch() was
    // pending: don't adopt it as live, just shut down the now-unwanted process.
    if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) {
      await adapter.cancel(handle);
      return;
    }
    handles.set(task, {adapter, handle});
    append({kind: 'peer.joined', name: workerFrom(task), role: 'worker', adapter: profile.adapter, profile: row.profile, from: workerFrom(task), context});
    const attempt = session.events.filter(e => e.kind === 'task.started' && e.task === task).length + 1;
    append({kind: 'task.started', task, attempt, requested: profile.model ?? '', from: workerFrom(task), context});
    await consumeWorkerEvents({adapter, handle, task, context, profile});
  }

  // Rework, on the same worker: resume() carries the review's findings plus every message
  // that never reached the worker live (its latest task.delivered was 'queued') — the
  // pending-message projection is exactly that filter, never a separate store (T3c/Phase 4).
  // Returns the full message rows (not just text) so the caller can journal a delivery per
  // message once the resume actually happens (A2) — otherwise the same queued message folds
  // into every subsequent round's resume forever.
  function pendingMessages(task) {
    const to = workerFrom(task);
    const messages = session.events.filter(e => e.kind === 'message' && e.to === to);
    return messages.filter(m => session.events.filter(e => e.kind === 'task.delivered' && e.message === m.id).at(-1)?.tier === 'queued');
  }

  async function resumeWorker({task, row, round, findings, context}) {
    const profile = profiles[row.profile];
    const dir = path.join(session.dir, 'tasks', task);
    const nativeRow = session.events.filter(e => e.kind === 'peer.native' && e.from === workerFrom(task)).at(-1);
    const native = nativeRow ? {provider: nativeRow.provider, sessionId: nativeRow.sessionId} : {};
    const pending = pendingMessages(task);
    const message = [`Rework round ${round}:`, ...findings.map(f => `- ${f}`), ...pending.map(m => m.text)].join('\n');
    const adapter = adapters[profile.adapter];
    let handle;
    try {
      handle = await adapter.resume({peer: workerFrom(task), profile, native, message, cwd: session.cwd, dir, checkpoint: row.checkpoint});
    } catch (error) {
      // The rework round's own reservation (`{rounds: 1}`, made by the caller before this
      // resume) never ran a turn: release it (§4).
      const root = budgetRootOf(task, reducers.tasks(session.events));
      append({kind: 'budget.released', task, root, amount: {rounds: 1}, text: error.message, context});
      append({kind: 'task.failed', task, reason: 'error', text: error.message, from: workerFrom(task), context});
      return;
    }
    // A resume that resolves is deemed to have delivered every message it folded in: journal
    // 'next-turn' for each, right after the resume resolves, so a later round's fold (which
    // only re-picks messages whose LATEST delivery is still 'queued') never re-sends it (A2).
    // A throwing resume (the branch above) journals none of this — nothing was delivered.
    for (const m of pending) append({kind: 'task.delivered', task, tier: 'next-turn', message: m.id, text: `rework round ${round}`, from: 'bounce', context});
    if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) {
      await adapter.cancel(handle);
      return;
    }
    handles.set(task, {adapter, handle});
    const attempt = session.events.filter(e => e.kind === 'task.started' && e.task === task).length + 1;
    append({kind: 'task.started', task, attempt, resumed: true, requested: profile.model ?? '', from: workerFrom(task), context});
    await consumeWorkerEvents({adapter, handle, task, context, profile});
  }

  // A review worker: read-only, never journals task.activity's siblings as anything but
  // live activity, never emits task.completed/task.failed — only review.started/finished,
  // ending in a verdict the caller (prelaunch/completion policy) acts on. The handle lives in
  // its own `reviews` map (A3, separate from a worker's `handles`) for the window between
  // launch and the stream ending, so cancel()/stop() can reach it; a throwing stream (A4) ends
  // the same way a broken worker stream does — unreadable, handle cancelled, never left open.
  async function runReview({task, stage, round, profileName, profile, orders, dir, context, peer = reviewFrom(task)}) {
    append({kind: 'review.started', task, stage, round, profile: profileName, from: peer, context});
    const adapter = adapters[profile.adapter];
    let handle;
    try {
      handle = await adapter.launch({peer, profile, orders, cwd: session.cwd, dir});
    } catch (error) {
      append({kind: 'review.finished', task, stage, round, verdict: 'unreadable', text: error.message, from: peer, context});
      // launchFailed marks that no process ever ran: the caller releases the start it
      // reserved for this review (§4) — unlike an unreadable verdict from a review that did run.
      return {verdict: 'unreadable', launchFailed: true};
    }
    // Keyed by peer (not task): the CORE runs multi-reviewer rounds one reviewer at a time
    // (CONTRACT §5), so at most one entry per task ever exists at once — for the single-
    // reviewer default this key IS `review:${task}`, byte-identical to before Phase 8.
    reviews.set(peer, {adapter, handle, task});
    let resultStatus = null, resultText = null;
    try {
      for await (const event of adapter.events(handle)) {
        switch (event.kind) {
          case 'milestone': append({kind: 'task.milestone', task, text: event.text, evidence: event.evidence, from: peer, context}); break;
          case 'usage': append({kind: 'task.usage', task, usage: event.usage, from: peer, context}); break;
          case 'raw': append({kind: 'raw', raw: event.raw ?? null, provider: profile.adapter, task, from: peer, context}); break;
          case 'model': append({kind: 'model', model: String(event.model), provider: profile.adapter, task, from: peer, context}); break;
          case 'native': append({kind: 'peer.native', from: peer, provider: event.provider, sessionId: event.sessionId, context}); break;
          case 'activity': case 'assistant': case 'tool': case 'progress': case 'diagnostic': case 'status':
            publish({kind: 'task.activity', task, text: event.text, from: peer, context}); break;
          case 'error': publish({kind: 'task.activity', task, text: `error: ${event.text}`, from: peer, context}); break;
          case 'delta': break;
          case 'result': resultStatus = event.status; resultText = event.text; break;
        }
      }
    } catch (error) {
      append({kind: 'review.finished', task, stage, round, verdict: 'unreadable', text: error.message, from: peer, context});
      await adapter.cancel(handle).catch(() => {});
      return {verdict: 'unreadable'};
    } finally {
      reviews.delete(peer);
    }
    const verdict = parseVerdict(resultStatus, resultText);
    append({kind: 'review.finished', task, stage, round, verdict: verdict.verdict, text: resultText ?? null, from: peer, context});
    return verdict;
  }

  // Budget failures on a review-bearing path escalate rather than fail the task outright —
  // the orchestrator gets a chance to see policy.escalated{reason:'budget'} and react, the
  // same shape as a rounds or unreadable-review escalation, instead of a bare task.failed.
  function escalateBudget(task, context) {
    append({kind: 'policy.escalated', task, reason: 'budget', text: 'root budget exhausted', context});
    append({kind: 'task.blocked', task, text: 'root budget exhausted', context});
  }

  // CONTRACT.md §1: the read-only helper set every strategy hook receives as its third
  // argument. `roundsCap` is a small addition beyond the literal list in CONTRACT §1 — it is
  // what lets defaultStrategy's onReviewVerdict reproduce today's per-root `budget.rounds`
  // override (P4/policy.test.js) rather than only the scheduler's own `limits.rounds` default;
  // without it the rounds-cap decision cannot be expressed faithfully by a pure hook.
  const api = {
    submittedRow,
    reviewsUsed: id => session.events.filter(e => e.kind === 'review.finished' && e.task === id).length,
    roundsUsed: id => {
      const root = budgetRootOf(id, reducers.tasks(session.events));
      return reducers.budgets(session.events).roots[root]?.reserved?.rounds || 0;
    },
    roundsCap: id => {
      const root = budgetRootOf(id, reducers.tasks(session.events));
      return submittedRow(root)?.budget?.rounds ?? limits.rounds;
    },
    limits,
    sessionEffective,
    budgets: () => reducers.budgets(session.events),
  };

  // Executes an {action:'escalate', reason, text?, findings?} intent exactly the way every
  // escalation was journaled pre-Phase-8: `text`/`findings` are included on policy.escalated
  // only when the intent actually carries them (today's 'review' escalate has text, no
  // findings; 'rounds' has findings, no text) — task.blocked always gets a human string,
  // falling back to a generic one for a reason with no text of its own (a custom strategy's
  // escalate, e.g. 'quorum').
  function applyEscalate(task, intent, context) {
    const row = {kind: 'policy.escalated', task, reason: intent.reason, context};
    if (intent.text !== undefined) row.text = intent.text;
    if (intent.findings !== undefined) row.findings = intent.findings;
    append(row);
    const blockedText = intent.text ?? (intent.reason === 'rounds' ? 'rounds exhausted' : `${intent.reason} escalated`);
    append({kind: 'task.blocked', task, text: blockedText, context});
  }

  // Runs a strategy hook and turns a throw into the fixed invariant every hook shares
  // (CONTRACT §1): a hook that throws never escapes as an unhandled rejection or crashes the
  // scheduler — it fails just this task, reason 'strategy'. Returns {ok:false} on failure so
  // the caller can bail out of its own decision immediately, or {ok:true, intent} otherwise.
  function invokeHook(fn, task, context) {
    try { return {ok: true, intent: fn()}; }
    catch (error) { append({kind: 'task.failed', task, reason: 'strategy', text: error.message, context}); return {ok: false}; }
  }

  // The CORE side of a review round, shared by the prelaunch gate (dispatch) and the
  // completion gate (runCompletionReview) below: launches every reviewer in `reviewers`
  // (sequentially — the CORE runs a multi-reviewer round one at a time, CONTRACT §5, so
  // `reviews` never holds more than one entry per task), collecting one parsed verdict per
  // reviewer. The single-reviewer case (today's only case) is byte-identical to before Phase
  // 8: one dir `review-<stage>-<round>`, one peer `review:<task>`.
  //
  // `reserveFirst: false` means the caller already made the first reviewer's own start
  // reservation before calling in (dispatch's shared review-or-worker reservation, §4);
  // `reserveFirst: true` means this function reserves it too (the completion path, which has
  // no such shared reservation).
  async function runReviewers({task, stage, round, reviewers, row, context, root, reserveFirst}) {
    const verdicts = [];
    for (let i = 0; i < reviewers.length; i++) {
      const profileName = reviewers[i];
      const reviewProfile = profiles[profileName];
      // A review profile is a profile too (CONTRACT.md §3): the same shared check runs before
      // its launch. The first reviewer's refusal handling differs by stage (matches pre-Phase-8
      // behavior exactly): prelaunch (`reserveFirst: false`) releases its already-made shared
      // reservation and fails the task outright; completion (`reserveFirst: true`) has reserved
      // nothing yet at this point and escalates instead. Every reviewer past the first makes
      // (and, on refusal, releases) its own start reservation, regardless of stage.
      const reviewRefusal = policyRefusal(reviewProfile);
      if (i === 0 && !reserveFirst) {
        if (reviewRefusal) {
          append({kind: 'budget.released', task, root, amount: {starts: 1}, text: reviewRefusal.reason, context});
          append({kind: 'task.failed', task, reason: reviewRefusal.reason, text: reviewRefusal.text, context});
          return null;
        }
      } else if (i === 0 && !reviewRefusal) {
        // completion's own first-reviewer reservation (dispatch's prelaunch path already made
        // this one before calling in; this branch only runs when reserveFirst is true).
        if (availableStarts(root) < 1) { escalateBudget(task, context); return null; }
        append({kind: 'budget.reserved', task, root, amount: {starts: 1}, context});
      } else if (i === 0) { // reviewRefusal, reserveFirst true: nothing reserved yet
        append({kind: 'policy.escalated', task, reason: reviewRefusal.reason, text: reviewRefusal.text, context});
        append({kind: 'task.blocked', task, text: reviewRefusal.text, context});
        return null;
      } else {
        // i > 0: always its own fresh reservation, released on refusal (no precedent pre-Phase-8;
        // generalized consistently with the per-reviewer reservation rule of CONTRACT §5).
        if (availableStarts(root) < 1) { escalateBudget(task, context); return null; }
        append({kind: 'budget.reserved', task, root, amount: {starts: 1}, context});
        if (reviewRefusal) {
          append({kind: 'budget.released', task, root, amount: {starts: 1}, text: reviewRefusal.reason, context});
          append({kind: 'policy.escalated', task, reason: reviewRefusal.reason, text: reviewRefusal.text, context});
          append({kind: 'task.blocked', task, text: reviewRefusal.text, context});
          return null;
        }
      }
      const single = reviewers.length === 1;
      const dir = path.join(session.dir, 'tasks', task, single ? `review-${stage}-${round}` : `review-${stage}-${round}-${i}`);
      fs.mkdirSync(dir, {recursive: true, mode: 0o700});
      const peer = single ? reviewFrom(task) : `${reviewFrom(task)}:${i}`;
      const orders = stage === 'completion'
        ? (reviewProfile.role === 'verifier' ? row.steps : `${row.orders}\n\n--- worker report ---\n${reducers.tasks(session.events)[task]?.summary ?? ''}`)
        : row.orders;
      const verdict = await runReview({task, stage, round, profileName, profile: reviewProfile, orders, dir, context, peer});
      if (verdict.launchFailed) append({kind: 'budget.released', task, root, amount: {starts: 1}, text: 'review launch failed', context});
      verdicts.push(verdict);
    }
    return verdicts;
  }

  // Executes an onReviewVerdict intent, shared by the prelaunch and completion callers: only
  // 'accept' behaves differently by stage (prelaunch also launches the worker), everything else
  // is identical. Returns nothing; every branch is terminal for this dispatch/review pass.
  async function applyVerdictIntent(intent, {task, stage, row, round, context, root}) {
    if (intent.action === 'reject') {
      append({kind: 'task.rejected', task, questions: intent.questions ?? [], context});
      return;
    }
    if (intent.action === 'escalate') { applyEscalate(task, intent, context); return; }
    if (intent.action === 'rework') {
      if (stage === 'prelaunch') {
        // No worker has ever launched yet at prelaunch — there is nothing to resume: a
        // strategy asking to rework here is malformed, not a real transition (defaultStrategy
        // never returns this at prelaunch).
        append({kind: 'task.failed', task, reason: 'strategy', text: 'rework at prelaunch is not supported', context});
        return;
      }
      const findings = intent.findings ?? [];
      append({kind: 'budget.reserved', task, root, amount: {rounds: 1}, context});
      append({kind: 'task.rework', task, round, findings, context});
      await resumeWorker({task, row, round, findings, context});
      return;
    }
    // accept
    append({kind: 'task.accepted', task, stage, by: reviewFrom(task), context});
    if (stage === 'prelaunch') {
      if (availableStarts(root) < 1) return escalateBudget(task, context);
      await launchWorker(row);
    }
  }

  const VERDICT_ACTIONS = new Set(['accept', 'reject', 'rework', 'escalate']);

  async function runCompletionReview(task, reviewIntent) {
    const view = reducers.tasks(session.events);
    const t = view[task];
    if (!t || t.state !== 'reviewing') return; // stale trigger (already handled, or never entered review)
    const row = submittedRow(task);
    const context = row.context;
    const root = budgetRootOf(task, view);
    const round = (t.rounds || 0) + 1;
    const reviewers = reviewIntent.reviewers ?? [];
    if (!reviewers.length) {
      append({kind: 'task.failed', task, reason: 'strategy', text: 'review intent named no reviewers', context});
      return;
    }

    const verdicts = await runReviewers({task, stage: 'completion', round, reviewers, row, context, root, reserveFirst: true});
    if (!verdicts) return;
    // Same guard as the prelaunch path: a review that finishes after the task left `reviewing`
    // for an unrelated reason journals its verdict but drives no accept/reject/rework (A3).
    if (reducers.tasks(session.events)[task]?.state !== 'reviewing') return;

    const hook = invokeHook(() => strategy.onReviewVerdict(task, verdicts, reducers.tasks(session.events), api), task, context);
    if (!hook.ok) return;
    if (!hook.intent || typeof hook.intent !== 'object' || !VERDICT_ACTIONS.has(hook.intent.action)) {
      append({kind: 'task.failed', task, reason: 'strategy', text: 'malformed onReviewVerdict intent', context});
      return;
    }
    await applyVerdictIntent(hook.intent, {task, stage: 'completion', row, round, context, root});
  }

  async function dispatch(row) {
    const {task, parent, context} = row;
    // Sizing refusal, first of all: a task over the skill's sizing rule never launches,
    // checked in a fixed field order so the reported field is deterministic.
    // submit() always stores size; the fallback only covers rows journaled directly (legacy/test rows), never a defaulting path.
    const size = row.size ?? {lines: 0, probes: 0, minutes: 0};
    const oversizedField = SIZE_FIELDS.find(field => size[field] > limits[field]);
    if (oversizedField) {
      append({kind: 'task.failed', task, reason: 'size', text: `${oversizedField} ${size[oversizedField]} exceeds limit ${limits[oversizedField]}`, context});
      return;
    }
    const view = reducers.tasks(session.events);
    // Cycle-guarded: only a directly-journaled row (never submit(), which requires a
    // pre-existing parent) can make a task its own ancestor.
    const depthOf = (id, seen = new Set()) => {
      if (seen.has(id)) return 0;
      seen.add(id);
      return view[id]?.parent ? 1 + depthOf(view[id].parent, seen) : 0;
    };
    if (parent != null && 1 + depthOf(parent) > depthCap) {
      append({kind: 'task.failed', task, reason: 'depth', text: `depth exceeds cap ${depthCap}`, context});
      return;
    }
    const profile = profiles[row.profile];
    if (!profile) {
      append({kind: 'task.failed', task, reason: 'error', text: `malformed: profile`, context});
      return;
    }
    {
      const refusal = policyRefusal(profile);
      if (refusal) {
        append({kind: 'task.failed', task, reason: refusal.reason, text: refusal.text, context});
        return;
      }
    }
    // STRATEGY (CONTRACT.md §0/§1): the depends_on hold/fail decision and the prelaunch-review
    // decision both come from onSubmitted now — the CORE only executes the returned intent, it
    // never re-derives the decision itself. `defaultStrategy.onSubmitted` reproduces exactly
    // the depends_on/review logic that lived here before Phase 8.
    const hook = invokeHook(() => strategy.onSubmitted(task, view, api), task, context);
    if (!hook.ok) return;
    const intent = hook.intent;
    if (intent === 'hold') { heldTasks.add(task); return; }
    if (intent && typeof intent === 'object' && intent.action === 'fail') {
      append({kind: 'task.failed', task, reason: intent.reason ?? 'strategy', text: intent.text, context});
      return;
    }
    if (intent && typeof intent === 'object' && intent.action === 'reject') {
      append({kind: 'task.rejected', task, questions: intent.questions ?? [], context});
      return;
    }
    const reviewIntent = (intent && typeof intent === 'object' && intent.action === 'review') ? intent : null;
    if (intent !== 'dispatch' && !reviewIntent) {
      append({kind: 'task.failed', task, reason: 'strategy', text: 'malformed onSubmitted intent', context});
      return;
    }

    const root = budgetRootOf(task, view);
    // A prelaunch-review task treats budget exhaustion as an escalation throughout its path
    // (the review's own start, and — after an accept — the worker's), never a bare
    // task.failed: the review path always reports to the orchestrator, never silently drops.
    const reviewGate = !!reviewIntent;
    if (availableStarts(root) < 1) {
      if (reviewGate) return escalateBudget(task, context);
      append({kind: 'task.failed', task, reason: 'budget', text: 'root budget exhausted', context});
      return;
    }
    // §4: the check above and this reservation are one synchronous span — no `await` sits
    // between them, so two concurrent dispatches on the same root can never both pass the
    // check. This is the review's own start when review-gated, otherwise the worker's; the
    // checkpoint comparison (the first `await` in this function) moves after it, and a baseline
    // refusal releases what it never consumed.
    append({kind: 'budget.reserved', task, root, amount: {starts: 1}, context});

    // A checkpoint on the row means the task was submitted against a specific tree state:
    // never launch a worker against a tree that has since drifted (tests/check are not part
    // of the comparison — only head/status/diff, via sameTree).
    if (row.checkpoint) {
      const current = await takeCheckpoint({cwd: session.cwd, run: checkpointRunner});
      if (!sameTree(row.checkpoint, current)) {
        append({kind: 'budget.released', task, root, amount: {starts: 1}, text: 'baseline refusal', context});
        append({kind: 'task.failed', task, reason: 'baseline', text: 'tree differs from the task checkpoint', context});
        return;
      }
    }

    if (reviewGate) {
      const reviewers = reviewIntent.reviewers ?? [];
      if (!reviewers.length) {
        append({kind: 'budget.released', task, root, amount: {starts: 1}, text: 'malformed strategy review intent', context});
        append({kind: 'task.failed', task, reason: 'strategy', text: 'review intent named no reviewers', context});
        return;
      }
      const verdicts = await runReviewers({task, stage: 'prelaunch', round: 1, reviewers, row, context, root, reserveFirst: false});
      if (!verdicts) return;
      // The review stream can end after the task moved on for an unrelated reason (cancelled
      // mid-review): review.finished is already journaled above with its verdict; drive no
      // further policy on a task that is no longer sitting here waiting on this decision (A3).
      if (reducers.tasks(session.events)[task]?.state !== 'queued') return;

      const verdictHook = invokeHook(() => strategy.onReviewVerdict(task, verdicts, reducers.tasks(session.events), api), task, context);
      if (!verdictHook.ok) return;
      if (!verdictHook.intent || typeof verdictHook.intent !== 'object' || !VERDICT_ACTIONS.has(verdictHook.intent.action)) {
        append({kind: 'task.failed', task, reason: 'strategy', text: 'malformed onReviewVerdict intent', context});
        return;
      }
      await applyVerdictIntent(verdictHook.intent, {task, stage: 'prelaunch', row, round: 1, context, root});
      return;
    }

    // Not review-gated: the reservation above IS the worker's own start — launchWorker must
    // not make a second one for it.
    await launchWorker(row, {reserve: false});
  }

  // The delivery contract made observable: a message addressed to a worker goes through its
  // adapter, and the tier the adapter reports is journaled so the sender knows whether the
  // worker got it live, at its next turn, or only queued. "Live" means both a handle AND a
  // non-terminal state re-derived from the log, as dispatch does: a worker that has already
  // reported its result is not a delivery target even while its stream is still draining.
  // A message that finds no live worker is queued and NOT replayed when a pending launch
  // resolves: it stays in the journal, and picking it up belongs to resume (Phase 4), which
  // reads pending work from the log rather than from memory here. `worker:` is the only
  // deliverable prefix: a `review:` address (read-only, no bus grant) is never matched below.
  async function deliverTo(task, row) {
    const entry = handles.get(task);
    const delivered = (tier, text = null) => append({kind: 'task.delivered', task, tier, message: row.id, text, from: 'bounce', context: row.context});
    if (!entry || reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return delivered('queued', 'no live worker');
    if (typeof row.text !== 'string') return delivered('queued', 'no text');
    let outcome;
    try {
      const tier = await entry.adapter.deliver(entry.handle, {text: row.text});
      outcome = TIERS.has(tier) ? [tier] : ['queued', `adapter reported an unknown tier: ${tier}`];
    } catch (error) { outcome = ['queued', error.message]; }
    delivered(...outcome);
  }

  // One delivery at a time per worker, so both the adapter calls and the journaled rows are
  // FIFO for that task. An adapter may queue internally as well; the scheduler simply never
  // overlaps two deliveries to the same worker.
  const deliveryTails = new Map(); // task -> promise for the last delivery still in flight
  function enqueueDelivery(task, row) {
    const tail = (deliveryTails.get(task) ?? Promise.resolve())
      .then(() => deliverTo(task, row))
      .catch(error => {
        // Only a failed journal write reaches here (deliverTo handles every adapter outcome).
        // If recording that failure also throws, there is nowhere left to report it: swallow.
        try { append({kind: 'task.delivered', task, tier: 'queued', message: row.id, text: error.message, from: 'bounce', context: row.context}); } catch {}
      })
      .finally(() => { if (deliveryTails.get(task) === tail) deliveryTails.delete(task); });
    deliveryTails.set(task, tail);
  }

  // §1/§2: the deadline a running task's watchdog row is measured against — the task's own
  // declared `deadline` (ms from its first task.started), or `limits.minutes * 60000` when
  // `deadline` is null. `deadlineAtFor` needs the task's actual first-start time, so it reads
  // nothing until at least one task.started row exists.
  function taskDeadlineMs(submitted) { return submitted?.deadline ?? (limits.minutes * 60000); }
  function deadlineAtFor(task) {
    const startedRows = session.events.filter(e => e.kind === 'task.started' && e.task === task);
    if (!startedRows.length) return null;
    return Date.parse(startedRows[0].time) + taskDeadlineMs(submittedRow(task));
  }

  // §3: a signature (task, 'silent'|'stalled') resets the moment a NEW progress row lands —
  // this is the same reset rule for both the first escalation and the correction that follows
  // it, computed purely off the log so the ladder never needs its own separate memory.
  function lastProgressResetTime(task) {
    let best = null;
    for (const e of session.events) {
      if (e.task !== task) continue;
      if (e.kind === 'task.milestone' || e.kind === 'task.blocked' || e.kind === 'task.usage') best = Math.max(best ?? -Infinity, Date.parse(e.time));
      // Same exclusion as reducers.watchdog: the watchdog's own corrective delivery is not a
      // reset trigger for the signature it was sent because of.
      else if (e.kind === 'task.delivered' && (e.tier === 'live' || e.tier === 'next-turn')) {
        const message = session.events.find(m => m.kind === 'message' && m.id === e.message);
        if (message?.from !== 'bounce') best = Math.max(best ?? -Infinity, Date.parse(e.time));
      }
    }
    return best;
  }

  // §3 blocked: `to` is informational (delivery to user/orchestrator is Phase 6's job) — the
  // root's own task.submitted `from` says who ultimately owns the decision.
  function rootSubmitterFrom(task) {
    const view = reducers.tasks(session.events);
    let id = task;
    while (view[id]?.parent) id = view[id].parent;
    return submittedRow(id)?.from;
  }

  async function handleBlocked(r) {
    const view = reducers.tasks(session.events);
    const t = view[r.task];
    if (!t) return;
    const blocker = t.blocker;
    const already = session.events.some(e => e.kind === 'policy.escalated' && e.task === r.task && e.reason === 'blocked' && e.text === blocker);
    if (already) return;
    const row = submittedRow(r.task);
    const to = rootSubmitterFrom(r.task) === 'orchestrator' ? 'orchestrator' : 'user';
    append({kind: 'policy.escalated', task: r.task, reason: 'blocked', text: blocker, to, context: row?.context});
  }

  async function handleDeadline(r) {
    const row = submittedRow(r.task);
    const durationMs = r.deadlineAt - r.startedAt;
    append({kind: 'task.deadline', task: r.task, text: `deadline ${durationMs} ms exceeded at ${r.elapsed} ms`, from: 'bounce', context: row?.context});
    await cancel(r.task, {force: true});
  }

  async function handleSignature(r, reason, now) {
    const row = submittedRow(r.task);
    const since = lastProgressResetTime(r.task) ?? -Infinity;
    const signatureRows = session.events.filter(e => e.task === r.task && e.reason === reason && (e.kind === 'policy.escalated' || e.kind === 'policy.corrected') && Date.parse(e.time) > since);
    const escalated = signatureRows.filter(e => e.kind === 'policy.escalated');
    const corrected = signatureRows.filter(e => e.kind === 'policy.corrected');
    const markAt = reason === 'silent' ? r.lastActivityAt : r.lastProgressAt;
    const elapsedSeconds = Math.round((now - markAt) / 1000);
    if (!escalated.length) {
      // F4/A7: the reducer row carries absolute timestamps (lastActivityAt/lastProgressAt);
      // this evidence object is the one place they become elapsed-ms durations, under the
      // duration names.
      append({
        kind: 'policy.escalated', task: r.task, reason, text: `${reason} for ${elapsedSeconds} s`,
        evidence: {elapsed: r.elapsed, sinceActivity: now - r.lastActivityAt, sinceProgress: now - r.lastProgressAt}, context: row?.context,
      });
      return;
    }
    if (!corrected.length) {
      append({kind: 'policy.corrected', task: r.task, reason, text: `${reason} for ${elapsedSeconds} s`, context: row?.context});
      const text = `bounce watchdog: ${reason} for ${elapsedSeconds} s — publish a task.milestone with evidence, or task.blocked with the blocker`;
      append({kind: 'message', to: workerFrom(r.task), from: 'bounce', text, context: row?.context});
      return;
    }
    const correctedAt = Date.parse(corrected.at(-1).time);
    if (now >= correctedAt + watchdogConfig.grace) {
      append({kind: 'policy.escalated', task: r.task, reason: 'cancelled', text: `${reason} persisted through correction and grace`, context: row?.context});
      await cancel(r.task);
    }
  }

  // §1: runs the watchdog policy once against clock(). Deterministic and driven entirely off
  // the log plus the live `activity` map — no hidden state of its own, so calling it twice with
  // the same log/activity/now is idempotent beyond the dedupe rules §3 already specifies.
  async function tick() {
    const now = clock();
    const rows = reducers.watchdog(session.events, now, {activity, watchdog: {...watchdogConfig, defaultDeadlineMs: limits.minutes * 60000}});
    for (const r of rows) {
      if (r.verdicts.includes('blocked')) { await handleBlocked(r); continue; }
      if (r.verdicts.includes('deadline')) { await handleDeadline(r); continue; } // no correction, no grace (§3)
      for (const reason of ['silent', 'stalled']) if (r.verdicts.includes(reason)) await handleSignature(r, reason, now);
    }
  }
  let watchdogInterval = null;
  if (typeof watchdogConfig.interval === 'number' && watchdogConfig.interval > 0) {
    watchdogInterval = setInterval(() => { tick().catch(() => {}); }, watchdogConfig.interval);
    watchdogInterval.unref?.();
  }

  // F2/A5: the live activity map is never journaled and never restored on restart, so it must
  // also never be left to grow forever — prune a task's entry the moment its own row actually
  // lands it in a terminal state (a task.completed into 'reviewing' does not prune; the later
  // task.accepted/rejected/rework path does its own transition and gets checked in turn).
  const TERMINAL_ROW_KINDS = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.deadline', 'task.rejected', 'task.accepted']);
  const unsubscribe = session.subscribe(row => {
    if (row.task && TERMINAL_ROW_KINDS.has(row.kind) && reducers.TERMINAL.has(reducers.tasks(session.events)[row.task]?.state)) activity.delete(row.task);
    if (row.kind === 'task.submitted') {
      // Any throw here (including one from before the first `await`, which an async
      // function turns into a rejection rather than a synchronous throw) must land on the
      // task as its own failure — never disappear, leaving the task queued forever.
      dispatch(row).catch(error => append({kind: 'task.failed', task: row.task, reason: 'error', text: error.message, context: row.context}));
    }
    else if (row.kind === 'task.completed') {
      // STRATEGY (CONTRACT.md §2 onCompleted): a second (and later) task.completed on the same
      // task re-enters review exactly the same way — the hook and runCompletionReview both
      // read state fresh off the log every time.
      handleCompleted(row.task).catch(error => append({kind: 'task.failed', task: row.task, reason: 'error', text: error.message, context: row.context}));
    }
    else if (row.kind === 'task.failed') { maybeFallback(row); handleTerminal(row); }
    else if (row.kind === 'task.accepted' || row.kind === 'task.cancelled' || row.kind === 'task.deadline' || row.kind === 'task.rejected') handleTerminal(row);
    // Messages to `user`/`orchestrator`/anyone else — and a malformed empty worker
    // address — are not this subscriber's business.
    else if (row.kind === 'message' && typeof row.to === 'string' && row.to.startsWith('worker:') && row.to.length > 'worker:'.length) enqueueDelivery(row.to.slice('worker:'.length), row);
    // task.activity is a LIVE_KIND (never journaled): the only way the watchdog ever learns
    // about it is right here, off the same subscriber every other peer-published row reaches.
    // An integer `expect` declares a bounded slow step; §2 caps it at the task's own deadline
    // so a declared step can never itself grant an infinite reprieve.
    else if (row.kind === 'task.activity' && row.task) {
      const at = Date.parse(row.time);
      const prev = activity.get(row.task);
      let expectUntil = prev?.expectUntil ?? null;
      if (Number.isInteger(row.expect) && row.expect > 0) {
        const dAt = deadlineAtFor(row.task);
        expectUntil = dAt != null ? Math.min(at + row.expect, dAt) : at + row.expect;
      }
      activity.set(row.task, {at, expectUntil});
    }
  });

  // Reconcile: every task the reducer reports mid-flight has no live handle right after a
  // restart (all of them, at construction) — mark it blocked rather than assume it's alive.
  const initialView = reducers.tasks(session.events);
  for (const t of Object.values(initialView)) if ((t.state === 'running' || t.state === 'waiting') && !handles.has(t.id))
    append({kind: 'task.blocked', task: t.id, text: 'interrupted: no live handle after restart'});

  // Cycle-guarded for the same reason as the root-walkers above.
  const postOrder = (view, id, seen = new Set()) => {
    if (seen.has(id)) return [];
    seen.add(id);
    return [...(view[id]?.children ?? []).flatMap(child => postOrder(view, child, seen)), id];
  };

  async function cancelOne(id, view) {
    // A review handle (A3) is cancelled before the worker's — a task can only have one of the
    // two live at a time (review during queued/reviewing, worker otherwise: the CORE runs a
    // multi-reviewer round one reviewer at a time, CONTRACT §5, so at most one entry per task
    // is ever in `reviews`), and a review that reports unverified blocks the task exactly like
    // an unverified worker termination.
    const reviewFound = [...reviews.entries()].find(([, entry]) => entry.task === id);
    if (reviewFound) {
      const [peer, reviewEntry] = reviewFound;
      const reviewResult = await reviewEntry.adapter.cancel(reviewEntry.handle);
      if (reviewResult.verified === false) {
        append({kind: 'task.blocked', task: id, text: 'termination unverified', from: peer, context: view[id].context});
        return false;
      }
    }
    const entry = handles.get(id);
    const result = entry ? await entry.adapter.cancel(entry.handle) : {verified: true};
    if (result.verified === false) {
      append({kind: 'task.blocked', task: id, text: 'termination unverified', from: workerFrom(id), context: view[id].context});
      return false;
    }
    append({kind: 'task.cancelled', task: id, from: workerFrom(id), context: view[id].context});
    return true;
  }

  // `force` only ever applies to `taskId` itself, never its descendants: the watchdog's deadline
  // handler journals `task.deadline` (state -> `timed_out`, terminal) THEN cancels — the process
  // is still live and must actually be torn down, so this one caller needs to reach a task the
  // ordinary terminal-skip below would otherwise treat as already handled.
  async function cancel(taskId, {force = false} = {}) {
    const view = reducers.tasks(session.events);
    if (!view[taskId]) return {verified: true}; // nothing was ever submitted under this id: nothing to cancel
    let verified = true;
    for (const id of postOrder(view, taskId)) {
      if (reducers.TERMINAL.has(view[id]?.state) && !(force && id === taskId)) continue;
      if (!(await cancelOne(id, view))) verified = false;
    }
    return {verified};
  }

  async function stop() {
    const view = reducers.tasks(session.events);
    const roots = Object.values(view).filter(t => !t.parent && !reducers.TERMINAL.has(t.state));
    const cancelled = [], unverified = [];
    for (const root of roots) for (const id of postOrder(view, root.id)) {
      if (reducers.TERMINAL.has(view[id]?.state)) continue;
      (await cancelOne(id, view) ? cancelled : unverified).push(id);
    }
    return {cancelled, unverified};
  }

  return {
    // The submit predicate, exposed so the bus refuses a malformed task.submitted before it is journaled.
    validate: spec => validate(spec, reducers.tasks(session.events)),
    submit, cancel, stop, tick,
    tasks: () => reducers.tasks(session.events),
    budgets: () => reducers.budgets(session.events),
    spend: () => reducers.spend(session.events),
    // Test-only observable for the live activity map's size (F2/A5) — never used by production code.
    _activitySize: () => activity.size,
    close: () => { unsubscribe(); if (watchdogInterval) clearInterval(watchdogInterval); },
  };
}
