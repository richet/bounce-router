import {candidateResult, isReviewGate} from './task-result.js';
import {LOCAL_ADAPTERS} from './profiles.js';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
import {handoff} from './core.js';
import {failedAttempts} from './loop-guard.js';
import {imagePaths, saveImages, providerInput} from './images.js';
import {cooldowns, tasks, TERMINAL} from './reducers.js';
import {rosterLines} from './workers.js';
import {
  OUTCOME_KINDS,
  actionSetKey,
  blockedActionSet,
  pendingMainActions,
  taskDispositionEvidence,
  wakeAttempts,
} from './continuations.js';

// The rows that end a task for the orchestrator's purposes (mirrors bus.js's TASK_TERMINAL).
// `blocked` and `input_required` are here because a parked task is news, not a resting state: its worker
// has exited, so no later row will change it, no watchdog covers it (reducers.js skips both) and no parent
// settles on it. Found live in three sessions — 40 minutes, 89 minutes, and one that simply ran out of
// journal — each ended only by the user cancelling. The row itself carries the question that was waiting.
const HANDOFF_KINDS = OUTCOME_KINDS;
const HANDOFF_TEXT_MAX = 2000; // per task: a final report summary or failure text, never a transcript
// The worker's answer goes with it whole: found live (ACE e3bd01d5), the orchestrator asked for the full
// answer after 41 of 43 handoffs. Answers were 1,140 characters at the median and 10,588 at most.
const HANDOFF_ANSWER_MAX = 12000;
// How long after a vendor refuses a typed message bounce tries it once more.
const TYPED_RETRY_MS = 3000;
const HANDOFF_DELAY_MS = 1000; // several tasks ending together become one wake-up turn
// The quiet sweep (docs/plans/lessons-and-sweep.md §2): nothing in flight, held work waiting, and no row
// for sweepMs — the orchestrator is asked once what is waiting on it. Found live (ACE e3bd01d5,
// 2026-09-30): two held tasks waited 91 minutes with nothing running and nobody noticing.
const SWEEP_MINUTES = 20;
const SWEEP_PROMPT = 'Decide what is waiting on you: accept it (task.accepted with what you checked), send it back (task.rework with what to fix), or retry it on another AI (retryOf) — or say that nothing is, and end your turn.';
const WAKE_PROMPT = 'Continue your orders. Resolve the pending outcomes and decisions above: schedule the successor, name the event being awaited, finish the authorized scope, or report a concrete blocker. If a task you still need is listed as running, wait on it with `bounce wait` before reporting. Do not re-run finished work.';

// A task is the orchestrator's when the root of its `replaces` lineage was submitted by the
// orchestrator peer: a fallback replacement is journaled by the scheduler (`from: bounce`), yet
// it is the same work the orchestrator asked for and is what its `wait` follows.
function orchestratorsTask(session, view, id) {
  const seen = new Set();
  while (view[id]?.replaces && view[view[id].replaces] && !seen.has(id)) { seen.add(id); id = view[id].replaces; }
  return session.events.find(e => e.kind === 'task.submitted' && e.task === id)?.from === 'orchestrator';
}
// The wake-up block: one entry per task whose end the orchestrator has not been handed, with
// the terminal row's outcome — the final report summary (task.reported, folded by the scheduler
// into task.completed's `summary`) or the failure text — and the roots still running.
export function handoffBlock(session, ended) {
  const view = tasks(session.events);
  const running = Object.values(view).filter(t => !t.parent && !TERMINAL.has(t.state) && !['blocked', 'input_required'].includes(t.state) && orchestratorsTask(session, view, t.id));
  const lines = ['Worker outcomes not yet handed to you (delivered by bounce, not typed by the user):'];
  for (const row of ended) {
    const t = view[row.task] ?? {};
    const candidate = candidateResult(session.events, row.task);
    const reviewBlocked = row.kind === 'review.blocked' || isReviewGate(row);
    const gate = session.events.findLast(event => event.task === row.task && event.kind === 'review.blocked') ?? (reviewBlocked ? row : null);
    const outcome = reviewBlocked && candidate ? candidate.summary
      : row.summary ?? row.text ?? (Array.isArray(row.questions) && row.questions.length ? row.questions.join('; ') : null) ?? t.summary ?? t.error ?? '';
    lines.push(`- task ${row.task} · profile ${t.profile ?? '?'} · ${row.kind}${row.reason ? ` · reason: ${row.reason}` : ''}${t.replaces ? ` · replaces ${t.replaces}` : ''}`);
    if (outcome) lines.push(`  ${String(outcome).slice(0, HANDOFF_TEXT_MAX).replace(/\n/g, '\n  ')}`);
    const reported = ['task.completed', 'task.accepted', 'task.blocked', 'task.failed'].includes(row.kind)
      ? session.events.findLast(event => event.kind === 'task.reported' && event.task === row.task) : null;
    const answer = String(reported?.text ?? '').trim();
    if (answer && answer !== String(outcome).trim()) {
      const shown = answer.length > HANDOFF_ANSWER_MAX
        ? `${answer.slice(0, HANDOFF_ANSWER_MAX)}\n[… ${answer.length - HANDOFF_ANSWER_MAX} more characters: task_get with full: true]` : answer;
      lines.push('  answer, in the worker\'s words:', `    ${shown.replace(/\n/g, '\n    ')}`);
    }
    // A task.accepted row may carry advice from an unsure Jev review (src/strategy.js jevAdvice):
    // read it before building on the accepted work, not just its summary.
    if (row.kind === 'task.accepted' && row.advice) lines.push(`  advice: ${String(row.advice).slice(0, HANDOFF_TEXT_MAX)}`);
    // The task's check, as bounce ran it on the accepted work (src/task-check.js).
    const check = row.kind === 'task.accepted' ? session.events.findLast(event => event.kind === 'task.check' && event.task === row.task && typeof event.passed === 'boolean') : null;
    if (check) lines.push(`  check: ${check.passed ? 'passed' : 'FAILED'} (exit code ${check.exit})${check.passed && check.weak ? ', but it only looks for files or text and did not run the work' : ''} · ${String(check.command).slice(0, 500)}`);
    // A correction of accepted work, or a check that failed twice: the moment a lesson is in hand
    // (docs/plans/lessons-and-sweep.md). The orchestrator decides whether there is one.
    const retryOf = session.events.find(event => event.kind === 'task.submitted' && event.task === row.task)?.retryOf;
    const redid = retryOf && view[retryOf]?.state === 'accepted' && ['task.completed', 'task.accepted', 'task.blocked', 'task.failed'].includes(row.kind);
    if (redid || (row.kind === 'task.blocked' && row.reason === 'check_failed')) {
      lines.push(`  ${redid ? `This task redid work that had been accepted (${String(retryOf).slice(0, 8)}).` : 'This check failed twice.'} If there is a lesson a worker should know next time in this project, record it: the lesson tool (or publish lesson.learned) with agent (the job it is for, or all) and text (one sentence, imperative, no task ids). If there is none, say nothing.`);
    }
    // Work the worker reported as still remaining when it completed: the task is done, these are follow-ups.
    const completed = ['task.completed', 'task.accepted'].includes(row.kind) ? session.events.findLast(event => event.kind === 'task.completed' && event.task === row.task) : null;
    if (completed?.remaining) lines.push(`  remaining (reported by the worker; follow-up work, not done in this task): ${String(completed.remaining).slice(0, HANDOFF_TEXT_MAX)}`);
    const invalidReport = session.events.findLast(event => event.kind === 'task.report.invalid' && event.task === row.task);
    const output = session.events.findLast(event => event.kind === 'task.output' && event.task === row.task);
    if (invalidReport && (!candidate || invalidReport.seq > candidate.seq)) {
      lines.push(`  report validation: ${String(invalidReport.diagnostic ?? 'invalid_report').slice(0, 500)}`);
      if (output) lines.push(`  Worker output preserved (${output.chars} characters, attempt ${output.attempt}); use task_get with full: true. This is unvalidated output, not an accepted candidate. Do not repeat the audit before reading it.`);
    }
    if (reviewBlocked && candidate) lines.push(`  candidate: task.reported seq ${candidate.seq ?? '?'} · sha256 ${candidate.digest.slice(0, 12)}`);
    // The reason names the kind of gate; the text is what the reviewer actually answered and what to decide.
    if (reviewBlocked) lines.push(`  review gate: blocked · ${String([gate?.reason ?? row.reason, gate?.text ?? row.text].filter(Boolean).join(' · ') || 'review unavailable').slice(0, HANDOFF_TEXT_MAX)}`);
    // You see one outcome at a time; bounce sees the pattern. Found live: ten identical reviewer tasks,
    // each killed at its ceiling and resubmitted, because no single handoff showed the repetition.
    const submitted = session.events.find(e => e.kind === 'task.submitted' && e.task === row.task);
    const earlier = submitted ? failedAttempts(session.events.filter(e => e.task !== row.task), submitted) : [];
    if (earlier.length) lines.push(`  this job has now failed ${earlier.length + 1} times the same way (${[...earlier.map(a => a.reason), row.reason ?? row.kind].join(', ')}): change the scope or the AI before asking again — bounce refuses a third identical attempt.`);
  }
  lines.push(running.length ? `Still running: ${running.map(t => `${t.id} (${t.profile}, ${t.state})`).join(', ')}` : 'No other task of yours is still running.');
  // Standing workers (docs/plans/standing-workers.md §3): who exists, what each did, who is idle or heavy.
  const roster = rosterLines(session.events);
  if (roster.length) lines.push('Your workers:', ...roster);
  return lines.join('\n');
}

// `onFirstUserPrompt` fires once, fire-and-forget, right after a NEW session's first `user` row
// lands (src/session-title.js); a no-op by default so tests never title a session unless they
// inject one — see reload.js for the live wiring.
export function createMainService({session, adapters, profile, settings, profiles = {}, readRouting = () => settings,
  orchestratorEnv = {}, brief = '', handoffDelayMs = HANDOFF_DELAY_MS, typedRetryMs = TYPED_RETRY_MS,
  clock = {}, watchdog = {}, onFirstUserPrompt = () => {}}) {
  const sweepMs = (settings.sweepMinutes ?? SWEEP_MINUTES) * 60000;
  const now = clock.now ?? Date.now;
  const setTimer = clock.setTimeout ?? setTimeout;
  const clearTimer = clock.clearTimeout ?? clearTimeout;
  const startupMs = watchdog.startupMs ?? 30000;
  const runningMs = watchdog.runningMs ?? 30 * 60000;
  const retryDelayMs = watchdog.retryDelayMs ?? handoffDelayMs;
  const maxWakeAttempts = watchdog.maxWakeAttempts ?? 2;
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
  const lastCancellation = session.events.findLast(event => event.kind === 'main.cancelled');
  const lastManualRequest = session.events.findLast(event => event.kind === 'main.requested' && !event.wake);
  let current = null, closed = false, blockedState = null;
  // A FIFO of USER prompts (wake:false) that arrived while a run was current — see start() and
  // drainQueue() below.
  const queuedPrompts = [], queuedIds = new Set();
  let autoWakeSuppressed = Boolean(lastCancellation && (!lastManualRequest || lastCancellation.seq > lastManualRequest.seq));
  const unfinishedExecution = session.events.findLast(event => {
    if (!['main.starting', 'main.started'].includes(event.kind)) return false;
    return !session.events.some(later => later.seq > event.seq && later.requestId === event.requestId
      && ['main.terminal', 'main.blocked'].includes(later.kind));
  });
  const replayRequest = session.events.findLast(event => event.kind === 'main.requested'
    && !session.events.some(later => later.seq > event.seq && later.requestId === event.requestId
      && ['main.starting', 'main.started', 'main.terminal', 'main.blocked'].includes(later.kind)));
  // Found live (ACE d1bc0206): a turn orphaned by a crash blocked the orchestrator on every later restart,
  // for good — nothing cleared it. A turn whose vendor process was recorded and is now gone ended with
  // it; one with no record (older journals) stays blocked until the user says it is gone (unblock).
  const startedRow = requestId => session.events.findLast(event => event.kind === 'main.started' && event.requestId === requestId);
  const processGone = requestId => { const pid = startedRow(requestId)?.pid; return Number.isSafeInteger(pid) && !isAlive(pid); };
  if (unfinishedExecution && processGone(unfinishedExecution.requestId)) {
    session.append({kind: 'main.terminal', from: 'main', context: session.id, requestId: unfinishedExecution.requestId, turnId: unfinishedExecution.turnId,
      status: 'interrupted', text: `The orchestrator turn from before the restart ended with its process (pid ${startedRow(unfinishedExecution.requestId).pid} is gone).`});
  } else if (unfinishedExecution) {
    current = {id: unfinishedExecution.requestId, turnId: unfinishedExecution.turnId, unverified: true, orphaned: true};
    blockedState = {reason: 'orphaned', requestId: current.id};
    session.append({kind: 'main.blocked', from: 'main', requestId: current.id, turnId: current.turnId, state: 'blocked', reason: 'orphaned', text: 'Termination unverified after daemon restart; inspect the previous orchestrator process before continuing'});
  }
  const previousSafetyBlock = session.events.findLast(event => event.kind === 'main.blocked'
    && ['orphaned', 'termination_uncertain'].includes(event.reason));
  if (!current && previousSafetyBlock
    && !session.events.some(event => event.seq > previousSafetyBlock.seq && ['main.requested', 'main.unblocked'].includes(event.kind))
    && !processGone(previousSafetyBlock.requestId)) {
    current = {id: previousSafetyBlock.requestId, turnId: previousSafetyBlock.turnId, unverified: true, orphaned: true, finished: true};
    blockedState = {reason: previousSafetyBlock.reason, requestId: previousSafetyBlock.requestId};
  }
  // Rebuild the in-memory queue from queued `user` rows never dispatched before a daemon restart.
  // A row counts as dispatched once a later main.requested/started carries its requestId; older rows without one are left as transcript-only.
  for (const row of session.events) {
    if (row.kind !== 'user' || !row.queued || !row.requestId) continue;
    if (queuedIds.has(row.requestId)) continue;
    const dispatched = session.events.some(event => event.seq > row.seq
      && ['main.requested', 'main.started'].includes(event.kind) && event.requestId === row.requestId);
    if (dispatched) continue;
    const withdrawn = session.events.some(event => event.seq > row.seq
      && event.kind === 'main.withdrawn' && event.requestId === row.requestId);
    if (withdrawn) continue;
    queuedIds.add(row.requestId);
    queuedPrompts.push({id: row.requestId, text: row.text, savedImages: row.images ?? [],
      ...(row.typed ? {typed: row.typed} : {}), ...(row.provider ? {provider: row.provider} : {}),
      ...(row.model ? {model: row.model} : {}), ...(row.mode ? {mode: row.mode} : {}), ...(row.routing ? {routing: row.routing} : {})});
  }
  const state = () => ({state: current?.unverified || blockedState ? 'blocked' : current ? current.handle ? 'running' : 'starting' : 'idle',
    provider: selection.provider, model: selection.model, mode: selection.mode, policy: selection.policy, currentTurnId: current?.turnId ?? null, requestId: current?.id ?? null});
  function emit(event) {
    const row = session.append({...event, from: 'main', context: session.id});
    for (const listener of listeners) listener(row);
    return row;
  }
  function notify(rows) {
    for (const row of rows) for (const listener of listeners) listener(row);
  }
  function stopWatchdog(run) {
    if (run.watchdogTimer) clearTimer(run.watchdogTimer);
    run.watchdogTimer = null;
  }
  // A turn is not a failed continuation just because it did not durably resolve an outcome: one
  // that closes by asking the user something (its answer ends with a `Next:` line — reload.js's
  // own single-prompt convention — or a `state` row names what it is waiting on, per
  // continuations.js's namedWait) has handed the outcome over, not dropped it. Found live
  // (session 159f4746): the orchestrator answered "waiting on your go-ahead for P4" without a
  // durable successor or named wait, so the outcome stayed pending and kept re-waking it.
  function dispositionRows(run, status, closingText) {
    if (status !== 'completed') return [];
    const pending = pendingMainActions(session.events);
    const byOutcome = new Map(pending.filter(action => action.outcomeSeq !== null).map(action => [action.outcomeSeq, action]));
    const ids = new Set(run.actionIds ?? []);
    for (const served of session.events) {
      if (served.kind !== 'wait.served' || served.seq <= run.requestedSeq) continue;
      const servedRow = session.events.find(row => row.seq === served.served);
      const action = byOutcome.get(served.served) ?? pending.find(candidate => candidate.task && candidate.task === servedRow?.task);
      if (action) ids.add(action.actionId);
    }
    const rows = [];
    for (const actionId of ids) {
      const delivered = run.actions?.find(candidate => candidate.actionId === actionId);
      const action = pending.find(candidate => candidate.actionId === actionId)
        ?? (delivered?.task ? pending.find(candidate => candidate.task === delivered.task) : null)
        ?? delivered;
      if (!action) continue;
      const evidence = action.task ? taskDispositionEvidence(session.events, action, {afterSeq: run.requestedSeq, closingText}) : null;
      if (action.task && !evidence) continue;
      rows.push({kind: 'main.disposition', actionId: action.actionId, outcomeSeq: action.outcomeSeq, requestId: run.id,
        ...(action.task ? {task: action.task} : {}),
        ...(evidence?.successor ? {successor: evidence.successor} : {}),
        disposition: evidence?.disposition ?? 'reported', from: 'main', context: session.id});
    }
    return rows;
  }
  function finish(run, status, reason, {suppressReconcile = false, extraRows = []} = {}) {
    if (run.finished) return;
    run.finished = true;
    stopWatchdog(run);
    if (current === run) current = null;
    const rows = [
      {kind: 'turn', provider: run.provider, text: status === 'interrupted' ? 'cancelled' : status,
        status: status === 'interrupted' ? 'cancelled' : status},
      {kind: 'main.terminal', from: 'main', context: session.id, requestId: run.id, turnId: run.turnId,
        state: 'idle', status, ...(reason ? {reason, text: reason} : {})},
      ...dispositionRows(run, status, reason),
      ...extraRows,
    ];
    const committed = session.commit(rows, {ref: `main-terminal:${run.id}`, version: 2});
    notify(committed.filter(row => row.kind.startsWith('main.')));
    // suppressReconcile marks the internal watchdog-recovery finish, whose caller starts the
    // retry itself right after this returns — draining the queue here would steal that slot.
    if (suppressReconcile) return;
    // A prompt queued while this run was current (start() below) always goes out next, ahead of
    // any automatic wake for outcomes still pending — a typed prompt is never raced by a
    // synthetic one, queued or not. This also frees a prompt queued behind a run that ended
    // cancelled: cancellation is not a reason to lose it.
    if (drainQueue()) return;
    if (status !== 'interrupted' && !run.userCancelled) reconcile();
  }
  function block(run, reason, text, extra = {}) {
    if (run.finished) return;
    stopWatchdog(run);
    run.unverified = reason === 'termination_uncertain' || reason === 'orphaned';
    run.finished = true;
    const cleared = current === run && !run.unverified;
    if (cleared) current = null;
    blockedState = {reason, requestId: run.id, ...extra};
    emit({kind: 'main.blocked', requestId: run.id, turnId: run.turnId, state: 'blocked', reason, text, ...extra});
    // Same as finish(): a run ending in main.blocked still frees the daemon for a queued prompt,
    // unless termination itself is unverified (run.unverified) — then `current` stays held and
    // starting anything, queued or not, would race the unverified process.
    if (cleared) drainQueue();
  }
  function armWatchdog(run, stage) {
    stopWatchdog(run);
    const duration = stage === 'startup' ? startupMs : runningMs;
    if (!Number.isFinite(duration) || duration <= 0) return;
    run.watchdogTimer = setTimer(() => { void watchdogExpired(run, stage); }, duration);
  }
  async function watchdogExpired(run, stage) {
    if (closed || current !== run || run.finished || run.userCancelled) return;
    run.timedOut = true;
    if (!run.handle) {
      block(run, 'termination_uncertain', `Main ${stage} timed out before bounce obtained process identity; inspect the provider process before retrying`,
        {failure: {code: 'main_timeout', stage}});
      return;
    }
    const stopped = await adapters[run.provider].cancel(run.handle).catch(error => ({verified: false, error: error.message}));
    if (!stopped?.verified) {
      block(run, 'termination_uncertain', `Main ${stage} timed out and provider termination could not be verified`,
        {failure: {code: 'main_timeout', stage}});
      return;
    }
    run.handle = null;
    const rootRequestId = run.rootRequestId ?? run.id;
    const recoveries = session.events.filter(row => row.kind === 'main.recovery' && row.rootRequestId === rootRequestId).length;
    // Its process is verifiably gone, so nothing is left to protect: the turn ends failed and the
    // orchestrator stays ready for the next prompt. Only an unverified live writer blocks it.
    if (!run.resumed || recoveries >= 1) {
      finish(run, 'failed', `Main ${stage} timed out after verified termination; automatic recovery is exhausted`);
      return;
    }
    native.delete(run.provider);
    const nextRequestId = randomUUID();
    finish(run, 'failed', `Main ${stage} timed out; provider termination verified`, {suppressReconcile: true,
      extraRows: [{kind: 'main.recovery', from: 'main', context: session.id, requestId: run.id, nextRequestId,
        rootRequestId, reason: 'main_timeout', stage, verifiedTermination: true}]});
    start({...run.params, id: nextRequestId, recoveryOf: run.id, rootRequestId, provider: run.provider}, {wake: run.wake, forceFresh: true});
  }
  async function execute(run, params) {
    const tried = new Set();
    const candidates = [run.selected, ...run.routes];
    for (const candidate of candidates) {
      if (run.cancelled || closed || run.finished) { finish(run, 'interrupted'); return; }
      const provider = candidate.adapter;
      if (tried.has(provider) || !adapters[provider]) continue;
      tried.add(provider);
      if (cooldowns(session.events, now())[provider] > now()) continue;
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
      armWatchdog(run, 'startup');
      const result = await attempt(run, params);
      if (run.unverified || run.finished) return;
      if (run.cancelled || closed) { finish(run, 'interrupted'); return; }
      if (!['limited', 'missing'].includes(result)) return;
      run.previousProvider = provider;
      if (result === 'limited') session.append({kind: 'cooldown', provider,
        until: now() + (settings.cooldownMinutes ?? 30) * 60000,
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
      run.resumed = Boolean(previous && adapter.resume && !run.forceFresh);
      try {
        run.handle = run.resumed
          ? await adapter.resume({...options, native: previous, message: text})
          : await adapter.launch({...options, orders: text});
      } catch (error) {
        // The thread this session last used cannot be reopened. Found live: the thread was still in the
        // app's ~/.codex after bounce moved Codex to its own home ("no rollout found", ACE 36ecaacd), and
        // a reopen that never answered left a session silent (ACE d1bc0206). Whatever the reason, a fresh
        // thread from the session's handoff carries the conversation forward. A usage limit or a missing
        // executable is not the thread's fault: those go to the next provider, as before.
        if (!run.resumed || run.cancelled || closed || run.finished || ['limited', 'missing'].includes(error?.code)) throw error;
        // Another writer starts only once the failed reopen's process is known to be gone: the vendor
        // answered that it has no such thread, or the process is stopped here. One that failed without
        // a process to check keeps the safety block below.
        const gone = /no rollout found|thread not found|unknown thread/i.test(String(error?.message));
        if (error.handle ? !(await adapter.cancel(error.handle).catch(() => ({verified: false})))?.verified : !gone) throw error;
        native.delete(run.provider);
        run.resumed = false;
        session.append({kind: 'status', from: 'main', context: session.id,
          text: `The orchestrator's previous ${run.provider} thread could not be reopened (${error.message}); started a fresh one from this session's handoff.`});
        const fresh = providerInput(run.provider, [brief, roster, handoff(session, text0, settings.contextChars)].filter(Boolean).join('\n'), run.images);
        run.handle = await adapter.launch({...options, orders: fresh});
      }
      if (run.finished) {
        if (run.handle) await adapter.cancel(run.handle).catch(() => ({verified: false}));
        return;
      }
      if (run.cancelled || closed) {
        const stopped = await adapter.cancel(run.handle);
        if (!stopped?.verified) throw new Error('Main provider termination unverified');
        finish(run, 'interrupted'); return;
      }
      run.turnId = run.handle.turnId ?? run.id;
      run.started = true;
      armWatchdog(run, 'running');
      emit({kind: 'main.started', requestId: run.id, turnId: run.turnId, state: 'running', ...(Number.isSafeInteger(run.handle?.pid) ? {pid: run.handle.pid} : {})});
      for await (const event of adapter.events(run.handle)) {
        if (event.kind === 'native') {
          native.set(run.provider, {provider: run.provider, sessionId: event.sessionId});
          session.append({kind: 'peer.native', provider: run.provider, sessionId: event.sessionId, from: 'main', context: session.id});
          continue;
        }
        if (event.kind === 'result') { result = event; break; }
        if (event.kind === 'error' && event.code === 'missing') result = {status: 'missing', text: event.text};
        if (['assistant', 'tool', 'delta', 'progress', 'activity'].includes(event.kind)) run.spoke = true;
        const row = {...event, provider: run.provider, from: 'main', context: session.id};
        if (['delta', 'progress', 'activity'].includes(event.kind)) session.publish(row);
        else session.append(row);
      }
      // A terminal message ends the model turn, but the process must also stop before a new
      // writer is admitted. Native identity survives separately for the next turn's resume.
      const stopped = await adapter.cancel(run.handle);
      if (!stopped?.verified) throw new Error('Main provider termination unverified');
      run.handle = null;
      stopWatchdog(run);
      if (run.finished) return;
      const status = run.cancelled || closed ? 'interrupted' : result?.status;
      if (['limited', 'missing'].includes(status)) return status;
      // A message the user typed, refused by the vendor before the orchestrator said or did anything,
      // is tried once more. Found live (ACE e3bd01d5): "model 'gpt-6-sol' is not enabled" on the first
      // message of a session, which was answered when typed again a minute later. A turn that had
      // started working is never run twice, and an outcome bounce handed over has its own retries.
      if (status === 'failed' && !run.wake && !run.retried && !run.spoke) {
        run.retried = true;
        session.append({kind: 'status', from: 'main', context: session.id, text: `${run.provider} refused the message (${result?.text ?? 'no reason given'}); trying once more.`});
        await new Promise(resolve => setTimer(resolve, typedRetryMs));
        // Closed while it waited: the session is going away, and nothing more is written to it.
        if (run.finished || closed) return;
        if (run.cancelled) { finish(run, 'interrupted'); return; }
        armWatchdog(run, 'startup');
        return attempt(run, params);
      }
      finish(run, ['completed', 'failed', 'limited', 'interrupted'].includes(status) ? status : 'failed',
        result ? result.text : 'Provider exited without a terminal result');
    } catch (error) {
      stopWatchdog(run);
      run.handle ??= error.handle;
      if (!run.handle && error.code !== 'missing' && error.spawned !== false) {
        block(run, 'termination_uncertain', `Main launch failed without process identity: ${error.message}`,
          {failure: {code: error.code ?? 'launch_failed', stage: 'startup'}});
        return;
      }
      if (run.handle) {
        const stopped = await adapter.cancel(run.handle).catch(() => ({verified: false}));
        if (!stopped?.verified) {
          block(run, 'termination_uncertain', 'Main provider termination unverified',
            {failure: {code: error.code ?? 'provider_failed', stage: run.started ? 'running' : 'startup'}});
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
  function pendingActions() {
    return pendingMainActions(session.events);
  }
  function actionBlock(actions) {
    return handoffBlock(session, actions.map(action => action.row));
  }
  function start(params, {wake, sweep = false, forceFresh = false, fromQueue = false} = {}) {
    if (closed) return {accepted: false, reason: 'daemon_closed'};
    if (current && (wake || current.unverified)) return {accepted: false, reason: current.unverified ? 'termination_unverified' : 'busy'};
    if (blockedState && ['termination_uncertain', 'orphaned'].includes(blockedState.reason)) return {accepted: false, reason: 'termination_unverified'};
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
    try { images = params.savedImages ?? saveImages([...new Set([...(params.files ?? []), ...imagePaths(params.text, session.cwd)])], session); }
    catch (error) { return {accepted: false, reason: error.message}; }
    // A wake never journals a `user` row (see below), so it can never be the first one — only a
    // genuine new session's very first typed/queued prompt fires onFirstUserPrompt.
    const isFirstPrompt = !wake && !session.events.some(e => e.kind === 'user');
    if (current) {
      // A user prompt landing while a run is current is queued instead of refused; `id` is
      // stable across a resend so a retry never queues a second copy.
      const id = params.id ?? randomUUID();
      if (queuedIds.has(id)) return {accepted: true, queued: true, requestId: id};
      queuedIds.add(id);
      queuedPrompts.push({...params, id, savedImages: images});
      // requestId plus whatever of provider/model/mode/routing the caller set is journaled on the
      // row itself: a daemon restart rebuilds queuedPrompts from the journal (below), not from this
      // in-memory array, and needs enough here to call start() again unchanged.
      session.append({kind: 'user', text: params.text, queued: true, requestId: id,
        ...(params.typed ? {typed: params.typed} : {}), ...(images.length ? {images} : {}),
        ...(params.provider ? {provider: params.provider} : {}), ...(params.model ? {model: params.model} : {}),
        ...(params.mode ? {mode: params.mode} : {}), ...(params.routing ? {routing: params.routing} : {})});
      if (isFirstPrompt) { try { onFirstUserPrompt(session, settings); } catch {} }
      return {accepted: true, queued: true, requestId: id};
    }
    let routes;
    try { routes = fallbackRoutes(params.routing ?? readRouting()); }
    catch (error) { return {accepted: false, reason: error.message}; }
    const selected = {...profile, ...(provider === selection.provider ? {mode: selection.mode ?? profile.mode, policy: selection.policy ?? profile.policy} : {}), adapter: provider, model: params.model ??
      (provider === selection.provider ? selection.model : settings.models?.[provider] ?? '')};
    const actions = pendingActions();
    const held = sweep ? heldTasks() : [];
    if (sweep && !held.length) return {accepted: false, reason: 'nothing_waiting'};
    if (wake && !sweep && !actions.length) return {accepted: false, reason: 'nothing_pending'};
    const actionKey = actions.length ? actionSetKey(actions) : null;
    const run = {id: params.id ?? randomUUID(), provider, selected, routes, images, wake, actionKey, actions,
      actionIds: actions.map(action => action.actionId), outcomeSeqs: actions.map(action => action.outcomeSeq).filter(Number.isInteger),
      forceFresh, rootRequestId: params.rootRequestId ?? params.id, recoveryOf: params.recoveryOf, params: {...params, savedImages: images},
      previousProvider: session.events.findLast(event => event.kind === 'main.starting')?.provider,
      handle: null, turnId: null, cancelled: false, finished: false, started: false};
    // Outcomes are journaled here, synchronously with the prompt row, and the very same text
    // is what execute() prepends — the log and the prompt can never disagree about what the
    // orchestrator was told. A typed prompt carries them too (`wake: false`): the user's own
    // turn is never raced by a synthetic one. The block counts as delivered only once this
    // requestId reaches main.started; a launch that fails leaves the outcomes pending.
    if (sweep) run.outcomes = sweepBlock(held);
    else if (actions.length) run.outcomes = actionBlock(actions);
    const requested = {kind: 'main.requested', from: 'main', context: session.id, requestId: run.id,
      wake, ...(sweep ? {sweep: true} : {}), text: params.text, provider, model: selected.model ?? '', mode: selected.mode, policy: selected.policy,
      images, actionIds: run.actionIds, outcomeSeqs: run.outcomeSeqs, actionKey,
      attempt: wake && actionKey ? wakeAttempts(session.events, actionKey) + 1 : 1,
      dueAt: wake ? now() : null, ...(params.recoveryOf ? {recoveryOf: params.recoveryOf, rootRequestId: run.rootRequestId} : {})};
    const committed = [requested];
    // A dispatch drained from the queue already journaled its `user` row when it was queued.
    if (!wake && !fromQueue) committed.unshift({kind: 'user', text: params.text, ...(params.typed ? {typed: params.typed} : {}), ...(images.length ? {images} : {})});
    if (sweep) committed.push({kind: 'handoff', wake, sweep: true, requestId: run.id, actionIds: [], outcomeSeqs: [], tasks: held.map(t => t.id), text: `${run.outcomes}\n\n${params.text}`, from: 'bounce'});
    else if (actions.length) committed.push({kind: 'handoff', wake, requestId: run.id,
      actionIds: run.actionIds, outcomeSeqs: run.outcomeSeqs, tasks: actions.filter(action => action.task).map(action => action.task),
      text: wake ? `${run.outcomes}\n\n${params.text}` : run.outcomes, from: 'bounce'});
    const rows = session.commit(committed, {ref: `main-request:${run.id}`, version: 2});
    run.requestedSeq = rows.find(row => row.kind === 'main.requested').seq;
    if (!wake && !fromQueue && isFirstPrompt) { try { onFirstUserPrompt(session, settings); } catch {} }
    current = run;
    blockedState = null;
    if (!wake) autoWakeSuppressed = false;
    session.active = provider;
    run.done = Promise.resolve().then(() => execute(run, {...params}));
    return {accepted: true, requestId: run.id, state: 'started'};
  }
  // Called by finish()/block() once `current` frees up: the oldest queued USER prompt, if any,
  // starts right here — before those callers decide whether to reconcile/arm an automatic wake.
  function drainQueue() {
    if (closed || current || !queuedPrompts.length) return false;
    const item = queuedPrompts.shift();
    queuedIds.delete(item.id);
    start(item, {wake: false, fromQueue: true});
    return true;
  }
  // Wake-up on a terminal row: the daemon owns the main agent, so when it is idle and a task it
  // submitted ends, the daemon starts the next turn itself — the user never has to ask "what
  // happened?". Coalesced over a short window; a user prompt that lands first wins (start()
  // gives it the same block) and the timer finds nothing left to do. Classic mode never
  // constructs this service (reload.js), so nothing here can fire outside orchestrator mode.
  let wakeTimer = null, wakeTimerKey = null;
  function wake() {
    wakeTimer = null;
    const scheduledKey = wakeTimerKey;
    wakeTimerKey = null;
    if (closed || current) return;
    const actions = pendingActions();
    if (!actions.length) return;
    if (actionSetKey(actions) !== scheduledKey) { reconcile(); return; }
    const result = start({text: WAKE_PROMPT}, {wake: true});
    if (!result.accepted && result.reason !== 'busy' && result.reason !== 'nothing_pending') {
      session.append({kind: 'status', text: `Pending orchestration actions could not be handed to the orchestrator: ${result.reason}`});
    }
  }
  // The timer is ref'd on purpose: a pending wake-up is work the daemon owes, not something to
  // drop if the loop happens to empty (Node 22 does exactly that; an unref'd timer stranded the
  // outcomes). It cannot outlive the daemon — close() clears it before the bus goes down.
  function arm(actions, key, attempt) {
    if (closed || current || wakeTimer || autoWakeSuppressed) return;
    const existing = session.events.findLast(row => row.kind === 'main.wake.scheduled' && row.actionKey === key && row.attempt === attempt);
    const dueAt = existing?.dueAt ?? now() + (attempt === 1 ? handoffDelayMs : retryDelayMs);
    if (!existing) session.commit([{kind: 'main.wake.scheduled', from: 'main', context: session.id, actionKey: key,
      actionIds: actions.map(action => action.actionId), outcomeSeqs: actions.map(action => action.outcomeSeq).filter(Number.isInteger),
      attempt, dueAt}], {ref: `main-wake-scheduled:${key}:${attempt}`, version: 2});
    wakeTimerKey = key;
    wakeTimer = setTimer(wake, Math.max(0, dueAt - now()));
  }
  function reconcile() {
    if (closed || current || wakeTimer || autoWakeSuppressed) return;
    const actions = pendingActions();
    if (!actions.length) return;
    const key = actionSetKey(actions);
    // An older journal's exhausted set (main.blocked wake_retry_exhausted / plan_undispatched) stays settled.
    if (blockedActionSet(session.events, key)) return;
    // Bounce never blocks the orchestrator over outcomes it has not resolved: after its continuation
    // attempts, bounce stops waking it for this same set. The outcomes stay pending — in front of the next
    // prompt and in the state view — and the orchestrator stays ready. Found live: wake_retry_exhausted
    // held sessions blocked until the user noticed.
    if (wakeAttempts(session.events, key) >= maxWakeAttempts) return;
    arm(actions, key, wakeAttempts(session.events, key) + 1);
  }
  const unsubscribeHandoff = session.subscribe(row => {
    if (![...HANDOFF_KINDS, 'task.submitted', 'main.disposition'].includes(row.kind)) return;
    reconcile();
  });

  // The quiet sweep. Held work the orchestrator has not decided on, nothing running or under review,
  // no wake armed and no turn: after sweepMs of no rows, one turn asks what is waiting. A sweep that
  // was answered with nothing new since is not repeated; the next row of anyone's re-arms it.
  const QUIET = new Set(['task.usage', 'usage', 'raw', 'delta', 'model', 'checkpoint', 'main.wake.scheduled']);
  let sweepTimer = null;
  function heldTasks() {
    const view = tasks(session.events);
    return Object.values(view).filter(t => t.state === 'blocked' && orchestratorsTask(session, view, t.id))
      .map(t => ({...t, since: session.events.findLast(e => e.kind === 'task.blocked' && e.task === t.id), copy: session.events.findLast(e => e.kind === 'task.artifact' && e.task === t.id)?.cwd ?? null}));
  }
  function inFlight() {
    const view = tasks(session.events);
    return Object.values(view).some(t => !TERMINAL.has(t.state) && !['blocked', 'input_required'].includes(t.state));
  }
  function sweepBlock(held) {
    const minutes = Math.round(sweepMs / 60000);
    const lines = [`Nothing has happened for ${minutes} minutes (delivered by bounce, not typed by the user). Nothing is running; this is waiting on you:`];
    for (const t of held) {
      const age = t.since ? Math.max(0, Math.round((now() - Date.parse(t.since.time)) / 60000)) : null;
      lines.push(`- task ${t.id} · profile ${t.profile ?? '?'} · held${t.since?.reason ? ` · reason: ${t.since.reason}` : ''}${age !== null ? ` · for ${age} min` : ''}${t.copy ? ` · work in ${t.copy}` : ''}`);
      if (t.since?.text) lines.push(`  ${String(t.since.text).slice(0, HANDOFF_TEXT_MAX).replace(/\n/g, '\n  ')}`);
    }
    return lines.join('\n');
  }
  function sweepDue() {
    if (sweepMs <= 0 || closed || current || wakeTimer || autoWakeSuppressed) return false;
    // Outcomes still pending do not stop a sweep: once their wake attempts are spent (reconcile arms
    // nothing more), the sweep is what is left — the 91-minute case was exactly that.
    if (inFlight() || !heldTasks().length) return false;
    // answered already, and nothing of anyone's has happened since that sweep
    const lastSweep = session.events.findLast(e => e.kind === 'main.requested' && e.sweep);
    if (lastSweep && !session.events.some(e => e.seq > lastSweep.seq && !QUIET.has(e.kind) && !e.kind.startsWith('main.') && !['turn', 'handoff', 'route', 'assistant', 'tool', 'status', 'state'].includes(e.kind))) return false;
    return true;
  }
  function armSweep() {
    if (sweepTimer) { clearTimer(sweepTimer); sweepTimer = null; }
    if (!sweepDue()) return;
    sweepTimer = setTimer(() => {
      sweepTimer = null;
      if (!sweepDue()) return;
      session.append({kind: 'status', from: 'main', context: session.id, text: `Nothing has happened for ${Math.round(sweepMs / 60000)} minutes and ${heldTasks().length} held task(s) wait for the orchestrator; asking it.`});
      start({text: SWEEP_PROMPT}, {wake: true, sweep: true});
    }, sweepMs);
  }
  const unsubscribeSweep = session.subscribe(row => { if (!QUIET.has(row.kind)) armSweep(); });
  armSweep();
  const service = {
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    run(params) { return start(params, {wake: false}); },
    // The user's word that the orchestrator process from before a restart is gone (bounce could not
    // verify it: older journals never recorded its process). Only a safety block is cleared this way.
    unblock() {
      const orphanedTasks = Object.values(tasks(session.events)).filter(t => t.state === 'blocked'
        && session.events.findLast(e => e.task === t.id && e.kind === 'task.blocked')?.reason === 'orphaned');
      const mainHeld = blockedState && ['orphaned', 'termination_uncertain'].includes(blockedState.reason);
      if (!mainHeld && !orphanedTasks.length) return {accepted: false, reason: 'not_blocked'};
      // Workers from before the restart, unverifiable too: cancelled as lost (a cancellation never falls back).
      for (const t of orphanedTasks) session.append({kind: 'task.cancelled', task: t.id, reason: 'lost_in_restart', from: 'user', context: t.context ?? session.id,
        text: 'The user confirmed its worker process from before the restart is gone; resubmit what is left'});
      const row = session.append({kind: 'main.unblocked', from: 'user', context: session.id, ...(mainHeld ? {requestId: blockedState.requestId} : {}),
        tasks: orphanedTasks.map(t => t.id), text: 'The user confirmed the processes from before the restart are gone; new turns may start.'});
      for (const listener of listeners) listener(row);
      if (mainHeld) { current = null; blockedState = null; }
      return {accepted: true, cancelled: orphanedTasks.map(t => t.id)};
    },
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
      if (!run) {
        autoWakeSuppressed = true;
        if (wakeTimer) { clearTimer(wakeTimer); wakeTimer = null; wakeTimerKey = null; }
        session.append({kind: 'main.cancelled', from: 'user', reason: 'user_cancelled', text: 'Automatic main continuation cancelled by user'});
        return {accepted: true, verified: true};
      }
      if (run.orphaned) return {accepted: false, verified: false, reason: 'termination_unverified'};
      if (id && id !== run.id) return {accepted: false, reason: 'turn_changed'};
      autoWakeSuppressed = true;
      if (wakeTimer) { clearTimer(wakeTimer); wakeTimer = null; wakeTimerKey = null; }
      run.cancelled = true;
      run.userCancelled = true;
      session.append({kind: 'main.cancelled', from: 'user', requestId: run.id, reason: 'user_cancelled', text: 'Main turn cancelled by user'});
      if (!run.handle) return {accepted: true, state: 'cancelling'};
      const stopped = await adapters[run.provider].cancel(run.handle);
      if (stopped?.verified) finish(run, 'interrupted');
      else block(run, 'termination_uncertain', 'Main provider termination unverified during cancellation',
        {failure: {code: 'cancel_failed', stage: run.started ? 'running' : 'startup'}});
      return {accepted: true, ...stopped};
    },
    // Only a prompt still sitting in the queue (never handed to execute()) can be pulled back —
    // once it is dispatched (main.requested/main.started), withdrawing it would race the run it
    // already started. `id` is the requestId the prompt was queued under (start()'s `id`, same
    // one the TUI already holds from its own submit).
    withdraw({id} = {}) {
      const index = queuedPrompts.findIndex(item => item.id === id);
      if (index === -1) {
        const queuedRow = session.events.findLast(event => event.kind === 'user' && event.queued && event.requestId === id);
        return {withdrawn: false, reason: queuedRow ? 'started' : 'not_queued'};
      }
      const [item] = queuedPrompts.splice(index, 1);
      queuedIds.delete(id);
      session.append({kind: 'main.withdrawn', from: 'user', requestId: id, text: item.text});
      return {withdrawn: true, text: item.text};
    },
    async close() {
      closed = true;
      unsubscribeRoster();
      unsubscribeHandoff();
      unsubscribeSweep();
      if (sweepTimer) { clearTimer(sweepTimer); sweepTimer = null; }
      if (wakeTimer) { clearTimer(wakeTimer); wakeTimer = null; wakeTimerKey = null; }
      const run = current;
      if (!run) return {verified: true};
      if (run.orphaned || run.unverified) return {verified: false};
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
  queueMicrotask(() => {
    if (closed || current) return;
    if (replayRequest) {
      const result = start({id: replayRequest.requestId, text: replayRequest.text, provider: replayRequest.provider,
        model: replayRequest.model, mode: replayRequest.mode, savedImages: replayRequest.images ?? [],
        rootRequestId: replayRequest.rootRequestId}, {wake: Boolean(replayRequest.wake)});
      if (!result.accepted && result.reason !== 'nothing_pending') reconcile();
      return;
    }
    // A queue rebuilt from the journal (above) drains exactly like a live one: ahead of any
    // automatic wake, one item now, the rest chained through finish()/block() as each turn ends.
    if (drainQueue()) return;
    reconcile();
  });
  return service;
}
