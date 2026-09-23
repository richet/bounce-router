import {LOCAL_ADAPTERS} from './profiles.js';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {handoff} from './core.js';
import {failedAttempts} from './loop-guard.js';
import {imagePaths, saveImages, providerInput} from './images.js';
import {cooldowns, tasks, TERMINAL} from './reducers.js';

// The rows that end a task for the orchestrator's purposes (mirrors bus.js's TASK_TERMINAL).
// `blocked` and `input_required` are here because a parked task is news, not a resting state: its worker
// has exited, so no later row will change it, no watchdog covers it (reducers.js skips both) and no parent
// settles on it. Found live in three sessions — 40 minutes, 89 minutes, and one that simply ran out of
// journal — each ended only by the user cancelling. The row itself carries the question that was waiting.
const HANDOFF_KINDS = new Set(['task.completed', 'task.accepted', 'task.failed', 'task.cancelled', 'task.deadline', 'task.rejected',
  'task.blocked', 'task.input_required']);
const PARKED = new Set(['blocked', 'input_required']);
const HANDOFF_TEXT_MAX = 2000; // per task: a final report summary or failure text, never a transcript
const HANDOFF_DELAY_MS = 1000; // several tasks ending together become one wake-up turn
const DEAD_END_PROMPT = 'Your last turn dispatched nothing and nothing of yours is running, so no outcome can arrive and bounce cannot wake you again. Check whether a submission of yours was refused (the refusal says why), then either dispatch the work or tell the user plainly what is blocking it and what you need. Do not end this turn expecting an outcome that nothing will produce.';
const WAKE_PROMPT = 'Continue your orders. The worker outcomes above were not returned by any wait of yours and have not been reported to the user: synthesize them now (what each task produced, what failed and why, what remains). If a task you still need is listed as running, wait on it with `bounce wait` before reporting. Do not re-run finished work.';

// A task is the orchestrator's when the root of its `replaces` lineage was submitted by the
// orchestrator peer: a fallback replacement is journaled by the scheduler (`from: bounce`), yet
// it is the same work the orchestrator asked for and is what its `wait` follows.
function orchestratorsTask(session, view, id) {
  const seen = new Set();
  while (view[id]?.replaces && view[view[id].replaces] && !seen.has(id)) { seen.add(id); id = view[id].replaces; }
  return session.events.find(e => e.kind === 'task.submitted' && e.task === id)?.from === 'orchestrator';
}
const replaced = (session, id) => session.events.some(e => e.kind === 'task.submitted' && e.replaces === id && e.task !== id);

// A child's outcome travels up only while an ancestor is still alive to carry it. Found live: the
// orchestrator named an already-accepted task as the parent, so the chain was terminal on arrival and two
// finished tasks woke nobody. Cycle-guarded, like the replaces walk above it.
function carriedByAncestor(view, id) {
  const seen = new Set();
  let parent = view[id]?.parent;
  while (parent && view[parent] && !seen.has(parent)) {
    if (!TERMINAL.has(view[parent].state)) return true;
    seen.add(parent);
    parent = view[parent].parent;
  }
  return false;
}

// The wake-up block: one entry per task whose end the orchestrator has not been handed, with
// the terminal row's outcome — the final report summary (task.reported, folded by the scheduler
// into task.completed's `summary`) or the failure text — and the roots still running.
export function handoffBlock(session, ended) {
  const view = tasks(session.events);
  const running = Object.values(view).filter(t => !t.parent && !TERMINAL.has(t.state) && orchestratorsTask(session, view, t.id));
  const lines = ['Worker outcomes not yet handed to you (delivered by bounce, not typed by the user):'];
  for (const row of ended) {
    const t = view[row.task] ?? {};
    const outcome = row.summary ?? row.text ?? (Array.isArray(row.questions) && row.questions.length ? row.questions.join('; ') : null) ?? t.summary ?? t.error ?? '';
    lines.push(`- task ${row.task} · profile ${t.profile ?? '?'} · ${row.kind}${row.reason ? ` · reason: ${row.reason}` : ''}${t.replaces ? ` · replaces ${t.replaces}` : ''}`);
    if (outcome) lines.push(`  ${String(outcome).slice(0, HANDOFF_TEXT_MAX).replace(/\n/g, '\n  ')}`);
    // You see one outcome at a time; bounce sees the pattern. Found live: ten identical reviewer tasks,
    // each killed at its ceiling and resubmitted, because no single handoff showed the repetition.
    const submitted = session.events.find(e => e.kind === 'task.submitted' && e.task === row.task);
    const earlier = submitted ? failedAttempts(session.events.filter(e => e.task !== row.task), submitted) : [];
    if (earlier.length) lines.push(`  this job has now failed ${earlier.length + 1} times the same way (${[...earlier.map(a => a.reason), row.reason ?? row.kind].join(', ')}): change the scope or the AI before asking again — bounce refuses a third identical attempt.`);
  }
  lines.push(running.length ? `Still running: ${running.map(t => `${t.id} (${t.profile}, ${t.state})`).join(', ')}` : 'No other task of yours is still running.');
  return lines.join('\n');
}

export function createMainService({session, adapters, profile, settings, profiles = {}, readRouting = () => settings, orchestratorEnv = {}, brief = '', handoffDelayMs = HANDOFF_DELAY_MS}) {
  const listeners = new Set(), native = new Map();
  for (const event of session.events) {
    if (event.kind === 'peer.native' && event.from === 'main') native.set(event.provider, {provider: event.provider, sessionId: event.sessionId});
  }
  // Profile fallback is daemon-owned; the view may change legacy order/models between turns.
  function fallbackRoutes(routing) {
    const explicit = Object.hasOwn(settings.profiles?.[settings.orchestrator] ?? {}, 'fallback');
    const routes = [], seen = new Set();
    function add(name) {
      if (seen.has(name)) return;
      seen.add(name);
      const candidate = profiles[name];
      if (!candidate || LOCAL_ADAPTERS.has(candidate.adapter)) return;
      routes.push({...candidate, model: candidate.model || routing.models?.[candidate.adapter] || ''});
      for (const next of candidate.fallback ?? []) add(next);
    }
    if (explicit) for (const name of profile.fallback ?? []) add(name);
    else for (const provider of routing.order ?? []) {
      if (!LOCAL_ADAPTERS.has(provider)) routes.push({...profile, adapter: provider, model: routing.models?.[provider] ?? ''});
    }
    return routes;
  }
  let selection = session.events.findLast(e => e.kind === 'route' && e.from === 'main') ??
    {provider: profile.adapter, model: profile.model || settings.models?.[profile.adapter] || '', mode: profile.mode, policy: profile.policy};
  session.active = selection.provider;
  let current = null, closed = false;
  const previousState = session.events.findLast(event => ['main.starting', 'main.started', 'main.terminal', 'main.blocked'].includes(event.kind));
  if (previousState && previousState.kind !== 'main.terminal') {
    current = {id: previousState.requestId, turnId: previousState.turnId, unverified: true, orphaned: true};
    session.append({kind: 'main.blocked', from: 'main', requestId: current.id, turnId: current.turnId, state: 'blocked', reason: 'orphaned', text: 'Termination unverified after daemon restart; inspect the previous orchestrator process before continuing'});
  }
  const state = () => ({state: current?.unverified ? 'blocked' : current ? current.handle ? 'running' : 'starting' : 'idle',
    provider: selection.provider, model: selection.model, mode: selection.mode, policy: selection.policy, currentTurnId: current?.turnId ?? null, requestId: current?.id ?? null});
  function emit(event) {
    const row = session.append({...event, from: 'main', context: session.id});
    for (const listener of listeners) listener(row);
  }
  function finish(run, status, reason) {
    if (run.finished) return;
    run.finished = true;
    if (current === run) current = null;
    session.append({kind: 'turn', provider: run.provider, text: status === 'interrupted' ? 'cancelled' : status, status: status === 'interrupted' ? 'cancelled' : status});
    emit({kind: 'main.terminal', requestId: run.id, turnId: run.turnId, state: 'idle', status, ...(reason ? {reason, text: reason} : {})});
    // A turn that never launched (the orchestrator's own vendor limited or missing) told the
    // orchestrator nothing: its outcomes are still pending. A wake-up gets one more attempt
    // after the usual delay, then they ride on the next prompt rather than a retry loop.
    if (!run.started) {
      if (!run.wake) return;
      if (status === 'failed' && !wakeRetried) { wakeRetried = true; arm(); return; }
      session.append({kind: 'status', text: `Worker outcomes not handed to the orchestrator: ${reason ?? status}; they ride on the next prompt`});
      return;
    }
    // Whatever ended during the turn without being returned by one of its waits wakes it now.
    if (pendingHandoffs().length) { arm(); return; }
    // A turn that ends with nothing running and no outcome owed is a dead end: no row will ever arrive,
    // so no wake can ever fire. Found live: a turn ended saying bounce would "resume the campaign with the
    // verdict" after its only submit had been refused. The user is told in their own transcript, and the
    // orchestrator is woken once to see it — once, never a loop: a wake that itself dispatches nothing
    // ends here quietly, because by then the orchestrator has been told and it is the user's move.
    if (!run.wake && !anythingRunning() && planAwaitingDispatch()) {
      session.append({kind: 'status', text: 'That turn dispatched nothing and nothing is running, so no outcome can arrive. Waking the orchestrator once to look; after that it is your move.'});
      deadEndNudge = true;
      arm();
    }
  }
  async function execute(run, params) {
    const tried = new Set();
    const candidates = [run.selected, ...run.routes];
    for (const candidate of candidates) {
      if (run.cancelled || closed || run.finished) { finish(run, 'interrupted'); return; }
      const provider = candidate.adapter;
      if (tried.has(provider) || !adapters[provider]) continue;
      tried.add(provider);
      if (cooldowns(session.events, Date.now())[provider] > Date.now()) continue;
      run.provider = provider;
      run.selected = {...profile, ...candidate, role: 'orchestrator',
        policy: run.selected.policy === 'read-only' || profile.policy === 'read-only' ? 'read-only' : candidate.policy,
        mode: run.selected.mode === 'plan' || params.mode === 'plan' || profile.mode === 'plan' || candidate.mode === 'plan' ? 'plan' : 'yolo'};
      run.handle = null;
      run.turnId = null;
      selection = {provider, model: run.selected.model ?? '', mode: run.selected.mode, policy: run.selected.policy};
      session.active = provider;
      session.append({kind: 'route', from: 'main', ...selection, text: `Orchestrator selected ${provider}`});
      emit({kind: 'main.starting', ...selection, requestId: run.id, turnId: null, state: 'starting', ...(run.wake ? {handoff: true} : {})});
      const result = await attempt(run, params);
      if (run.unverified || run.finished) return;
      if (run.cancelled || closed) { finish(run, 'interrupted'); return; }
      if (!['limited', 'missing'].includes(result)) return;
      run.previousProvider = provider;
      if (result === 'limited') session.append({kind: 'cooldown', provider,
        until: Date.now() + (settings.cooldownMinutes ?? 30) * 60000,
        text: 'Main provider quota exhausted; trying the next eligible provider.'});
    }
    finish(run, run.cancelled || closed ? 'interrupted' : 'unavailable', 'No main provider available. Check fallback configuration or clear local cooldowns with /retry.');
  }
  async function attempt(run, params) {
    const adapter = adapters[run.provider];
    const dir = path.join(session.dir, 'orchestrator', run.provider);
    const selectedProfile = {...run.selected, executables: settings.executables ?? {}, orchestratorEnv};
    let result;
    try {
      fs.mkdirSync(dir, {recursive: true, mode: 0o700});
      const previous = native.get(run.provider);
      const options = {peer: 'orchestrator', profile: selectedProfile, cwd: session.cwd, dir, userImages: run.images};
      const roster = session.events.findLast(event => event.kind === 'local.profiles.activated')?.text;
      const text0 = run.outcomes ? `${run.outcomes}\n\n${params.text}` : params.text;
      const prompt = [brief, roster, previous && run.previousProvider === run.provider ? text0 : handoff(session, text0, settings.contextChars)].filter(Boolean).join('\n');
      const text = providerInput(run.provider, prompt, run.images);
      run.handle = previous && adapter.resume
        ? await adapter.resume({...options, native: previous, message: text})
        : await adapter.launch({...options, orders: text});
      if (run.cancelled || closed) {
        const stopped = await adapter.cancel(run.handle);
        if (!stopped?.verified) throw new Error('Main provider termination unverified');
        finish(run, 'interrupted'); return;
      }
      run.turnId = run.handle.turnId ?? run.id;
      run.started = true;
      wakeRetried = false;
      emit({kind: 'main.started', requestId: run.id, turnId: run.turnId, state: 'running'});
      for await (const event of adapter.events(run.handle)) {
        if (event.kind === 'native') {
          native.set(run.provider, {provider: run.provider, sessionId: event.sessionId});
          session.append({kind: 'peer.native', provider: run.provider, sessionId: event.sessionId, from: 'main', context: session.id});
          continue;
        }
        if (event.kind === 'result') { result = event; break; }
        if (event.kind === 'error' && event.code === 'missing') result = {status: 'missing', text: event.text};
        const row = {...event, provider: run.provider, from: 'main', context: session.id};
        if (['delta', 'progress', 'activity'].includes(event.kind)) session.publish(row);
        else session.append(row);
      }
      // A terminal message ends the model turn, but the process must also stop before a new
      // writer is admitted. Native identity survives separately for the next turn's resume.
      const stopped = await adapter.cancel(run.handle);
      if (!stopped?.verified) throw new Error('Main provider termination unverified');
      run.handle = null;
      if (run.finished) return;
      const status = run.cancelled || closed ? 'interrupted' : result?.status;
      if (['limited', 'missing'].includes(status)) return status;
      finish(run, ['completed', 'failed', 'limited', 'interrupted'].includes(status) ? status : 'failed',
        result ? result.text : 'Provider exited without a terminal result');
    } catch (error) {
      run.handle ??= error.handle;
      if (error.code === 'limited' && !run.handle) {
        run.unverified = true;
        emit({kind: 'main.blocked', requestId: run.id, turnId: run.turnId, state: 'blocked', text: 'Main launch termination unverified: no process handle returned'});
        return;
      }
      if (run.handle) {
        const stopped = await adapter.cancel(run.handle).catch(() => ({verified: false}));
        if (!stopped?.verified) {
          run.unverified = true;
          emit({kind: 'main.blocked', requestId: run.id, turnId: run.turnId, state: 'blocked', text: 'Main provider termination unverified'});
          return;
        }
      }
      run.handle = null;
      if (!run.cancelled && !closed && !run.finished && ['missing', 'limited'].includes(error.code)) return error.code;
      finish(run, run.cancelled || closed ? 'interrupted' : 'failed', error.message);
    }
  }
  // Root tasks the orchestrator submitted that reached a terminal state and were never handed
  // to it: "seen" means a `bounce wait` under the orchestrator's grant returned that terminal
  // row (the bus journals `wait.served` for it), or a handoff block carried it into a turn that
  // really began (main.started for the block's requestId). Ending while a turn was running is
  // not seeing: an orchestrator that finishes its turn without waiting still gets the outcome.
  // A later terminal row the orchestrator or the user published by hand on a task a wait had
  // already returned (a `task.accepted` after the wait's task.completed) is not news either:
  // it acts on the outcome the wait handed over. Hand-closing a task no wait ever returned
  // still wakes. Log-derived, so a daemon restart changes nothing; one entry per task, its
  // last terminal row. A failure the scheduler has already replaced (policy.fallback) is not
  // an outcome yet: its replacement's end is.
  function pendingHandoffs() {
    const view = tasks(session.events);
    // Delivered means the wake turn REPORTED, not that it started: a wake that was interrupted, or that
    // returned nothing, told the orchestrator nothing and its outcomes are still owed.
    const finished = new Set(session.events.filter(event => event.kind === 'main.terminal' && event.status === 'completed').map(event => event.requestId));
    const started = new Set(session.events.filter(event => event.kind === 'main.started' && finished.has(event.requestId)).map(event => event.requestId));
    const byHand = row => row.from === 'orchestrator' || row.from === 'user';
    const seen = row => session.events.some(e => (e.kind === 'wait.served' && e.task === row.task && (!(e.served < row.seq) || byHand(row)))
      || (e.kind === 'handoff' && started.has(e.requestId) && e.seq > row.seq && e.tasks?.includes(row.task)));
    const byTask = new Map();
    for (const row of session.events) {
      if (!HANDOFF_KINDS.has(row.kind)) continue;
      const t = view[row.task];
      if (!t || carriedByAncestor(view, row.task) || !(TERMINAL.has(t.state) || PARKED.has(t.state)) || replaced(session, row.task) || !orchestratorsTask(session, view, row.task)) continue;
      byTask.set(row.task, row);
    }
    return [...byTask.values()].filter(row => !seen(row));
  }
  // A plan bounce accepted, with nothing dispatched since. That is the shape of the dead end worth
  // acting on: the orchestrator got its go-ahead and then ended the turn without submitting a chunk —
  // usually because a submit was refused. An ordinary turn that dispatches nothing (a question answered,
  // a campaign finished) is not this, and must not be nudged.
  function planAwaitingDispatch() {
    const accepted = session.events.findLast(row => row.kind === 'plan.accepted');
    if (!accepted) return false;
    const dispatched = session.events.findLast(row => row.kind === 'task.submitted');
    return !dispatched || dispatched.seq < accepted.seq;
  }
  // Any task of the orchestrator's that could still produce an outcome.
  function anythingRunning() {
    const view = tasks(session.events);
    return Object.values(view).some(t => !TERMINAL.has(t.state) && orchestratorsTask(session, view, t.id));
  }
  function start(params, {wake}) {
    if (closed) return {accepted: false, reason: 'daemon_closed'};
    if (current) return {accepted: false, reason: current.unverified ? 'termination_unverified' : 'busy'};
    if (Object.values(tasks(session.events)).some(t => t.state === 'blocked' && session.events.findLast(e => e.task === t.id && e.kind === 'task.blocked')?.reason === 'orphaned')) return {accepted: false, reason: 'termination_unverified'};
    if (typeof params?.text !== 'string' || !params.text.trim()) return {accepted: false, reason: 'empty_prompt'};
    if (params.files !== undefined && (!Array.isArray(params.files) || params.files.some(file => typeof file !== 'string'))) return {accepted: false, reason: 'invalid_attachments'};
    if (params.mode !== undefined && !['yolo', 'plan'].includes(params.mode)) return {accepted: false, reason: 'invalid_mode'};
    if (params.typed !== undefined && (typeof params.typed !== 'string' || !params.typed.startsWith('/'))) return {accepted: false, reason: 'invalid_typed'};
    if (params.routing !== undefined && (!params.routing || !Array.isArray(params.routing.order)
      || params.routing.order.some(p => !['claude', 'codex', 'muse'].includes(p))
      || !params.routing.models || typeof params.routing.models !== 'object'
      || Object.values(params.routing.models).some(m => typeof m !== 'string'))) return {accepted: false, reason: 'invalid_routing'};
    const provider = params.provider ?? selection.provider;
    if (LOCAL_ADAPTERS.has(provider) || !adapters[provider]) return {accepted: false, reason: 'unknown_provider'};
    let images;
    try { images = saveImages([...new Set([...(params.files ?? []), ...imagePaths(params.text, session.cwd)])], session); }
    catch (error) { return {accepted: false, reason: error.message}; }
    let routes;
    try { routes = fallbackRoutes(params.routing ?? readRouting()); }
    catch (error) { return {accepted: false, reason: error.message}; }
    const selected = {...profile, ...(provider === selection.provider ? {mode: selection.mode ?? profile.mode, policy: selection.policy ?? profile.policy} : {}), adapter: provider, model: params.model ??
      (provider === selection.provider ? selection.model : settings.models?.[provider] ?? '')};
    const run = {id: params.id ?? randomUUID(), provider, selected, routes, images, wake,
      previousProvider: session.events.findLast(event => event.kind === 'main.starting')?.provider,
      handle: null, turnId: null, cancelled: false, finished: false, started: false};
    // Outcomes are journaled here, synchronously with the prompt row, and the very same text
    // is what execute() prepends — the log and the prompt can never disagree about what the
    // orchestrator was told. A typed prompt carries them too (`wake: false`): the user's own
    // turn is never raced by a synthetic one. The block counts as delivered only once this
    // requestId reaches main.started; a launch that fails leaves the outcomes pending.
    const ended = pendingHandoffs();
    if (ended.length) {
      run.outcomes = handoffBlock(session, ended);
      session.append({kind: 'handoff', wake, requestId: run.id, tasks: ended.map(row => row.task), text: wake ? `${run.outcomes}\n\n${params.text}` : run.outcomes, from: 'bounce'});
    }
    current = run;
    session.active = provider;
    if (!wake) session.append({kind: 'user', text: params.text, ...(params.typed ? {typed: params.typed} : {}), ...(images.length ? {images} : {})});
    run.done = Promise.resolve().then(() => execute(run, {...params}));
    return {accepted: true, requestId: run.id, state: 'started'};
  }
  // Wake-up on a terminal row: the daemon owns the main agent, so when it is idle and a task it
  // submitted ends, the daemon starts the next turn itself — the user never has to ask "what
  // happened?". Coalesced over a short window; a user prompt that lands first wins (start()
  // gives it the same block) and the timer finds nothing left to do. Classic mode never
  // constructs this service (reload.js), so nothing here can fire outside orchestrator mode.
  let wakeTimer = null, wakeRetried = false, deadEndNudge = false;
  function wake() {
    wakeTimer = null;
    if (closed || current) return;
    const ended = pendingHandoffs();
    if (!ended.length && !deadEndNudge) return;
    const nudging = !ended.length && deadEndNudge;
    deadEndNudge = false;
    const result = start({text: nudging ? DEAD_END_PROMPT : WAKE_PROMPT}, {wake: true});
    if (!result.accepted && result.reason !== 'busy') session.append({kind: 'status', text: `Worker outcomes not handed to the orchestrator: ${result.reason}; they ride on the next prompt`});
  }
  // The timer is ref'd on purpose: a pending wake-up is work the daemon owes, not something to
  // drop if the loop happens to empty (Node 22 does exactly that; an unref'd timer stranded the
  // outcomes). It cannot outlive the daemon — close() clears it before the bus goes down.
  function arm() {
    if (closed || current || wakeTimer) return;
    wakeTimer = setTimeout(wake, handoffDelayMs);
  }
  const unsubscribeHandoff = session.subscribe(row => {
    if (!HANDOFF_KINDS.has(row.kind) || closed || current || wakeTimer) return;
    if (pendingHandoffs().some(ended => ended.task === row.task)) arm();
  });
  const service = {
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    run(params) { return start(params, {wake: false}); },
    async deliver({id = randomUUID(), text, expectedTurnId}) {
      const run = current;
      if (!run?.handle || run.finished || run.cancelled) return {state: 'failed', reason: 'no_active_turn'};
      if (expectedTurnId !== run.turnId) return {state: 'failed', reason: 'turn_changed'};
      if (typeof text !== 'string' || !text.trim()) return {state: 'failed', reason: 'empty_message'};
      emit({kind: 'main.delivery', messageId: id, requestId: run.id, turnId: run.turnId, state: 'accepted'});
      try {
        const tier = await adapters[run.provider].deliver(run.handle, {text, expectedTurnId: run.handle.turnId ?? run.turnId});
        const result = {messageId: id, turnId: run.turnId, state: tier === 'live' ? 'acknowledged' : tier === 'queued' || tier === 'next-turn' ? 'queued' : 'failed', tier};
        emit({kind: 'main.delivery', requestId: run.id, ...result});
        return result;
      } catch (error) {
        const result = {messageId: id, turnId: run.turnId, state: 'failed', reason: error.message};
        emit({kind: 'main.delivery', requestId: run.id, ...result}); return result;
      }
    },
    async cancel({id} = {}) {
      const run = current;
      if (!run) return {accepted: true, verified: true};
      if (run.orphaned) return {accepted: false, verified: false, reason: 'termination_unverified'};
      if (id && id !== run.id) return {accepted: false, reason: 'turn_changed'};
      run.cancelled = true;
      if (!run.handle) return {accepted: true, state: 'cancelling'};
      const stopped = await adapters[run.provider].cancel(run.handle);
      if (stopped?.verified) finish(run, 'interrupted');
      else { run.unverified = true; emit({kind: 'main.blocked', requestId: run.id, state: 'blocked', text: 'Main provider termination unverified'}); }
      return {accepted: true, ...stopped};
    },
    async close() {
      closed = true;
      unsubscribeRoster();
      unsubscribeHandoff();
      if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
      const run = current;
      if (!run) return {verified: true};
      if (run.orphaned) return {verified: false};
      run.cancelled = true;
      if (run.handle) {
        const stopped = await adapters[run.provider].cancel(run.handle).catch(() => ({verified: false}));
        if (stopped?.verified !== true) return {verified: false};
      }
      await run.done;
      return {verified: !run.unverified};
    },
  };
  const unsubscribeRoster = session.subscribe(row => {
    if (row.kind !== 'local.profiles.activated' || !current?.handle || current.cancelled) return;
    void service.deliver({text: row.text, expectedTurnId: current.turnId}).then(result => {
      session.append({kind: 'status', text: `Worker roster notification: ${result.state}; available in the next orchestrator prompt regardless of live-delivery support`});
    });
  });
  return service;
}
