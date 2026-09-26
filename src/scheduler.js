import {validateRequirements, missingCapabilities} from './task-capabilities.js';
import {candidateResult, isReviewGate, REVIEW_GATE_REASONS} from './task-result.js';
import {randomUUID, createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createAttemptWorkspace, captureArtifact, integrateArtifact, advanceBaseline} from './workspace-artifacts.js';
import * as reducers from './reducers.js';
import {takeCheckpoint, sameTree} from './checkpoint.js';
import {POLICY_RANK, effectivePolicy, LOCAL_ADAPTERS, playedBy, READ_ONLY_ROLES as READONLY_ROLES} from './profiles.js';
import {defaultStrategy} from './strategy.js';
import {reportEvent, validateReport, remainingWork} from './reporting.js';
import {inspectFinalReport, synthesizeReport, FINAL_REPORT_INSTRUCTION} from './final-report.js';
import {actionState, campaigns, createActionRunner, requestAction} from './orchestration.js';
import {normalizeLocalSettings} from './local-models.js';
import {createLocalResolver} from './local-resolve.js';
import {createResources, residentModels, sizeOf, fitLocal, gb, pressureName, DEFAULT_RESERVE_BYTES} from './resources.js';
import {concludeAsk} from './adapters/live-common.js';
import {failedAttempts, repeatRefusal, REPEAT_LIMIT} from './loop-guard.js';
import {discoverLocalModels} from './local-models.js';
import {planTaskAdmission} from './plan-admission.js';
import {supervisePlan} from './plan-supervision.js';
import {judgePlan, routingFallback} from './jev.js';
import {validOwns} from './owned-paths.js';
import {execFileSync} from 'node:child_process';

const FALLBACK_REASONS = new Set(['limited', 'missing', 'backend_unavailable', 'watchdog', 'local_unavailable', 'worker_runtime', 'incomplete_report']);
const RISKS = new Set(['boundary', 'process-model', 'logic', 'extraction']);
const SIZE_FIELDS = ['lines', 'probes', 'minutes'];
// Silence is five minutes, not two: at two the alarm fired on every test run and corrected itself
// five seconds later (observed live, four times in one task), which only teaches you to ignore it.
// No MILESTONE for ten minutes is still a stall, whatever the worker prints.
// concludeGrace: how long a worker asked for its conclusion has to give it. Five minutes, not two: one
// step of the local 27B at 77k tokens of context took up to three minutes of prefill (live).
// concludeCap: the most a conclusion that keeps showing activity is waited for. Found live: a 27B was
// still generating its answer 284 s into a fixed 300 s grace, and a whole 60 min review was lost.
// `reportOnly` is how long a report-only continuation (a resumed worker asked only for its missing
// final report) may take. It was 10 s, less than a resumed CLI's own startup plus one tool call:
// observed on fb9181d5, every such continuation timed out and finished work was journaled as failed.
export const WATCHDOG_DEFAULTS = {interval: 5000, startupMs: 120_000, silence: 300_000, stall: 600_000, grace: 120_000, concludeGrace: 300_000, concludeCap: 900_000, reportOnly: 120_000};
const DEFAULT_DEADLINE_MINUTES = 60; // a worker with no declared deadline; the watchdog ladder still catches silence
const DEFAULT_CEILING_MINUTES = 60; // no lease is renewed past this, measured from the lineage's first start
const CALL_MEMORY = 200; // tool calls remembered per running task, to tell new work from repeated work
const TIERS = new Set(['live', 'next-turn', 'queued']);
// The depends_on hold/fail decision (which dependency states fail a dependent outright vs.
// merely hold it — A1) now lives in the strategy (src/strategy.js's DEPENDENCY_FAIL_STATES),
// not here: this scheduler only executes the intent onSubmitted returns.

// The tree's HEAD when a worker starts, recorded on task.started so a completion verdict can
// diff the worker's whole contribution (committed or not). Null outside a git repository.
export function defaultGitHead(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true}).trim() || null; }
  catch { return null; }
}
const AUTO_PROFILE = 'auto';

const isNonNegativeInt = n => Number.isInteger(n) && n >= 0;
const isPositiveInt = n => Number.isInteger(n) && n > 0;
// A final-text envelope is a compatibility fallback when no scoped report tool is available.
const LOCAL_REPORT_LINE = FINAL_REPORT_INSTRUCTION;
const reportsByTool = profile => ['codex', 'opencode'].includes(profile?.adapter);
const reportInstruction = profile => reportsByTool(profile)
  ? 'call the bounce_report tool with the report object'
  : 'use bounce report --report <json>';
// The whole report schema rides with the orders. A worker that is only told "final reports
// require …" guesses the progress shape, gets a refusal, and goes looking for the schema in
// the CLI (observed: `bounce`/`bounce --help` probes costing minutes per task). Every field a
// report can carry is named here once, so the first report is the right one.
const reportContract = profile => [
  `To report progress, ${reportInstruction(profile)} using your scoped report endpoint (it is the only bounce command you need; \`bounce\` alone starts nothing useful here).`,
  'Every report is a JSON object with op ("milestone" | "blocked" | "input_required" | "final"), phase ("inspect" | "plan" | "implement" | "test" | "verify" | "review" | "document" | "done"),',
  'text (what changed), next (what happens next) — all strings, all required — and optional evidence (an array of up to 32 strings naming files, commands or results).',
  'Evidence for a command quotes the command and its actual output lines (for example `deno test -A tests/x_test.ts` then `ok | 3 passed | 0 failed`), not a description of them: a review cannot accept a result it cannot see.',
  'A final report additionally requires outcome ("completed" | "failed" | "blocked" | "input_required") and summary, and may carry remaining (a string).',
  'Completion is relative to your assigned scope. Findings about future project work belong in evidence and next, not remaining. Use remaining for unfinished obligations in this assignment; never hide unfinished assigned work to claim completion.',
  'Report a milestone after initial inspection and at each phase change; report blocked the moment progress stops; end with one final report. Do not publish task completion directly.',
  'You run headless, as one turn: ending your turn ends your process, and nothing re-invokes you. Never background a command, set a',
  'monitor, or stop to "pick up when it finishes" — run long commands (deploys, test suites) in the foreground with a generous timeout,',
  'then send the final report in this same turn. Work you leave running when you stop is orphaned and the task is failed as unreported.',
  `Example: ${reportsByTool(profile) ? 'bounce_report ' : "bounce report --report '"}{"op":"milestone","phase":"inspect","text":"Read the three files the orders name","next":"Implement the helper","evidence":["src/a.js"]}${reportsByTool(profile) ? '' : "'"}`,
].join('\n');

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
export function createScheduler({session, adapters, profiles, localSettings, localResolver = createLocalResolver({local: localSettings}),
  // What the machine can run: one reader, the LM Studio catalog, and the one command that frees memory.
  resources = createResources(), localFleet = ({signal} = {}) => discoverLocalModels(localSettings, {signal, maxAge: 2000}),
  unloadLocal = async name => { execFileSync('lms', ['unload', String(name).split('/').slice(1).join('/')], {timeout: 60000}); },
  sessionMode = 'yolo', depthCap = 1, checkpointRunner, limits: suppliedLimits = {}, strict = false, requireFinalReport = false, reportGrant = null, clock = () => Date.now(), watchdog: suppliedWatchdog = {}, strategy = defaultStrategy, jev = null, gitHead = defaultGitHead, maxConcurrentCloud = 3}) {
  // Sizing limits (lines/probes/minutes) gate dispatch ONLY when the caller configures them: a
  // task's declared size is otherwise informational. The old built-in 150/6/15 defaults refused
  // real orchestrations (a 400-line brief) with no way to see why — a shallow rule, removed.
  const limits = {rounds: 2, ...suppliedLimits};
  if (!isPositiveInt(limits.rounds) || (limits.attempts !== undefined && !isPositiveInt(limits.attempts)) || SIZE_FIELDS.some(field => limits[field] !== undefined && !isPositiveInt(limits[field])) || (limits.ceiling !== undefined && !isPositiveInt(limits.ceiling))) throw new Error('malformed: limits');
  if (!isPositiveInt(maxConcurrentCloud)) throw new Error('malformed: maxConcurrentCloud');
  // The deadline is a lease renewed while the worker makes progress; the ceiling is the hard stop.
  const ceilingMs = (limits.ceiling ?? Math.max(DEFAULT_CEILING_MINUTES, limits.minutes ?? DEFAULT_DEADLINE_MINUTES)) * 60000;
  const watchdogConfig = {...WATCHDOG_DEFAULTS, ...suppliedWatchdog};
  const intervalOk = watchdogConfig.interval === null || isPositiveInt(watchdogConfig.interval);
  if (!intervalOk || !isPositiveInt(watchdogConfig.startupMs) || !isPositiveInt(watchdogConfig.silence) || !isPositiveInt(watchdogConfig.stall) || !isPositiveInt(watchdogConfig.grace) || !isPositiveInt(watchdogConfig.concludeGrace) || !isPositiveInt(watchdogConfig.concludeCap) || !isPositiveInt(watchdogConfig.reportOnly)) throw new Error('malformed: watchdog');
  const handles = new Map(); // task -> {adapter, handle}
  let closed = false;
  const planController = new AbortController();
  const cancellationRequests = new Set();
  const reviews = new Map(); // task -> {adapter, handle}, one review in flight per task (A3)
  const heldTasks = new Set(); // tasks queued behind an unaccepted depends_on, re-evaluated on terminal rows
  const campaignWaiters = new Set();
  function campaignActive(task, id = submittedRow(task)?.campaignId) {
    return !id || campaigns(session.events)[id]?.state === 'active';
  }
  // The in-place task presently holding the lock, if any: `running`, or `blocked`/`orphaned`
  // after a restart whose worker termination is unverified — the lock stays held until a human resolves it.
  const inPlaceRunning = () => Object.values(reducers.tasks(session.events)).find(t => submittedRow(t.id)?.inPlace
    && (t.state === 'running' || (t.state === 'blocked' && session.events.findLast(e => e.task === t.id && e.kind === 'task.blocked')?.reason === 'orphaned'))) ?? null;
  const integrationInFlight = () => [...actionState(session.events).values()].some(a => a.type === 'integrate' && a.status === 'started');
  const inPlaceBusy = () => Boolean(inPlaceRunning()) || integrationInFlight();
  const inPlaceHolder = () => inPlaceRunning()?.id ?? null;
  // What Jev sees for the risk check (§2): the cited message first, then every OTHER user
  // message since the last in-place task (exclusive) — never before it, so an already-spent
  // authorization from an earlier in-place task cannot be re-read as covering this one.
  function inPlaceRiskInputs(row) {
    const cited = session.events.find(e => e.kind === 'user' && e.seq === row.inPlace.authorizedBy);
    const priorInPlace = session.events.filter(e => e.kind === 'task.submitted' && e.inPlace && e.task !== row.task && (e.seq ?? 0) < (row.seq ?? Infinity))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0];
    const since = priorInPlace ? priorInPlace.inPlace.authorizedBy : 0;
    const others = session.events.filter(e => e.kind === 'user' && (e.seq ?? 0) > since && e.seq !== cited?.seq).map(e => e.text);
    return {citedText: cited?.text ?? '', messages: [cited?.text ?? '', ...others], orders: row.orders};
  }
  function waitForCampaign(task, campaignId = submittedRow(task)?.campaignId) {
    if (closed) return Promise.resolve(false);
    append({kind: task ? 'task.campaign.waiting' : 'campaign.waiting', task, campaignId,
      text: 'Campaign is paused or needs input; new execution waits for explicit resume'});
    return new Promise(resolve => {
      const wake = () => {
        if (closed || reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) {
          campaignWaiters.delete(wake); resolve(false);
        } else if (campaignActive(task, campaignId)) { campaignWaiters.delete(wake); resolve(true); }
      };
      campaignWaiters.add(wake);
      wake();
    });
  }
  // Local workers waiting for a slot: `local.endpoints.<name>.maxConcurrent` is how many the endpoint
  // runs at once (LM Studio is loaded with that many parallel slots; more would queue inside it and
  // look stalled, and each running model turn holds memory — observed live as a machine under memory pressure).
  // A task past the limit stays queued, says so once, and dispatches when a local turn ends.
  const slotWaiters = new Set();
  // In-place tasks (docs/plans/in-place-tasks.md): at most one running, and never alongside a
  // mid-flight integration of any task's — `inPlaceWaiters` holds tasks parked on that lock,
  // exactly like `slotWaiters` parks tasks on a full local endpoint.
  const inPlaceWaiters = new Set();
  // Integrate actions currently gated by an in-place task's lock, so the "waiting for … (in
  // place)" milestone journals once per gated action rather than on every reconcile() poll.
  const integrationWaiting = new Set();
  const localEndpoint = endpoint => { try { return normalizeLocalSettings(localSettings).endpoints[endpoint] ?? {}; } catch { return {}; } };
  const localSlots = endpoint => localEndpoint(endpoint).maxConcurrent ?? 1;
  // Per model: the endpoint's slotsPerModel, else the endpoint ceiling (one model, same number).
  const modelSlots = endpoint => localEndpoint(endpoint).slotsPerModel ?? localSlots(endpoint);
  // Running = a live handle, or a launch still in flight (the handle exists only after launch()
  // resolves, and several dispatches can pass the check before the first one does).
  const localEndpointOf = task => { const p = profiles[reducers.tasks(session.events)[task]?.profile]; return p && LOCAL_ADAPTERS.has(p.adapter) ? p.endpoint ?? 'lmstudio' : null; };
  const localModelOf = task => profiles[reducers.tasks(session.events)[task]?.profile]?.model ?? null;
  const localRunning = (endpoint, model = null) => new Set([
    ...[...handles.entries()].filter(([task, entry]) => entry.local === endpoint
      && (model === null || localModelOf(task) === model)).map(([task]) => task),
    ...[...launchingAttempts.keys()].filter(task => localEndpointOf(task) === endpoint
      && (model === null || localModelOf(task) === model)),
    ...[...reviews.entries()].filter(([, entry]) => entry.local === endpoint
      && (model === null || entry.model === model)).map(([peer]) => peer),
  ]).size;
  // Cloud workers (claude/codex/muse) have no per-endpoint config the way local does — one
  // machine-wide ceiling (`maxConcurrentCloud`) instead, counted the same way localRunning counts
  // a local endpoint: a live handle or a launch still in flight. Jev/typesafe decisions are never
  // workers and are not in this set (typesafe is not a CLOUD_ADAPTERS member); an in-place task
  // counts here exactly like any other task, by the adapter it actually runs on.
  const CLOUD_ADAPTERS = new Set(['claude', 'codex', 'muse']);
  const cloudAdapterOf = task => { const p = profiles[reducers.tasks(session.events)[task]?.profile]; return p && CLOUD_ADAPTERS.has(p.adapter) ? p.adapter : null; };
  const cloudRunning = () => new Set([
    ...[...handles.entries()].filter(([, entry]) => entry.cloud).map(([task]) => task),
    ...[...launchingAttempts.keys()].filter(task => cloudAdapterOf(task)),
    ...[...reviews.entries()].filter(([, entry]) => entry.cloud).map(([peer]) => peer),
  ]).size;
  const launchingAttempts = new Map(); // task -> {attempt, reports}; grants exist before task.started
  const resolvedLocalProfiles = new Map();
  // Live activity, never journaled (task.activity is a LIVE_KIND): task -> {at, expectUntil}.
  // Updated straight off the subscriber below, the same way it sees every other peer-published row.
  const activity = new Map();
  // Live too: the worker's recent tool calls ({at, call, change}), for adapters that name them.
  const toolCalls = new Map();
  const leaseChecks = new Set(); // tasks whose lease end is being decided right now (a Jev call may be in flight)
  const workerFrom = task => `worker:${task}`;
  const reviewFrom = task => `review:${task}`;
  // A task submitted with `profile: "auto"` is routed at dispatch (jev.routed): every reader of
  // the submitted row sees the routed profile, exactly as if it had been submitted that way.
  const rawSubmittedRow = task => session.events.find(e => e.kind === 'task.submitted' && e.task === task);
  const submittedRow = task => {
    const row = rawSubmittedRow(task);
    // ...and so is a task for an agent whose `models:` opens with `auto`: Jev's AI for it is a routed row too.
    if (row?.profile !== AUTO_PROFILE && profiles[row?.profile]?.auto !== true) return row;
    const routed = session.events.findLast(e => e.kind === 'jev.routed' && e.task === task);
    return routed ? {...row, profile: routed.chosen} : row;
  };
  // A job on an AI Jev picked (`agent@ai`) is composed when it is first needed and again after a
  // restart, from the rows that named it — it is never part of the validated table.
  // `local` ({endpoint, model}) when the AI is a local model, which has no profile of its own.
  const compose = (agent, ai, local = null) => {
    const selectedAdapter = local ? 'opencode' : profiles[ai]?.adapter;
    const policies = adapters[selectedAdapter]?.capabilities?.().executionPolicies;
    if (Array.isArray(policies) && !policies.includes(effectivePolicy(profiles[agent] ?? {}))) return null;
    const name = `${agent}@${ai}`;
    if (profiles[agent]?.auto === true && (local || profiles[ai])) profiles[name] = playedBy(profiles[agent], ai, profiles[ai], local);
    return profiles[name] ? name : null;
  };
  for (const e of session.events) if (e.kind === 'jev.routed' && e.agent && e.ai) compose(e.agent, e.ai, e.local ?? null);
  // Jev's diff base (`head` on the first task.started) is recorded only for a task a
  // decision-model (typesafe) reviewer will judge — the `jev` critic prepare() names when Jev
  // review is on. Otherwise the row carries no `head` and no git call is made, so with Jev
  // off the journal is byte-for-byte today's.
  const jevReviewed = row => {
    const completion = row?.review?.completion;
    const first = Array.isArray(completion) ? completion[0] : completion;
    return typeof first === 'string' && profiles[first]?.adapter === 'typesafe';
  };
  const routing = new Set(); // tasks whose `auto` route is in flight: never dispatched a second time meanwhile
  // Every row the scheduler itself writes is stamped from the injected clock, not the journal's
  // own wall-clock default — the watchdog's `now` and every row `time` it compares against must
  // live on the same timeline. Under the default `clock = Date.now`, this is the same wall-clock
  // instant the journal would have picked anyway, so the real-clock path is byte-for-byte
  // unchanged; only the fake-clock path (tests) actually diverges from `new Date().toISOString()`.
  const stamp = () => new Date(clock()).toISOString();
  const append = event => {
    if (closed) return null;
    const submitted = event.task ? session.events.find(e => e.kind === 'task.submitted' && e.task === event.task) : null;
    const row = {...submitted && {jobId: submitted.jobId, campaignId: submitted.campaignId}, ...event, time: stamp()};
    if (row.kind === 'task.completed') {
      if (!submitted?.review?.completion && !publishArtifact(row.task, row)) return null;
      const actionId = `completion:${row.task}:${reducers.tasks(session.events)[row.task]?.attempt ?? 0}`;
      requestAction(session, {actionId, type: 'completion', task: row.task}, [row]);
      return session.events.findLast(e => e.kind === row.kind && e.task === row.task);
    }
    if (['task.failed', 'task.cancelled', 'task.deadline', 'task.accepted', 'task.rejected'].includes(row.kind)) {
      requestTerminal(row, [row]);
      return session.events.findLast(e => e.kind === row.kind && e.task === row.task);
    }
    return session.append(row);
  };
  const publish = event => closed ? null : session.publish({...event, time: stamp()});
  const localActivity = (task, attempt, context) => event => {
    if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state) || launchingAttempts.get(task)?.cancelReason) return;
    append({kind: 'task.milestone', task, attempt, phase: event.phase, text: String(event.text).slice(0, 2000), next: 'continue local worker', context});
  };

  // The one local-specific step of a dispatch: pick the model and build OpenCode's provider config.
  // Bounded by the task's own deadline (discovery may wait on a model being loaded on demand) and
  // cancellable while pending; after it, the worker is launched like any other.
  function reserveReviewSlot(profile, entry, signal) {
    const endpoint = profile.endpoint ?? 'lmstudio';
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', cancelled); };
      const cancelled = () => { cleanup(); reject(signal.reason ?? new Error('Review admission cancelled')); };
      const tryReserve = () => {
        if (signal.aborted) { cancelled(); return; }
        if (localRunning(endpoint) >= localSlots(endpoint)
          || localRunning(endpoint, profile.model) >= modelSlots(endpoint)) return;
        // Reserve synchronously before resolving: two release listeners cannot claim one slot.
        entry.local = endpoint;
        entry.model = profile.model;
        cleanup();
        resolve();
      };
      unsubscribe = session.subscribe(row => { if (row.kind === 'task.slot.released') tryReserve(); });
      signal.addEventListener('abort', cancelled, {once: true});
      tryReserve();
    });
  }

  function releaseReview(peer, entry, context) {
    if (reviews.get(peer) !== entry) return;
    reviews.delete(peer);
    if (!entry.local || closed) return;
    const released = append({kind: 'task.slot.released', task: entry.task,
      endpoint: entry.local, stage: 'review', from: peer, context});
    if (slotWaiters.size) queueMicrotask(() => wakeSlotWaiters(released.seq));
  }

  // A launch or resume that ends without adopting a handle stops counting against its local slot
  // (localRunning counts launchingAttempts): say so, with a fresh dispatch identity for waiters.
  // A launch whose process might still be running announces no release (`verified: false`),
  // and a report-only resume still inside its previous handle leaves the release to that handle.
  function abandonLaunch(task, context, {verified = true} = {}) {
    const launching = launchingAttempts.get(task);
    if (!launching) return null;
    launchingAttempts.delete(task);
    const endpoint = localEndpointOf(task);
    const cloud = !endpoint && Boolean(cloudAdapterOf(task));
    if ((!endpoint && !cloud) || !verified || closed || handles.has(task)) return launching;
    const released = append({kind: 'task.slot.released', task, attempt: launching.attempt, stage: 'launch', context, ...(endpoint ? {endpoint} : {cloud: true})});
    if (slotWaiters.size) queueMicrotask(() => wakeSlotWaiters(released.seq));
    return launching;
  }

  async function admitLocal(profile, task, attempt, context, launchState, {waitOnPressure = false} = {}) {
    const controller = new AbortController();
    const launching = launchState ?? launchingAttempts.get(task);
    launching.localController = controller;
    launching.phase = 'admission';
    const deadline = deadlineAtFor(task) ?? clock() + taskDeadlineMs(submittedRow(task));
    const timer = setTimeout(() => controller.abort(new Error('Local task deadline exceeded')), Math.max(1, deadline - clock()));
    try {
      if (launchState) await reserveReviewSlot(profile, launchState, controller.signal);
      const resolved = await localResolver.resolve({profile, signal: controller.signal,
        onStatus: text => append({kind: 'task.milestone', task, attempt, phase: 'admission', text, next: 'launch worker', context})});
      controller.signal.throwIfAborted();
      await admitMemory({profile: resolved, task, attempt, context, signal: controller.signal, waitOnPressure});
      controller.signal.throwIfAborted();
      launching.phase = 'launch';
      launching.requestedAt = clock();
      // Nothing ran before a launch fails, so the failure is always a verified non-start.
      return {profile: resolved, adapter: adapters[profile.adapter], signal: controller.signal, failed: () => true};
    } finally { clearTimeout(timer); }
  }

  // The memory gate, between resolving the model and launching it. Greedy by decision: the budget is
  // what is actually free. A machine bounce cannot read has no opinion and nothing below runs.
  async function admitMemory({profile, task, attempt, context, signal, waitOnPressure = false}) {
    const endpoint = profile.endpoint ?? 'lmstudio';
    const cfg = localEndpoint(endpoint);
    const reserve = Number.isFinite(cfg.reserveGb) ? cfg.reserveGb * 1024 ** 3 : DEFAULT_RESERVE_BYTES;
    const waitMs = (Number.isFinite(cfg.waitMinutes) ? cfg.waitMinutes : 10) * 60000;
    const pollMs = Number.isFinite(cfg.pollMs) ? cfg.pollMs : 5000;
    const startedAt = clock();
    let said = false, saidPressure = false, escalated = false;
    for (;;) {
      signal?.throwIfAborted();
      const machine = resources.read();
      if (!machine?.known) return;
      // Memory pressure (macOS's own verdict) is not waited out for new work: the machine is already too
      // slow, and the agent's next AI (the cloud) can take the task now. A report repair continues this
      // local session, which no other AI can, so it waits until the task's deadline.
      if (resources.underPressure()) {
        const level = pressureName(machine);
        if (!waitOnPressure) throw Object.assign(new Error(`the machine is under ${level} memory pressure: a local worker would make it worse`), {code: 'LOCAL_MEMORY_PRESSURE'});
        if (!saidPressure) { saidPressure = true; append({kind: 'task.milestone', task, attempt, phase: 'queued', next: 'repair the report when memory pressure eases', context,
          text: `Waiting for ${level} memory pressure to ease before repairing the report on ${endpoint}`}); }
        await new Promise(resolve => setTimeout(resolve, pollMs));
        continue;
      }
      const fleet = await localFleet({signal}).catch(() => null);
      if (!fleet) return;
      const busy = [...handles.keys()].filter(id => id !== task).map(id => localModelOf(id)).filter(Boolean);
      const resident = residentModels(fleet, busy);
      const size = sizeOf(fleet, endpoint, profile.model);
      const fit = fitLocal({sizeBytes: size, loaded: resident.some(row => row.model === profile.model), machine, resident, reserve});
      if (fit.ok) {
        for (const name of fit.unload ?? []) {
          const freed = resident.find(row => row.name === name)?.sizeBytes ?? 0;
          await unloadLocal(name);
          append({kind: 'local.unloaded', task, attempt, model: name, freed, context,
            text: `Unloaded idle ${name} (${gb(freed)}) to make room for ${profile.model} (${gb(size)}, ${gb(machine.available)} free)`});
        }
        return;
      }
      if (!said) { said = true; append({kind: 'task.milestone', task, attempt, phase: 'queued', next: 'dispatch when memory frees', context,
        text: `Waiting for memory on ${endpoint} for ${profile.model}: ${fit.reason}`}); }
      if (!escalated && clock() - startedAt >= waitMs) {
        escalated = true;
        append({kind: 'policy.escalated', task, reason: 'resources', to: submitterOf(task), context,
          text: `${profile.model} has waited ${Math.round((clock() - startedAt) / 60000)} min for memory on ${endpoint}: ${fit.reason}. It keeps waiting; cancel it, or send it to a cloud AI.`});
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  // Called only by the restricted report endpoint. The endpoint binds task/attempt from its
  // grant; this second check makes late reports from a replaced process harmless.
  function report({task, attempt, report: payload, from, context}) {
    const problem = validateReport(payload);
    if (problem) throw new Error(`malformed report: ${problem}`);
    const view = reducers.tasks(session.events);
    const current = view[task];
    if (session.events.some(event => event.kind === 'task.attempt.ended' && event.task === task && event.attempt === attempt)) throw new Error('stale report');
    const launching = launchingAttempts.get(task);
    if (launching?.attempt === attempt && current && current.attempt !== attempt && !reducers.TERMINAL.has(current.state)) {
      const staged = append({kind: 'task.report.staged', task, attempt, phase: payload.phase, text: payload.text, next: payload.next, report: structuredClone(payload), from: from ?? workerFrom(task), context: context ?? current.context});
      launching.reports.push({payload, from, context});
      return staged;
    }
    if (!current || current.attempt !== attempt || reducers.TERMINAL.has(current.state)) throw new Error('stale report');
    const event = reportEvent({task, attempt, report: payload, from: from ?? workerFrom(task), context: context ?? current.context});
    // Tagged here, not in reportEvent (reporting.js owns the vendor-facing shape, not scheduler
    // policy): a `reason` on the worker's own op:blocked is what lets a later message resume
    // this exact worker (T3c) instead of being mistaken for a review gate or an infra signal,
    // both of which also land as task.blocked with no reason of their own.
    append(event.kind === 'task.blocked' ? {...event, reason: 'worker_blocked'} : event);
    return event;
  }

  function finalizeReport({task, attempt, from, context}) {
    const final = session.events.findLast(e => e.kind === 'task.reported' && e.task === task && e.attempt === attempt);
    if (!final) return false;
    if (final.outcome === 'completed' && remainingWork(final.remaining)) {
      append({kind: 'task.report.invalid', task, attempt, report: final, diagnostic: 'report_incomplete', from, context});
      append({kind: 'task.blocked', task, reason: 'report_incomplete', text: final.remaining, from, context}); return true;
    }
    if (final.outcome === 'completed') append({kind: 'task.completed', task, summary: final.summary, artifacts: final.evidence, from, context});
    else if (final.outcome === 'failed') append({kind: 'task.failed', task, reason: 'reported_failure', text: final.summary, from, context});
    else if (final.outcome === 'blocked') append({kind: 'task.blocked', task, reason: 'worker_blocked', text: final.summary, from, context});
    else append({kind: 'task.input_required', task, text: final.summary, from, context});
    return true;
  }

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
    if ((spec.planId !== undefined || spec.chunkId !== undefined) && spec.jobId) {
      const admission = planTaskAdmission(session.events, spec);
      if (!admission.ok) return admission.reason;
    }
    if (spec.retryOf !== undefined && !view[spec.retryOf]) return 'retryOf';
    const previousTask = spec.retryOf ?? spec.replaces;
    if (previousTask && view[previousTask]?.state === 'blocked'
      && isReviewGate(session.events.findLast(e => e.task === previousTask && e.kind === 'task.blocked'))
      && candidateResult(session.events, previousTask)) return 'review gate unresolved; preserved candidate must be reviewed, not rerun — accept it (task.accepted with overrides and text) or send it back for rework (task.rework with text) instead';
    if (spec.campaignId) {
      const campaign = campaigns(session.events)[spec.campaignId];
      if (!campaign || campaign.state !== 'active') return 'campaign is not active';
      if (!spec.gate || !campaign.required.includes(spec.gate)) return 'campaign gate';
    }
    if (spec.jobId) {
      const previous = session.events.filter(e => e.kind === 'task.submitted' && e.jobId === spec.jobId);
      if (previous.length && !spec.replaces && !spec.retryOf) return 'job already exists; use retryOf';
    }
    if (spec.profile === AUTO_PROFILE ? !routingFallback(profiles) : !profiles[spec.profile]) return 'profile';
    if (spec.inPlace !== undefined) {
      // Structural check (docs/plans/in-place-tasks.md §1, always): the cited row must exist and
      // be a `user` row — only the keyboard path writes those, and bus.js already refuses `user`
      // from a peer, so a row that IS one was typed by the person, not asserted by any AI.
      const cited = inPlaceCitation(spec.inPlace);
      if (cited === null || !session.events.some(e => e.kind === 'user' && e.seq === cited)) return 'in_place_unauthorized';
      if (!Array.isArray(spec.requires) || !spec.requires.includes('write') || !spec.requires.includes('exec')) return 'in_place_requires';
      const profile = profiles[spec.profile];
      if (profile && effectivePolicy(profile) !== 'yolo') return 'in_place_ineligible_profile';
    }
    if (requireFinalReport && spec.from === 'orchestrator' && spec.requires === undefined) return 'requires: declare read, exec and/or write capabilities for this assignment';
    const requirementProblem = validateRequirements(spec.requires);
    if (requirementProblem) return requirementProblem;
    const requestedProfile = profiles[spec.profile];
    if (requestedProfile && missingCapabilities(requestedProfile, spec.requires).length) return `capability mismatch: ${missingCapabilities(requestedProfile, spec.requires).join(', ')} unavailable on ${spec.profile}; split analysis from command verification`;
    if (typeof spec.orders !== 'string' || !spec.orders) return 'orders';
    if (spec.deadline !== null && spec.deadline !== undefined && !Number.isFinite(spec.deadline)) return 'deadline';
    if (spec.parent != null && !view[spec.parent]) return 'parent';
    if (spec.budget !== undefined && spec.parent != null) return 'budget';
    if (spec.budget?.rounds !== undefined && !isNonNegativeInt(spec.budget.rounds)) return 'budget';
    if (spec.checkpoint != null && typeof spec.checkpoint !== 'object') return 'checkpoint';
    if (spec.risk !== undefined && !RISKS.has(spec.risk)) return 'risk';
    if (spec.owns !== undefined && !validOwns(spec.owns)) return 'owns';
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
          // A reviewer is whoever cannot change anything: by declared policy, not by the label it wears.
          if (!p || !(['read-only', 'probe'].includes(effectivePolicy(p)) || READONLY_ROLES.has(p.role))) return 'review';
        }
      }
    }
    if (strict && (!review || !review.prelaunch || !review.completion)) return 'review';
    const completionName = Array.isArray(review?.completion) ? review.completion[0] : review?.completion;
    const completionProfile = completionName && profiles[completionName];
    if (completionProfile?.role === 'verifier' && (typeof spec.steps !== 'string' || !spec.steps)) return 'steps';
    return null;
  };

  // Jev completion verdicts (src/jev.js): a root task submitted under the default strategy with
  // no completion reviewer of its own gets the daemon's read-only `jev` critic as
  // review.completion — decided when the row is journaled (here for submit(), and by the bus
  // through the exported `prepare` for a peer's task.submitted), so the reducer, `wait` and the
  // strategy all see an ordinary completion review. An explicit review.completion always wins;
  // with Jev disabled or off for review, the row is untouched and behaviour is exactly today's.
  // `inPlace: true` or `{}` cites the user's latest message (found live: an orchestrator had no seq to
  // cite and was refused twice); an explicit authorizedBy is taken as given. Null: nothing to cite.
  function inPlaceCitation(inPlace) {
    if (inPlace !== true && (!inPlace || typeof inPlace !== 'object')) return null;
    if (typeof inPlace?.authorizedBy === 'number') return inPlace.authorizedBy;
    return session.events.findLast(e => e.kind === 'user')?.seq ?? null;
  }

  function prepare(spec) {
    if (spec.inPlace !== undefined && inPlaceCitation(spec.inPlace) !== null) spec = {...spec, inPlace: {authorizedBy: inPlaceCitation(spec.inPlace)}};
    const predecessor = spec.retryOf ?? spec.replaces;
    const original = predecessor ? rawSubmittedRow(predecessor) : null;
    const activeCampaign = Object.values(campaigns(session.events)).filter(c => c.state === 'active');
    const campaignId = spec.campaignId ?? original?.campaignId ?? (activeCampaign.length === 1 ? activeCampaign[0].id : undefined);
    const task = spec.task ?? randomUUID();
    const jobId = original?.jobId ?? spec.jobId ?? (spec.planId && spec.chunkId ? `plan:${spec.planId}:${spec.chunkId}` : `job:${task}`);
    spec = {...spec, task, jobId, ...(campaignId ? {campaignId} : {}),
      ...(original ? {replaces: predecessor, retryOf: predecessor, parent: original.parent ?? null,
        deadline: original.deadline, requires: original.requires ?? spec.requires, budget: undefined, owns: original.owns, review: original.review ?? undefined,
        gate: original.gate, planId: original.planId, chunkId: original.chunkId, depends_on: original.depends_on ?? []} : {})};
    const reviewer = jev && profiles[jev.reviewer];
    if (!reviewer || reviewer.adapter !== 'typesafe' || !READONLY_ROLES.has(reviewer.role) || strategy !== defaultStrategy) return spec;
    if (spec.review?.completion) return spec;
    // An in-place task has no attempt diff for Jev to judge (found live: the verdict fell back to
    // git, `no_repository` in a plain folder); its report is verified by the orchestrator instead.
    if (spec.inPlace !== undefined) return spec;
    let settings;
    try { settings = jev.settings(); } catch { return spec; }
    if (!settings?.enabled || !settings.review) return spec;
    return {...spec, review: {...(spec.review ?? {}), completion: jev.reviewer}};
  }

  function submit(rawSpec) {
    if (rawSpec.ref) { const existing = session.events.find(e => e.kind === 'task.submitted' && e.ref === rawSpec.ref); if (existing) return existing; }
    const spec = prepare(rawSpec);
    const view = reducers.tasks(session.events);
    const problem = validate(spec, view);
    if (problem) throw new Error(`malformed: ${problem}`);
    const task = spec.task ?? randomUUID();
    const row = {
      kind: 'task.submitted', task,
      parent: spec.parent ?? null,
      from: spec.from,
      context: spec.context,
      profile: spec.profile,
      orders: spec.orders,
      ...(spec.requires !== undefined ? {requires: spec.requires} : {}),
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
      ...(spec.owns ? {owns: spec.owns} : {}),
      ...(spec.inPlace ? {inPlace: spec.inPlace} : {}),
      jobId: spec.jobId, retryOf: spec.retryOf, campaignId: spec.campaignId, gate: spec.gate, planId: spec.planId, chunkId: spec.chunkId,
    };
    requestAction(session, {actionId: `dispatch:${task}:0`, type: 'dispatch', task}, [{...row, time: stamp()}]);
    return rawSubmittedRow(task);
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

  // Why a worker could not be started — launched or resumed — as the reason the fallback walk reads.
  // A local model that cannot be resolved, a missing or unanswering vendor process, and a vendor
  // that refuses because the account is exhausted (codex-live tags that `limited`; its own text,
  // the reset time, rides along) all move the task to its next AI; anything else is an `error`.
  const startFailure = error => error.code?.startsWith('LOCAL_') ? {reason: 'local_unavailable', text: error.message}
    : error.code === 'missing' || error.code === 'backend_unavailable' ? {reason: error.code, ...(error.message && error.message !== error.code ? {text: error.message} : {})}
    : error.code === 'limited' ? {reason: 'limited', text: error.message}
    : {reason: 'error', text: error.message};

  const probeOrders = workspace => `Run commands in your current disposable workspace (${workspace.cwd}). Tests may write caches and output here; none of these changes are integrated into the source. Do not edit source files to make checks pass. Source checkout: ${workspace.source}. For original Git status/history use git --no-optional-locks -C ${JSON.stringify(session.cwd)}; the copy has no Git metadata. Report observed commands and results.`;
  // An isolated write worker works in a copy; orders that name the real checkout by absolute path would
  // send it there (observed live: a heredoc appended to the real file, the copy stayed unchanged and
  // review saw an empty diff). Paths into the checkout are rewritten to the copy, and the adapter fences
  // the checkout itself (`writeFence`).
  const toWorkingCopy = (text, workspace) => {
    const source = fs.realpathSync(session.cwd);
    // session.cwd is already resolved; macOS also spells /private/{var,tmp,etc} without the prefix.
    const spellings = [source, source.replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, '')];
    return [...new Set(spellings)].sort((a, b) => b.length - a.length)
      .reduce((value, root) => value.split(root).join(workspace.cwd), text);
  };
  const inWorkingCopy = (text, workspace) => {
    const source = fs.realpathSync(session.cwd);
    const rewritten = toWorkingCopy(text, workspace);
    return `${rewritten}\n\nYour working copy is ${workspace.cwd}: it is a copy of the project, and only changes made there are your work. Writes to the original checkout (${source}) are refused.`;
  };
  const workspaces = new Map();
  // Shared by workspaceFor and the integrate handler: the in-memory map first (same process,
  // possibly already advanced by a prior integration), then the persisted metadata written at
  // creation time (restart replay reads the same file, which advanceBaseline keeps current).
  function existingWorkspace(task) {
    const prior = workspaces.get(task) ?? workspaces.get(submittedRow(task)?.replaces);
    if (prior) return prior;
    const previous = session.events.findLast(e => e.kind === 'task.workspace' && (e.task === task || e.task === submittedRow(task)?.replaces));
    if (!previous) return null;
    const workspace = JSON.parse(fs.readFileSync(previous.metadata, 'utf8'));
    workspace.cwd = previous.cwd;
    return workspace;
  }
  function workspaceFor(task, profile, attempt) {
    if (effectivePolicy(profile) !== 'probe' && POLICY_RANK[effectivePolicy(profile)] < POLICY_RANK.write) return null;
    const prior = existingWorkspace(task);
    if (prior) {
      if (Boolean(prior.disposable) !== (effectivePolicy(profile) === 'probe')) throw new Error('workspace policy changed; submit a new scoped task');
      workspaces.set(task, prior); return {...prior, attemptId: `${task}-${attempt}`};
    }
    const relative = path.relative(fs.realpathSync(session.cwd), fs.realpathSync(session.dir));
    const nested = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    const dir = nested ? path.join(os.tmpdir(), 'bounce-workspaces', session.id, task) : path.join(session.dir, 'tasks', task);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const workspace = createAttemptWorkspace({cwd: session.cwd, dir, owns: submittedRow(task)?.owns?.length ? submittedRow(task).owns : ['**'], attemptId: `${task}-${attempt}`, disposable: effectivePolicy(profile) === 'probe'});
    workspaces.set(task, workspace);
    append({kind: 'task.workspace', task, attempt, purpose: workspace.disposable ? 'probe' : 'publish', cwd: workspace.cwd, metadata: path.join(workspace.cwd, '.attempt-workspace.json'), baselineHash: workspace.baselineHash});
    return workspace;
  }
  function artifactFor(task) {
    const row = session.events.findLast(e => e.kind === 'task.artifact' && e.task === task);
    return row ? {row, artifact: JSON.parse(fs.readFileSync(row.file, 'utf8'))} : null;
  }
  function publishArtifact(task, continuation) {
    const found = artifactFor(task);
    if (!found) return true;
    const {row, artifact} = found;
    if (session.events.some(e => e.kind === 'task.integrated' && e.task === task && e.artifactId === artifact.id)) return true;
    requestAction(session, {actionId: `integrate:${task}:${artifact.id}`, type: 'integrate', task,
      payload: {artifactId: artifact.id, file: row.file, dir: row.dir, continuation}},
    [{kind: 'task.integration.requested', task, artifactId: artifact.id, digest: artifact.digest, time: stamp()}]);
    return false;
  }

  // An owner's accept over an unconfident review gate closes the task the way a confident review does:
  // the isolated work integrates into the checkout first and the accepted row lands after it, or the
  // task blocks on the integration failure. Observed live: the row journaled directly left the task
  // blocked and its fix unintegrated.
  function acceptOverride(event) {
    const row = {...event, stage: 'completion', context: event.context ?? submittedRow(event.task)?.context};
    if (!publishArtifact(row.task, row)) return session.events.findLast(e => e.kind === 'task.integration.requested' && e.task === row.task);
    append(row);
    return session.events.findLast(e => e.kind === 'task.accepted' && e.task === row.task);
  }

  // Whether a rework round remains for this task's root, for the bus to refuse a hand-authored
  // task.rework before it spends anything (rework_rounds_exhausted).
  function roundsAvailable(task) { return api.roundsUsed(task) < api.roundsCap(task); }

  // The symmetric "send back": an owner's rework verdict over an unconfident review gate. This IS a
  // rework round in substance — the same effect a CONFIDENT Jev rework has (applyVerdictIntent's
  // 'rework' branch) — so it reserves the same budget and resumes the same worker through the same
  // resumeWorker(), just with the orchestrator's own findings instead of a reviewer's.
  function reworkOverride(event) {
    const task = event.task;
    const row = submittedRow(task);
    if (!row) return null;
    const context = event.context ?? row.context;
    const root = budgetRootOf(task, reducers.tasks(session.events));
    const round = api.roundsUsed(task) + 1;
    const findings = [event.text];
    append({kind: 'budget.reserved', task, root, amount: {rounds: 1}, context});
    append({kind: 'task.rework', task, round, findings, overrides: event.overrides, context});
    void resumeWorker({task, row, round, findings, context});
    return session.events.findLast(e => e.kind === 'task.rework' && e.task === task);
  }

  function maybeFallback(row) {
    if (session.events.some(e => e.kind === 'task.submitted' && e.replaces === row.task && e.task !== row.task)) return;
    if (!FALLBACK_REASONS.has(row.reason)) return;
    const view = reducers.tasks(session.events);
    const t = view[row.task];
    if (!t) return;
    // A task that has since gone terminal some other way (cancelled mid-flight, or already
    // replaced) never spawns a fallback on a late/racy result — only its own failure does.
    if (reducers.TERMINAL.has(t.state) && t.state !== 'failed' && !(row.reason === 'watchdog' && t.state === 'cancelled')) return;
    const profile = profiles[t.profile];
    if (!profile) return; // the profile this task ran under no longer exists: nothing to fall back from
    // Terminal notifications can be duplicated by a provider. One immutable attempt gets at
    // most one successor, even before its first replacement has had time to launch.
    if (session.events.some(e => e.kind === 'task.submitted' && e.replaces === row.task && e.task !== row.task)) return;
    const lineageRoot = lineageRootOf(row.task, view);
    const tried = new Set(lineageProfiles(lineageRoot, view));
    const deadline = deadlineAtFor(row.task);
    const budgetRoot = budgetRootOf(row.task, view);
    if ((deadline !== null && deadline <= clock()) || availableStarts(budgetRoot) <= 0) {
      append({kind: 'policy.fallback.skipped', task: row.task, reason: deadline !== null && deadline <= clock() ? 'deadline_exhausted' : 'budget_exhausted', text: 'No remaining recovery budget', context: row.context});
      return;
    }
    const maximumPolicy = POLICY_RANK[effectivePolicy(profiles[view[lineageRoot].profile])];
    const next = (profile.fallback ?? []).find(name => !tried.has(name) && profiles[name]
      && profiles[name].role !== 'orchestrator'
      && POLICY_RANK[effectivePolicy(profiles[name])] <= maximumPolicy && !policyRefusal(profiles[name])
      && !missingCapabilities(profiles[name], submittedRow(row.task)?.requires).length);
    if (!next) {
      const reason = profile.fallback?.length ? 'no_compatible_profile' : 'no_profile_configured';
      append({kind: 'policy.fallback.skipped', task: row.task, reason, text: reason === 'no_profile_configured' ? 'No fallback profile configured' : 'No untried fallback profile satisfies the task policy', context: submittedRow(row.task)?.context});
      return;
    }
    append({kind: 'policy.fallback', task: row.task, from_profile: t.profile, to_profile: next, reason: row.reason, ref: `fallback:${row.task}:${next}`});
    const original = submittedRow(row.task);
    const originalRef = submittedRow(lineageRoot)?.ref;
    submit({
      jobId: original.jobId, campaignId: original.campaignId, gate: original.gate, planId: original.planId, chunkId: original.chunkId,
      parent: original.parent, context: original.context, profile: next,
      orders: `${original.orders}\n\nRecovery from ${row.task}: ${row.reason}. ${row.text ?? ''}\nInspect existing work before continuing; do not repeat side effects blindly.\nLast progress: ${JSON.stringify(t.lastMilestone ?? null)}\nPartial report: ${JSON.stringify(session.events.findLast(event => event.kind === 'task.reported' && event.task === row.task) ?? null)}`,
      deadline: original.deadline,
      ...(original.requires ? {requires: original.requires} : {}),
      ...(original.depends_on?.length ? {depends_on: original.depends_on} : {}),
      ...(original.review ? {review: original.review} : {}), ...(original.steps ? {steps: original.steps} : {}),
      ...(original.checkpoint ? {checkpoint: original.checkpoint} : {}), ...(original.risk ? {risk: original.risk} : {}),
      ...(original.owns ? {owns: original.owns} : {}),
      ...(original.size ? {size: original.size} : {}), replaces: row.task, ref: `${originalRef ?? row.task}:fallback:${next}`,
    });
  }

  // A held task (queued behind an unaccepted depends_on) has no budget.reserved yet, so
  // re-running dispatch() on it is always safe: sizing/depth/profile/mode were already
  // satisfied the first time and cannot change, only the dependency's state can.
  // After a daemon restart (`--resume`): the constructor blocks unverified mid-flight tasks
  // as orphaned; what is left is dispatching the tasks that were queued but never launched
  // (dispatch only ever fires from a live task.submitted subscription, not from history).
  let recoveryPromise;
  function reconcile() {
    return recoveryPromise ??= reconcileState();
  }
  async function reconcileState() {
    effects.reconcile();
    // Older journals and a crash between an external peer row and its subscriber may
    // lack an intent. Reconstruct the obligation from the committed transition.
    for (const row of [...session.events]) {
      if (['task.failed', 'task.cancelled', 'task.deadline', 'task.accepted', 'task.rejected'].includes(row.kind)) requestTerminal(row);
      else if (row.kind === 'task.completed') requestAction(session, {actionId: `completion:${row.task}:${row.attempt ?? reducers.tasks(session.events)[row.task]?.attempt ?? 0}`, type: 'completion', task: row.task});
      else if (row.kind === 'plan.submitted') requestAction(session, {actionId: `plan:${row.plan}`, type: 'plan', payload: {plan: row.plan}, cause: row.seq});
    }
    // An isolated worker's unpublished files stay in its attempt workspace. An interrupted
    // integration resumes through its durable action and manifest. For a lost worker handle,
    // termination of the previous process is still unverified, so the task stays
    // blocked for inspection rather than being auto-recovered on a guarantee this design cannot make.
    for (const [task, t] of Object.entries(reducers.tasks(session.events))) {
      if (t.state !== 'queued' || handles.has(task) || heldTasks.has(task) || routing.has(task)) continue;
      const row = submittedRow(task);
      if (row) requestDispatch(row, `reconcile:${session.nextSeq}`);
    }
  }
  function wakeSlotWaiters(cause) {
    for (const task of [...slotWaiters]) {
      if (!reducers.tasks(session.events)[task] || reducers.tasks(session.events)[task].state !== 'queued') { slotWaiters.delete(task); continue; }
      const row = submittedRow(task);
      if (row) requestDispatch(row, cause);
    }
  }
  function reevaluateHeld() {
    for (const task of [...heldTasks]) {
      heldTasks.delete(task);
      const row = submittedRow(task);
      if (!row) continue;
      requestDispatch(row, session.events.findLast(e => TERMINAL_ROW_KINDS.has(e.kind))?.seq ?? 0);
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
      // This append nests inside the task.completed notification (the scheduler subscribed
      // before any bus wait, and nothing above awaited), so a `bounce wait` on the task sees
      // this task.accepted first, by subscriber order, and resolves with it: the bus's
      // `wait.served` names this row's seq, and main-service's pendingHandoffs() has nothing
      // later to announce.
      const accepted = {kind: 'task.accepted', task, stage: 'completion', by: 'strategy', context};
      if (publishArtifact(task, accepted)) append(accepted);
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
    for (const [index, spec] of hook.intent.submit.entries()) {
      try { submit({...spec, ref: spec.ref ?? `successor:${row.task}:${row.kind}:${row.seq}:${index}`}); }
      catch (error) { append({kind: 'policy.escalated', task: row.task, reason: 'invalid_successor', text: error.message, context: row.context}); }
    }
  }

  // Worker transcript stays live-only: journaling it as assistant/tool would leak into
  // handoff(), which filters by kind, not context. Quota rides on the vendor stream;
  // journaling the worker's raw lines with its provider lets recordQuota see them exactly as
  // it sees the main provider's. Shared by the initial launch and by a rework resume — a
  // review's own event consumption (runReview) is a narrower variant of the same switch.
  async function consumeWorkerEvents({adapter, handle, task, context, profile, owned = null}) {
    const from = workerFrom(task);
    let observedAt = -Infinity;
    try {
      for await (const event of adapter.events(handle)) {
        if (closed) return;
        if (requireFinalReport && ['tool', 'assistant', 'progress'].includes(event.kind) && clock() - observedAt >= 5000) {
          observedAt = clock();
          append({kind: 'task.observed', task, text: String(event.text ?? '').slice(0, 16000), source: event.kind, from, context});
        }
        switch (event.kind) {
          case 'activity': publish({kind: 'task.activity', task, text: event.text, source: event.kind, ...(typeof event.call === 'string' ? {call: event.call.slice(0, 300), change: event.change === true} : {}), from, context}); break;
          case 'assistant': recordFindings(task, event.text, context); publish({kind: 'task.activity', task, text: event.text, source: event.kind, from, context}); break;
          case 'tool': case 'progress': publish({kind: 'task.activity', task, text: event.text, source: event.kind, from, context}); break;
          case 'error': publish({kind: 'task.activity', task, text: `error: ${event.text}`, source: event.kind, from, context}); break;
          case 'status': publish({kind: 'task.activity', task, text: event.text, source: event.kind, from, context}); break;
          case 'delta': break; // streaming fragments; the assembled text arrives as 'assistant'
          case 'raw': append({kind: 'raw', raw: event.raw ?? null, provider: profile.adapter, task, from, context}); break;
          case 'model': append({kind: 'model', model: String(event.model), provider: profile.adapter, task, from, context}); break;
          case 'milestone': append({kind: 'task.milestone', task, text: event.text, evidence: event.evidence, from, context}); break;
          case 'blocked': append({kind: 'task.blocked', task, reason: 'worker_blocked', text: event.text, from, context}); break;
          case 'diagnostic': append({kind: 'task.diagnostic', task, text: String(event.text ?? '').slice(0, 2000), ...(event.reason ? {reason: event.reason} : {}), ...(event.phase ? {phase: event.phase} : {}), ...(event.toolsDisabled ? {toolsDisabled: true} : {}), from, context}); break;
          case 'usage': append({kind: 'task.usage', task, usage: event.usage, from, context}); break;
          case 'native': append({kind: 'peer.native', from, provider: event.provider, sessionId: event.sessionId, ...(event.cwd ? {cwd: event.cwd} : {}), context}); break;
          case 'jev': append({kind: `jev.${event.name}`, ...(event.data ?? {}), text: event.text, task, from, context}); break;
          case 'result':
            if (handles.get(task)?.handle !== handle || reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
            const rawText = String(event.text ?? '');
            const output = append({kind: 'task.output', task,
              attempt: reducers.tasks(session.events)[task]?.attempt, status: event.status,
              text: rawText, chars: rawText.length,
              digest: createHash('sha256').update(rawText).digest('hex'), from, context});
            // A terminal provider row is not a licence to overlap writers: prove the process
            // has exited before publishing a lifecycle event that can release dependents or
            // create a fallback. An unverifiable process stays visibly blocked.
            const stopped = await adapter.cancel(handle);
            if (closed) return;
            if (cancellationRequests.has(task)) return;
            if (stopped?.verified !== true) {
              append({kind: 'task.blocked', task, text: 'termination unverified', from, context});
              return;
            }
            if (handles.get(task)?.handle !== handle || reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
            // A report-only timer that stopped this same attempt already settled it.
            const endedAttempt = reducers.tasks(session.events)[task]?.attempt;
            if (session.events.some(e => e.kind === 'task.attempt.ended' && e.task === task && e.attempt === endedAttempt)) return;
            append({kind: 'task.attempt.ended', task, attempt: endedAttempt, verifiedTermination: true, from, context});
            if (owned && !owned.disposable) {
              const artifact = captureArtifact(owned);
              append({kind: 'task.artifact', task, attempt: reducers.tasks(session.events)[task]?.attempt,
                artifactId: artifact.id, digest: artifact.digest, resultHash: artifact.resultHash,
                file: path.join(owned.dir, 'artifacts', `${artifact.id}.json`), dir: owned.dir, cwd: owned.cwd, from, context});
              if (artifact.violations.length || artifact.unsupported.length) {
                append({kind: 'task.blocked', task, reason: artifact.violations.length ? 'ownership_violation' : 'artifact_unsupported',
                  text: `Isolated artifact cannot be integrated: ${JSON.stringify(artifact.violations.length ? artifact.violations : artifact.unsupported)}`, from, context});
                return;
              }
            }
            if (event.status === 'completed' && requireFinalReport) {
              const state = reducers.tasks(session.events)[task]?.state;
              const attempt = state ? reducers.tasks(session.events)[task]?.attempt : null;
              if (!finalizeReport({task, attempt, from, context}) && !reducers.TERMINAL.has(state) && state !== 'blocked' && state !== 'input_required') {
                // A worker's own final answer is the source of truth the moment no valid structured
                // report survives parsing: the model does the work and loses it at the hand-off far
                // more often than it fails the work itself (observed live, session 159f4746: 7/19
                // tasks ended `task.report.invalid missing_report` over a complete, usable prose
                // answer). Bounce synthesizes the report from that answer — merging in whatever valid
                // fields a malformed `bounce_report` call already carried — instead of spending a
                // repair turn asking the model to do the one thing it just failed to do. Only a
                // literally empty answer still needs a turn back, and it asks in plain words.
                const inspected = inspectFinalReport(event.text);
                const answer = String(event.text ?? '').trim();
                if (inspected.diagnostic === 'report_incomplete') {
                  append({kind: 'task.report.invalid', task, attempt, report: inspected.report, diagnostic: inspected.diagnostic, outputSeq: output.seq, from, context});
                  append({kind: 'task.blocked', task, reason: 'report_incomplete', text: inspected.report.remaining, from, context});
                } else if (!inspected.diagnostic) {
                  append(reportEvent({task, attempt, report: inspected.report, from, context}));
                  finalizeReport({task, attempt, from, context});
                } else if (answer) {
                  const synthesis = synthesizeReport(answer, inspected.report);
                  const problem = validateReport(synthesis.report);
                  if (problem) throw new Error(`synthesized report invalid: ${problem}`);
                  append({kind: 'task.report.invalid', task, attempt, report: inspected.report, diagnostic: inspected.diagnostic, outputSeq: output.seq, from, context});
                  append({kind: 'task.report.synthesized', task, attempt, rule: synthesis.rule, sources: synthesis.sources, outputSeq: output.seq, from, context});
                  append(reportEvent({task, attempt, report: synthesis.report, from, context}));
                  finalizeReport({task, attempt, from, context});
                } else {
                  append({kind: 'task.report.invalid', task, attempt, report: inspected.report, diagnostic: inspected.diagnostic, outputSeq: output.seq, from, context});
                  await requestPlainAnswer({task, attempt, context, adapter});
                }
              }
            } else if (event.status === 'completed') append({kind: 'task.completed', task, summary: event.text, from, context});
            else {
              // An adapter marks a failure of its RUNTIME (process died, endpoint down, no answer) as
              // recoverable: the same job may run on the next AI in the chain. A worker that did the
              // work and failed it on its merits is not.
              const reason = event.status === 'limited' ? 'limited' : event.recoverable === true ? 'worker_runtime' : 'error';
              append({kind: 'task.failed', task, reason, text: event.text, from, context});
            }
            return;
        }
      }
      // A closed event stream cannot produce more progress. Settle it now instead of
      // leaving a running task with no handle until the silence watchdog eventually fires.
      if (closed || cancellationRequests.has(task) || handles.get(task)?.handle !== handle) return;
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
      const stopped = await adapter.cancel(handle).catch(() => ({verified: false}));
      if (closed || cancellationRequests.has(task) || handles.get(task)?.handle !== handle) return;
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
      // A worker that already said it is blocked or needs input keeps that answer once its
      // process is proven gone, exactly as a result with that outcome does.
      if (stopped?.verified === true && ['blocked', 'input_required'].includes(reducers.tasks(session.events)[task]?.state)) return;
      append(stopped?.verified === true
        ? {kind: 'task.failed', task, reason: 'worker_runtime', text: 'Worker event stream ended without a terminal result', from, context}
        : {kind: 'task.blocked', task, reason: 'termination_unverified', text: 'termination unverified', from, context});
    } catch (error) {
      // A broken adapter stream (or anything else unexpected past this point) must never
      // escape the subscriber as an unhandled rejection: it becomes this task's own failure.
      const stopped = await adapter.cancel(handle).catch(() => ({verified: false}));
      if (handles.get(task)?.handle !== handle) return;
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
      if (stopped?.verified === true) append({kind: 'task.failed', task, reason: 'error', text: error.message, from, context});
      else append({kind: 'task.blocked', task, text: 'termination unverified', from, context});
    } finally {
      if (reducers.tasks(session.events)[task]?.blocker !== 'termination unverified') dropHandle(task, handle, context);
    }
  }

  // The worker answered but its report cannot be repaired: the answer is the outcome to decide on, so the
  // task blocks on it (quoted, with where to read it whole) rather than failing as if nothing came back.
  function repairUnavailable(task, reason, context) {
    const output = session.events.findLast(e => e.kind === 'task.output' && e.task === task && e.status === 'completed' && e.text?.trim());
    const flat = output ? output.text.replace(/\s+/g, ' ').trim() : '';
    const answer = output ? `The worker answered (${output.chars} chars, output seq ${output.seq}): "${flat.length > 240 ? `${flat.slice(0, 240)}…` : flat}". ` : '';
    append({kind: 'task.blocked', task, reason: 'report_repair_unavailable', from: workerFrom(task), context,
      text: `${answer}Its report could not be repaired: ${String(reason).replace(/\.$/, '')}. Read it with task_get full; accept it, resubmit it, or continue it on a cloud AI if the user agrees.`});
  }

  // Capacity release is distinct from task completion: blocked/input-required results also free a
  // slot. Each release must get a fresh dispatch identity.
  function dropHandle(task, handle, context) {
    const entry = handles.get(task);
    if (entry?.handle !== handle) return;
    handles.delete(task);
    if ((!entry.local && !entry.cloud) || closed) return;
    const released = append({kind: 'task.slot.released', task,
      attempt: reducers.tasks(session.events)[task]?.attempt, context, ...(entry.local ? {endpoint: entry.local} : {cloud: true})});
    if (slotWaiters.size) queueMicrotask(() => wakeSlotWaiters(released.seq));
  }

  // Only reached once (consumeWorkerEvents): the worker's final turn ended with no text at all, so
  // there is nothing to synthesize a report from. One turn back, asked in plain words — never the
  // JSON schema again, which is the instruction the worker just failed to follow. A second empty
  // answer, or no way to ask again, blocks on it rather than failing the task for its formatting.
  async function requestPlainAnswer({task, attempt, context, adapter}) {
    const jobId = submittedRow(task)?.jobId;
    const previous = session.events.some(event => event.kind === 'task.report_requested' && (jobId ? event.jobId === jobId : event.task === task));
    const root = budgetRootOf(task, reducers.tasks(session.events));
    const remaining = reducers.budgets(session.events).roots[root]?.remaining?.starts;
    const deadline = deadlineAtFor(task);
    const native = session.events.findLast(event => event.kind === 'peer.native' && event.from === workerFrom(task));
    if (!previous) append({kind: 'task.report_requested', task, attempt, text: 'The worker gave no answer at all; asking once more, in plain words', diagnostic: 'no_answer', context});
    if (previous) {
      repairUnavailable(task, 'the worker gave no answer, twice in a row', context);
      return;
    }
    if (!adapter.resume || !native || remaining === 0 || (deadline !== null && deadline <= clock())) {
      repairUnavailable(task, 'the worker gave no answer, and no resumable session, start allowance or deadline remains', context);
      return;
    }
    append({kind: 'budget.reserved', task, root, amount: {starts: 1}, context});
    await resumeWorker({task, row: submittedRow(task), context, reportOnly: true, findings: [], round: 0});
  }

  // Reserve the worker's own start and launch it: the tail shared by a plain dispatch and by
  // an accepted prelaunch review. Sizing/depth/profile/mode/depends_on/budget/checkpoint were
  // already checked by the caller.
  async function launchWorker(row, {reserve = true} = {}) {
    const {task, context} = row;
    if (!campaignActive(task) && !await waitForCampaign(task)) return;
    if (!admitAttempt(task, context)) return;
    const root = budgetRootOf(task, reducers.tasks(session.events));
    // `reserve: false` means the caller (dispatch) already made this reservation, synchronously,
    // before its own first await (§4) — never reserve twice for the same start.
    if (reserve) append({kind: 'budget.reserved', task, root, amount: {starts: 1}, context});

    const dir = path.join(session.dir, 'tasks', task);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const baseProfile = profiles[row.profile];
    const attempt = session.events.filter(e => e.kind === 'task.started' && e.task === task).length + 1;
    launchingAttempts.set(task, {attempt, reports: [], requestedAt: clock()});
    // This is the sole capability injected into a worker environment. It is minted before
    // launch, bound to one immutable attempt, and is not the ambient orchestration grant.
    const reportEnv = reportGrant?.({task, attempt, context});
    let profile = reportEnv ? {...baseProfile, report: reportEnv} : baseProfile;
    let adapter = adapters[profile.adapter];
    let admission;
    let handle, owned = null;
    try {
      if (LOCAL_ADAPTERS.has(profile.adapter) && profile.backend === 'lmstudio') {
        admission = await admitLocal(profile, task, attempt, context);
        ({profile, adapter} = admission);
        resolvedLocalProfiles.set(task, profile);
        append({kind: 'task.local_selected', task, attempt, selection: profile.localResolved, policy: profile.policy, context});
      }
      // OpenCode runs the worker AS its role agent (system prompt, step cap); every other adapter
      // gets the role's prompt ahead of the orders instead, so the role means the same thing whoever
      // answers the dispatch.
      const roleLead = profile.agent?.prompt && profile.adapter !== 'opencode' ? `${profile.agent.prompt}\n\n---\n\n` : '';
      // Prefer the acknowledged report endpoint, including OpenCode's dedicated MCP tool.
      // Final-answer parsing remains a compatibility path for workers without a grant.
      const canReport = Boolean(reportEnv);
      let workerOrders = canReport ? `${roleLead}${row.orders}\n\n${reportContract(profile)}`
        : LOCAL_ADAPTERS.has(profile.adapter) ? `${roleLead}${row.orders}\n\n${LOCAL_REPORT_LINE}` : `${roleLead}${row.orders}`;
      if (!campaignActive(task) && !await waitForCampaign(task)) { abandonLaunch(task, context); return; }
      // An in-place task's worker runs directly in session.cwd: no attempt workspace, no
      // writeFence (docs/plans/in-place-tasks.md §3) — `owned` stays null, so the ordinary
      // cwd/orders fallbacks below already do the right thing with no further branching.
      owned = row.inPlace ? null : workspaceFor(task, profile, attempt);
      if (owned?.disposable) profile = {...profile, probeSource: fs.realpathSync(session.cwd)};
      else if (owned) profile = {...profile, writeFence: fs.realpathSync(session.cwd)};
      // OpenCode takes the agent text as its system prompt, apart from the orders (found live: an agent
      // file naming the checkout sent a local worker to write there); it points into the copy too.
      if (owned && profile.agent?.prompt) profile = {...profile, agent: {...profile.agent, prompt: toWorkingCopy(profile.agent.prompt, owned)}};
      append({kind: 'task.launch.requested', task, attempt, executionKey: `${task}:${attempt}`, context});
      handle = await adapter.launch({peer: workerFrom(task), profile, orders: owned?.disposable ? `${workerOrders}\n\n${probeOrders(owned)}` : owned ? inWorkingCopy(workerOrders, owned) : workerOrders, cwd: owned?.cwd ?? session.cwd, dir,
        task, attempt, context, signal: admission?.signal,
        onActivity: LOCAL_ADAPTERS.has(profile.adapter) ? localActivity(task, attempt, context) : undefined,
        report: requireFinalReport ? ({report: payload}) => report({task, attempt, context, report: payload}) : undefined});
      if (closed) { await adapter.cancel(handle); return; }
    } catch (error) {
      const verified = admission ? admission.failed(error) : true;
      // The reservation this launch was going to consume never ran a process: release it (§4).
      append({kind: 'budget.released', task, root, amount: {starts: 1}, text: error.code ?? error.message, context});
      const cancelled = abandonLaunch(task, context, {verified})?.cancelReason;
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
      if (cancelled) {
        append({kind: verified ? 'task.cancelled' : 'task.blocked', task, reason: verified ? cancelled : 'termination_unverified', text: verified ? 'Pending launch cancelled' : 'termination unverified after cancelled launch', from: workerFrom(task), context});
        return;
      }
      append({kind: 'task.failed', task, ...startFailure(error), from: workerFrom(task), context});
      return;
    }
    // The task may have been cancelled (or otherwise gone terminal) while launch() was
    // pending: don't adopt it as live, just shut down the now-unwanted process.
    if (launchingAttempts.get(task)?.cancelReason || reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) {
      handles.set(task, {adapter, handle, ...(LOCAL_ADAPTERS.has(profile.adapter) ? {local: profile.endpoint ?? 'lmstudio'} : CLOUD_ADAPTERS.has(profile.adapter) ? {cloud: true} : {})});
      const reason = launchingAttempts.get(task)?.cancelReason ?? 'user';
      launchingAttempts.delete(task);
      // Nothing consumes this handle's events, so its slot is given back here once it is stopped.
      if (await cancelOne(task, reducers.tasks(session.events), reason)) dropHandle(task, handle, context);
      return;
    }
    handles.set(task, {adapter, handle, ...(LOCAL_ADAPTERS.has(profile.adapter) ? {local: profile.endpoint ?? 'lmstudio'} : CLOUD_ADAPTERS.has(profile.adapter) ? {cloud: true} : {})});
    append({kind: 'peer.joined', name: workerFrom(task), role: 'worker', adapter: profile.adapter, profile: row.profile, from: workerFrom(task), context});
      append({kind: 'task.started', task, attempt, requested: profile.model ?? '', ...(attempt === 1 && jevReviewed(row) ? {head: gitHead(session.cwd)} : {}), from: workerFrom(task), context});
    for (const staged of launchingAttempts.get(task)?.reports ?? []) report({task, attempt, report: staged.payload, from: staged.from, context: staged.context});
    launchingAttempts.delete(task);
    publish({kind: 'task.activity', task, text: 'Worker started · waiting for first activity', startup: true, from: workerFrom(task), context});
    await consumeWorkerEvents({adapter, handle, task, context, profile, owned});
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

  async function resumeWorker({task, row, round, findings, context, reportOnly = false}) {
    if (!campaignActive(task) && !await waitForCampaign(task)) return;
    if (!admitAttempt(task, context, {reportOnly})) {
      append({kind: 'budget.released', task, root: budgetRootOf(task, reducers.tasks(session.events)), amount: reportOnly ? {starts: 1} : {rounds: 1}, text: 'attempt admission refused', context});
      return;
    }
    const baseProfile = resolvedLocalProfiles.get(task) ?? profiles[row.profile];
    const attempt = session.events.filter(e => e.kind === 'task.started' && e.task === task).length + 1;
    launchingAttempts.set(task, {attempt, reports: [], requestedAt: clock()});
    const reportEnv = reportGrant?.({task, attempt, context});
    let profile = reportEnv ? {...baseProfile, report: reportEnv} : baseProfile;
    const dir = path.join(session.dir, 'tasks', task);
    const nativeRow = session.events.filter(e => e.kind === 'peer.native' && e.from === workerFrom(task)).at(-1);
    const native = nativeRow ? {provider: nativeRow.provider, sessionId: nativeRow.sessionId, ...(nativeRow.cwd ? {cwd: nativeRow.cwd} : {})} : {};
    const pending = reportOnly ? [] : pendingMessages(task);
    // reportOnly is only ever requestPlainAnswer's turn back after a literally empty answer
    // (scheduler.js): ask in plain words, never the JSON schema the worker just failed to use —
    // any non-empty answer, however malformed, is synthesized straight from the log instead.
    let message = reportOnly
      ? 'Your last turn ended with no answer at all. Say in plain words: what you did, whether it is done, and what is left. No JSON, no particular format — a plain answer is enough.'
      : [`Rework round ${round}:`, ...findings.map(f => `- ${f}`), ...pending.map(m => m.text)].join('\n');
    let adapter = adapters[profile.adapter];
    let admission;
    let handle, owned = null;
    try {
      if (LOCAL_ADAPTERS.has(profile.adapter) && profile.backend === 'lmstudio') {
        admission = await admitLocal(profile, task, attempt, context, undefined, {waitOnPressure: reportOnly});
        ({profile, adapter} = admission);
      }
      if (!campaignActive(task) && !await waitForCampaign(task)) { abandonLaunch(task, context); return; }
      // An in-place task's worker runs directly in session.cwd: no attempt workspace, no
      // writeFence (docs/plans/in-place-tasks.md §3) — `owned` stays null, so the ordinary
      // cwd/orders fallbacks below already do the right thing with no further branching.
      owned = row.inPlace ? null : workspaceFor(task, profile, attempt);
      if (owned?.disposable) profile = {...profile, probeSource: fs.realpathSync(session.cwd)};
      else if (owned) profile = {...profile, writeFence: fs.realpathSync(session.cwd)};
      // OpenCode takes the agent text as its system prompt, apart from the orders (found live: an agent
      // file naming the checkout sent a local worker to write there); it points into the copy too.
      if (owned && profile.agent?.prompt) profile = {...profile, agent: {...profile.agent, prompt: toWorkingCopy(profile.agent.prompt, owned)}};
      append({kind: 'task.launch.requested', task, attempt, executionKey: `${task}:${attempt}`, resumed: true, context});
      if (owned?.disposable) message = `${message}\n\n${probeOrders(owned)}`;
      else if (owned) message = inWorkingCopy(message, owned);
      // A reportOnly turn asks in plain words on purpose (requestPlainAnswer): the JSON schema
      // reminder below is for every OTHER resume, never appended onto that one turn back.
      handle = await adapter.resume({peer: workerFrom(task), profile, native, message: reportOnly ? message : reportEnv ? `${message}\n\n${reportContract(profile)}` : LOCAL_ADAPTERS.has(profile.adapter) ? `${message}\n\n${LOCAL_REPORT_LINE}` : message, cwd: owned?.cwd ?? session.cwd, dir, checkpoint: row.checkpoint,
        task, attempt, context, signal: admission?.signal,
        onActivity: LOCAL_ADAPTERS.has(profile.adapter) ? localActivity(task, attempt, context) : undefined,
        report: requireFinalReport ? ({report: payload}) => report({task, attempt, context, report: payload}) : undefined});
      if (closed) { await adapter.cancel(handle); return; }
    } catch (error) {
      const verified = admission ? admission.failed(error) : true;
      // The rework round's own reservation (`{rounds: 1}`, made by the caller before this
      // resume) never ran a turn: release it (§4).
      const root = budgetRootOf(task, reducers.tasks(session.events));
      append({kind: 'budget.released', task, root, amount: reportOnly ? {starts: 1} : {rounds: 1}, text: error.message, context});
      const cancelled = abandonLaunch(task, context, {verified})?.cancelReason;
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
      if (cancelled) {
        append({kind: verified ? 'task.cancelled' : 'task.blocked', task, reason: verified ? cancelled : 'termination_unverified', text: verified ? 'Pending resume cancelled' : 'termination unverified after cancelled resume', from: workerFrom(task), context});
        return;
      }
      // A worker that cannot be RESUMED is classified exactly as one that cannot be launched, so the
      // task's next AI is tried. It used to be a bare `error`, which no fallback follows (found live:
      // a codex thread/resume timed out after a Jev rework and the session stopped).
      if (reportOnly) { repairUnavailable(task, error.message, context); return; }
      append({kind: 'task.failed', task, ...startFailure(error), from: workerFrom(task), context});
      return;
    }
    // A resume that resolves is deemed to have delivered every message it folded in: journal
    // 'next-turn' for each, right after the resume resolves, so a later round's fold (which
    // only re-picks messages whose LATEST delivery is still 'queued') never re-sends it (A2).
    // A throwing resume (the branch above) journals none of this — nothing was delivered.
    for (const m of pending) append({kind: 'task.delivered', task, tier: 'next-turn', message: m.id, text: `rework round ${round}`, from: 'bounce', context});
    if (launchingAttempts.get(task)?.cancelReason || reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) {
      handles.set(task, {adapter, handle, ...(LOCAL_ADAPTERS.has(profile.adapter) ? {local: profile.endpoint ?? 'lmstudio'} : CLOUD_ADAPTERS.has(profile.adapter) ? {cloud: true} : {})});
      const reason = launchingAttempts.get(task)?.cancelReason ?? 'user';
      launchingAttempts.delete(task);
      // Nothing consumes this handle's events, so its slot is given back here once it is stopped.
      if (await cancelOne(task, reducers.tasks(session.events), reason)) dropHandle(task, handle, context);
      return;
    }
    handles.set(task, {adapter, handle, ...(LOCAL_ADAPTERS.has(profile.adapter) ? {local: profile.endpoint ?? 'lmstudio'} : CLOUD_ADAPTERS.has(profile.adapter) ? {cloud: true} : {})});
    append({kind: 'task.started', task, attempt, resumed: true, ...(reportOnly ? {purpose: 'report'} : {}), requested: profile.model ?? '', from: workerFrom(task), context});
    for (const staged of launchingAttempts.get(task)?.reports ?? []) report({task, attempt, report: staged.payload, from: staged.from, context: staged.context});
    launchingAttempts.delete(task);
    const attemptEnded = () => session.events.some(e => e.kind === 'task.attempt.ended' && e.task === task && e.attempt === attempt);
    const reportTimer = reportOnly ? setTimeout(async () => {
      if (handles.get(task)?.handle !== handle) return;
      const stopped = await adapter.cancel(handle).catch(() => ({verified: false}));
      if (handles.get(task)?.handle !== handle || reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state) || attemptEnded()) return;
      if (stopped?.verified !== true) { append({kind: 'task.blocked', task, text: 'termination unverified', context}); return; }
      // A report acknowledged before the timer fired is the answer this turn was asked for; the
      // attempt ends first, so no later report from it can be accepted.
      append({kind: 'task.attempt.ended', task, attempt, verifiedTermination: true, from: workerFrom(task), context});
      if (finalizeReport({task, attempt, from: workerFrom(task), context})) return;
      append({kind: 'task.failed', task, reason: 'incomplete_report', text: 'Final report request timed out; original worker output is preserved; use task_get full.', context});
    }, Math.max(1, Math.min(watchdogConfig.reportOnly, (deadlineAtFor(task) ?? (clock() + watchdogConfig.reportOnly)) - clock()))) : null;
    try { await consumeWorkerEvents({adapter, handle, task, context, profile, owned}); }
    finally { clearTimeout(reportTimer); }
  }

  // T3c: a message answering a worker's OWN blocked/input-required state resumes that worker
  // directly instead of sitting queued forever; a review gate or infra/termination reason still needs a human verdict.
  const RESUMABLE_BLOCK_REASONS = new Set(['worker_blocked', 'report_incomplete']);
  function ownBlockResumable(task) {
    const t = reducers.tasks(session.events)[task];
    if (!t) return false;
    if (t.state === 'input_required') return true; // only ever worker-authored (no other kind of row uses it)
    if (t.state !== 'blocked') return false;
    return RESUMABLE_BLOCK_REASONS.has(session.events.findLast(e => e.kind === 'task.blocked' && e.task === task)?.reason);
  }

  // Why the worker couldn't be resumed, for the orchestrator: the message itself is already
  // visible as `task.delivered` tier 'queued' — this is the part that would otherwise be silent.
  function blockedResumeUnavailable(task, reason, context) {
    append({kind: 'policy.escalated', task, reason: 'blocked_message_unresumable', context,
      text: `A message answering task ${task}'s blocked/input-required state could not resume its worker (${reason}); the message stays queued until a rework round or resubmission.`});
  }

  // `resumingBlocked` is claimed synchronously before the first await, so a second message in the
  // next microtask observes the claim and folds into this one resume instead of starting a second.
  const resumingBlocked = new Set();
  async function resumeOnMessage(task, context) {
    if (handles.has(task) || resumingBlocked.has(task) || !ownBlockResumable(task)) return;
    resumingBlocked.add(task);
    try {
      await deliveryTails.get(task); // wait out every delivery already enqueued for this task
      if (!ownBlockResumable(task)) return; // settled (or already resumed) while we waited
      const row = submittedRow(task);
      if (!row) return;
      const native = session.events.findLast(e => e.kind === 'peer.native' && e.from === workerFrom(task));
      const adapter = adapters[(resolvedLocalProfiles.get(task) ?? profiles[row.profile])?.adapter];
      const deadline = deadlineAtFor(task);
      if (!adapter?.resume || !native) { blockedResumeUnavailable(task, 'no resumable native session', context); return; }
      if (deadline !== null && deadline <= clock()) { blockedResumeUnavailable(task, 'task deadline has passed', context); return; }
      if (!(api.roundsUsed(task) < api.roundsCap(task))) { blockedResumeUnavailable(task, 'no round budget remains', context); return; }
      // This IS a rework round in substance — another turn on the same worker, triggered by a
      // message instead of a review verdict — so it reserves the same budget applyVerdictIntent does.
      const root = budgetRootOf(task, reducers.tasks(session.events));
      const round = api.roundsUsed(task) + 1;
      append({kind: 'budget.reserved', task, root, amount: {rounds: 1}, context});
      await resumeWorker({task, row, round, findings: [], context});
    } finally {
      resumingBlocked.delete(task);
    }
  }

  // A review worker: read-only, never journals task.activity's siblings as anything but
  // live activity, never emits task.completed/task.failed — only review.started/finished,
  // ending in a verdict the caller (prelaunch/completion policy) acts on. The handle lives in
  // its own `reviews` map (A3, separate from a worker's `handles`) for the window between
  // launch and the stream ending, so cancel()/stop() can reach it; a throwing stream (A4) ends
  // the same way a broken worker stream does — unreadable, handle cancelled, never left open.
  async function runReview({task, stage, round, profileName, profile, orders, dir, context, peer = reviewFrom(task), review = {stage, round, orders}}) {
    if (!campaignActive(task) && !await waitForCampaign(task)) return {verdict: 'unreadable', cancelled: true};
    append({kind: 'review.started', task, stage, round, profile: profileName, candidateSeq: review.candidateSeq ?? null, candidateDigest: review.candidateDigest ?? null, from: peer, context});
    let adapter = adapters[profile.adapter];
    let admission;
    const launchState = {task, pending: true, requestedAt: clock()};
    reviews.set(peer, launchState);
    let handle, owned = null;
    try {
      if (LOCAL_ADAPTERS.has(profile.adapter)) {
        reviews.set(peer, launchState);
        admission = await admitLocal(profile, task, round, context, launchState);
        ({profile, adapter} = admission);
      }
      if (!campaignActive(task) && !await waitForCampaign(task)) {
        releaseReview(peer, launchState, context);
        return {verdict: 'unreadable', cancelled: true};
      }
      const captured = artifactFor(task);
      const workerProfile = profiles[submittedRow(task)?.profile];
      const reportOnly = stage === 'completion' && workerProfile && POLICY_RANK[effectivePolicy(workerProfile)] < POLICY_RANK.write;
      const reviewState = captured ? {orders: review.orders, report: review.report, diff: captured.artifact.diff, files: captured.artifact.files, baseHead: captured.artifact.baselineHash}
        : reportOnly ? {kind: 'report', orders: review.orders, report: review.report, diff: '', files: [], baseHead: null} : null;
      if (effectivePolicy(profile) === 'probe') {
        const source = captured?.row.cwd ?? session.cwd;
        const probeDir = path.join(os.tmpdir(), 'bounce-review-workspaces', session.id, task);
        fs.mkdirSync(probeDir, {recursive: true, mode: 0o700});
        owned = createAttemptWorkspace({cwd: source, dir: probeDir, owns: ['**'], attemptId: `review-${stage}-${round}`, disposable: true});
        profile = {...profile, probeSource: fs.realpathSync(source)};
        orders = `${orders}\n\n${probeOrders(owned)}`;
      }
      handle = await adapter.launch({peer, profile, orders, cwd: owned?.cwd ?? captured?.row.cwd ?? session.cwd, dir, task, attempt: round, context, signal: admission?.signal, review, reviewState});
      if (closed) { await adapter.cancel(handle); releaseReview(peer, launchState, context); return {verdict: 'unreadable', cancelled: true}; }
      if (launchState.cancelReason) {
        const stopped = await adapter.cancel(handle);
        if (stopped?.verified === true) releaseReview(peer, launchState, context);
        else reviews.set(peer, {adapter, handle, task, local: launchState.local, model: launchState.model});
        append({kind: stopped?.verified === true ? 'task.cancelled' : 'task.blocked', task, reason: stopped?.verified === true ? launchState.cancelReason : 'termination_unverified', text: 'Pending review cancelled', from: peer, context});
        return {verdict: 'unreadable', cancelled: true};
      }
    } catch (error) {
      const verified = admission ? admission.failed(error) : true;
      releaseReview(peer, launchState, context);
      if (launchState.cancelReason) {
        append({kind: verified ? 'task.cancelled' : 'task.blocked', task, reason: verified ? launchState.cancelReason : 'termination_unverified', text: verified ? 'Pending review cancelled' : 'termination unverified after cancelled review', from: peer, context});
        return {verdict: 'unreadable', cancelled: true, launchFailed: true};
      }
      append({kind: 'review.finished', task, stage, round, verdict: 'unreadable', text: error.message, from: peer, context});
      // launchFailed marks that no process ever ran: the caller releases the start it
      // reserved for this review (§4) — unlike an unreadable verdict from a review that did run.
      return {verdict: 'unreadable', launchFailed: true};
    }
    // Keyed by peer (not task): the CORE runs multi-reviewer rounds one reviewer at a time
    // (CONTRACT §5), so at most one entry per task ever exists at once — for the single-
    // reviewer default this key IS `review:${task}`, byte-identical to before Phase 8.
    const reviewEntry = {adapter, handle, task, local: launchState.local, model: launchState.model};
    reviews.set(peer, reviewEntry);
    let resultStatus = null, resultText = null, streamError = null;
    try {
      for await (const event of adapter.events(handle)) {
        if (closed) return {verdict: 'unreadable', cancelled: true};
        switch (event.kind) {
          case 'milestone': append({kind: 'task.milestone', task, text: event.text, evidence: event.evidence, from: peer, context}); break;
          case 'usage': append({kind: 'task.usage', task, usage: event.usage, from: peer, context}); break;
          case 'raw': append({kind: 'raw', raw: event.raw ?? null, provider: profile.adapter, task, from: peer, context}); break;
          case 'model': append({kind: 'model', model: String(event.model), provider: profile.adapter, task, from: peer, context}); break;
          case 'native': append({kind: 'peer.native', from: peer, provider: event.provider, sessionId: event.sessionId, ...(event.cwd ? {cwd: event.cwd} : {}), context}); break;
          // A decision-model reviewer's own rows (jev.verdict / jev.skipped): the answer, never the request.
          case 'jev': append({kind: `jev.${event.name}`, ...(event.data ?? {}), text: event.text, task, from: peer, context}); break;
          case 'activity': case 'assistant': case 'tool': case 'progress': case 'diagnostic': case 'status':
            publish({kind: 'task.activity', task, text: event.text, from: peer, context}); break;
          case 'error': publish({kind: 'task.activity', task, text: `error: ${event.text}`, from: peer, context}); break;
          case 'delta': break;
          case 'result': resultStatus = event.status; resultText = event.text; break;
        }
        if (event.kind === 'result') break;
      }
    } catch (error) {
      streamError = error;
    }
    const stopped = await stopReview(reviewEntry);
    if (closed) return {verdict: 'unreadable', cancelled: true};
    if (stopped?.verified !== true) {
      append({kind: 'task.blocked', task, reason: 'termination_unverified', text: 'termination unverified', from: peer, context});
      return {verdict: 'unreadable', cancelled: true};
    }
    releaseReview(peer, reviewEntry, context);
    const verdict = streamError ? {verdict: 'unreadable'} : parseVerdict(resultStatus, resultText);
    if (streamError) resultText = streamError.message;
    append({kind: 'review.finished', task, stage, round, candidateSeq: review.candidateSeq ?? null, candidateDigest: review.candidateDigest ?? null, verdict: verdict.verdict, text: resultText ?? null, from: peer, context});
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
    // The previous rework round of this task (its findings), and the checks Jev fired for the latest
    // verdict — what the repeated-findings rule compares and names.
    lastRework: id => session.events.findLast(e => e.kind === 'task.rework' && e.task === id) ?? null,
    // Whether this task's review has already been asked again for a readable verdict (once is the cap).
    reAsked: id => {
      const candidate = candidateResult(session.events, id);
      return session.events.some(e => e.kind === 'review.reasked' && e.task === id && (!e.candidateSeq || e.candidateSeq === candidate?.seq));
    },
    lastFired: id => session.events.findLast(e => e.kind === 'jev.verdict' && e.task === id)?.fired ?? null,
    roundsCap: id => {
      const root = budgetRootOf(id, reducers.tasks(session.events));
      return submittedRow(root)?.budget?.rounds ?? limits.rounds;
    },
    limits,
    sessionEffective,
    budgets: () => reducers.budgets(session.events),
    dependencyState: id => {
      const view = reducers.tasks(session.events);
      let current = id, seen = new Set();
      for (;;) {
        if (seen.has(current)) return view[current]?.state;
        seen.add(current);
        const replacement = Object.values(view).find(task => task.replaces === current);
        if (!replacement) return view[current]?.state;
        current = replacement.id;
      }
    },
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
    const candidate = candidateResult(session.events, task);
    if (REVIEW_GATE_REASONS.has(intent.reason) && candidate) append({kind: 'review.blocked', task, stage: 'completion', reason: intent.reason,
      candidateSeq: candidate.seq, candidateDigest: candidate.digest, text: blockedText, context});
    append({kind: 'task.blocked', task, reason: intent.reason, text: blockedText, context});
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
  async function runReviewers({task, stage, round, reviewers, row, context, root, reserveFirst, note = null}) {
    const verdicts = [];
    for (let i = 0; i < reviewers.length; i++) {
      const profileName = reviewers[i];
      const reviewProfile = profiles[profileName];
      const candidate = candidateResult(session.events, task);
      const peer = reviewers.length === 1 ? reviewFrom(task) : `${reviewFrom(task)}:${i}`;
      const retryBoundary = session.events.findLast(e => e.task === task && e.kind === 'review.reasked'
        && e.stage === stage && e.candidateSeq === candidate?.seq)?.seq ?? 0;
      // A completed review is durable work too. Reuse only this candidate's current review
      // cycle and this reviewer slot; a retry marker invalidates the preceding verdict.
      const recovered = stage === 'completion' && candidate && session.events.findLast(e =>
        e.kind === 'review.finished' && e.task === task && e.stage === stage && e.from === peer
        && e.seq > retryBoundary && e.candidateSeq === candidate.seq && e.candidateDigest === candidate.digest);
      if (recovered) {
        const verdict = parseVerdict('completed', recovered.text);
        verdicts.push(verdict.verdict === recovered.verdict ? verdict : {verdict: recovered.verdict});
        continue;
      }
      // A review profile is a profile too (CONTRACT.md §3): the same shared check runs before
      // its launch. The first reviewer's refusal handling differs by stage (matches pre-Phase-8
      // behavior exactly): prelaunch (`reserveFirst: false`) releases its already-made shared
      // reservation and fails the task outright; completion (`reserveFirst: true`) has reserved
      // nothing yet at this point and escalates instead. Every reviewer past the first makes
      // (and, on refusal, releases) its own start reservation, regardless of stage.
      const reviewRefusal = policyRefusal(reviewProfile);
      // A decision-model (typesafe) verdict is a ~100 ms HTTP call, not a worker start: it
      // reserves nothing of its own, so Jev can never block a task on budget. (The prelaunch
      // first reviewer's shared reservation is the worker's, made by dispatch — untouched.)
      const exempt = reviewProfile.adapter === 'typesafe' && (reserveFirst || i > 0);
      if (exempt) {
        if (reviewRefusal) {
          append({kind: 'policy.escalated', task, reason: reviewRefusal.reason, text: reviewRefusal.text, context});
          append({kind: 'task.blocked', task, text: reviewRefusal.text, context});
          return null;
        }
      } else if (i === 0 && !reserveFirst) {
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
      const orders = stage === 'completion'
        ? (reviewProfile.role === 'verifier' ? row.steps : `${row.orders}\n\n--- worker report ---\n${reducers.tasks(session.events)[task]?.summary ?? ''}`)
        : row.orders;
      // What a decision-model reviewer (typesafe) judges: the raw orders, the worker's final
      // report and the tree's HEAD when the lineage's first worker started — the diff base.
      const reported = session.events.findLast(e => e.kind === 'task.reported' && e.task === task);
      const lineageRoot = lineageRootOf(task, reducers.tasks(session.events));
      const review = {stage, round, candidateSeq: candidate?.seq ?? null, candidateDigest: candidate?.digest ?? null, orders: row.orders, summary: reducers.tasks(session.events)[task]?.summary ?? null,
        report: reported ? {summary: reported.summary, text: reported.text, next: reported.next, outcome: reported.outcome, evidence: reported.evidence, remaining: reported.remaining, phase: reported.phase} : null,
        head: session.events.find(e => e.kind === 'task.started' && e.task === lineageRoot)?.head ?? null};
      const verdict = await runReview({task, stage, round, profileName, profile: reviewProfile, orders: note ? `${orders}\n\n${note}` : orders, dir, context, peer, review: note ? {...review, note} : review});
      if (verdict.launchFailed && !exempt) append({kind: 'budget.released', task, root, amount: {starts: 1}, text: 'review launch failed', context});
      if (verdict.cancelled) return null;
      verdicts.push(verdict);
    }
    return verdicts;
  }

  // Executes an onReviewVerdict intent, shared by the prelaunch and completion callers: only
  // 'accept' behaves differently by stage (prelaunch also launches the worker), everything else
  // is identical. Returns nothing; every branch is terminal for this dispatch/review pass.
  async function applyVerdictIntent(intent, {task, stage, row, round, context, root, reviewIntent}) {
    if (intent.action === 'reject') {
      append({kind: 'task.rejected', task, questions: intent.questions ?? [], context});
      return;
    }
    if (intent.action === 'escalate') { applyEscalate(task, intent, context); return; }
    // One more ask for a verdict bounce can read; `review.reasked` on record is what caps it at one.
    if (intent.action === 'rereview') {
      append({kind: 'review.reasked', task, stage, round, candidateSeq: candidateResult(session.events, task)?.seq ?? null, reason: intent.reason, text: intent.text ?? '', context});
      await runCompletionReview(task, reviewIntent, {note: intent.text ?? ''});
      return;
    }
    // A review that produced nothing usable ends the task with its reason, so the orchestrator is woken
    // by an outcome instead of a `blocked` row that waits for a person.
    if (intent.action === 'fail') { append({kind: 'task.failed', task, reason: intent.reason ?? 'review', text: intent.text ?? '', context}); return; }
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
    const accepted = {kind: 'task.accepted', task, stage, by: reviewFrom(task), ...(intent.advice ? {advice: intent.advice} : {}), context};
    if (stage === 'completion' && !publishArtifact(task, accepted)) return;
    append(accepted);
    if (stage === 'prelaunch') {
      if (availableStarts(root) < 1) return escalateBudget(task, context);
      await launchWorker(row);
    }
  }

  const VERDICT_ACTIONS = new Set(['accept', 'reject', 'rework', 'escalate', 'fail', 'rereview']);

  async function runCompletionReview(task, reviewIntent, {note = null} = {}) {
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

    const candidate = candidateResult(session.events, task);
    const verdicts = await runReviewers({task, stage: 'completion', round, reviewers, row, context, root, reserveFirst: true, note});
    if (!verdicts) return;
    // Same guard as the prelaunch path: a review that finishes after the task left `reviewing`
    // for an unrelated reason journals its verdict but drives no accept/reject/rework (A3).
    if (closed || reducers.tasks(session.events)[task]?.state !== 'reviewing') return;
    if (candidate && (candidateResult(session.events, task)?.digest !== candidate.digest || candidateResult(session.events, task)?.seq !== candidate.seq)) return;

    const hook = invokeHook(() => strategy.onReviewVerdict(task, verdicts, reducers.tasks(session.events), api), task, context);
    if (!hook.ok) return;
    if (!hook.intent || typeof hook.intent !== 'object' || !VERDICT_ACTIONS.has(hook.intent.action)) {
      append({kind: 'task.failed', task, reason: 'strategy', text: 'malformed onReviewVerdict intent', context});
      return;
    }
    await applyVerdictIntent(hook.intent, {task, stage: 'completion', row, round, context, root, reviewIntent});
  }

  // One dispatch per task at a time. The handle/launch/review guard below is only set after the
  // first await (a checkpoint re-check, a campaign wait, a cloud review launch); after a restart the
  // retried action and reconcile's own request both reach that window and would launch twice.
  const dispatching = new Set();
  async function dispatch(row) {
    if (dispatching.has(row.task)) return;
    dispatching.add(row.task);
    try { return await dispatchOnce(row); }
    finally { dispatching.delete(row.task); }
  }

  async function dispatchOnce(row) {
    if (closed) return;
    if (row.campaignId && campaigns(session.events)[row.campaignId]?.state !== 'active') { heldTasks.add(row.task); return; }
    const {task, parent, context} = row;
    if (handles.has(task) || launchingAttempts.has(task) || [...reviews.values()].some(review => review.task === task)) return;
    row = submittedRow(task) ?? row; // a re-dispatch (held task, restart) sees an already-routed profile
    // Sizing refusal, first of all: a task over the skill's sizing rule never launches,
    // checked in a fixed field order so the reported field is deterministic.
    // submit() always stores size; the fallback only covers rows journaled directly (legacy/test rows), never a defaulting path.
    const size = row.size ?? {lines: 0, probes: 0, minutes: 0};
    const oversizedField = SIZE_FIELDS.find(field => limits[field] !== undefined && size[field] > limits[field]);
    if (oversizedField) {
      append({kind: 'task.failed', task, reason: 'size', text: `${oversizedField} ${size[oversizedField]} exceeds limit ${limits[oversizedField]}`, context});
      return;
    }
    // The ceiling is the only limit on how long ONE task may be given: the deadline is a lease,
    // renewed while the worker makes progress (docs/plans/task-leases.md). Found live: a 15-minute cap
    // killed every local reviewer mid-review, and the orchestrator answered by shrinking the next one.
    if ((limits.minutes !== undefined || limits.ceiling !== undefined) && Number.isFinite(row.deadline) && row.deadline > ceilingMs) {
      append({kind: 'task.failed', task, reason: 'size', text: `a ${Math.ceil(row.deadline / 60000)}-minute task exceeds the ${ceilingMs / 60000}-minute ceiling: give it at most ${ceilingMs / 60000} minutes; bounce renews its lease while it makes progress`, context});
      return;
    }
    // The same job, failed the same way this many times, is a loop: bounce stops rather than running it
    // again, and says what to change. Found live: ten identical reviewer tasks, each killed at the ceiling.
    const jobStarts = session.events.filter(e => e.kind === 'task.started' && e.purpose !== 'report' && e.jobId === row.jobId);
    if (row.jobId && jobStarts.length >= (suppliedLimits.attempts ?? 3)) {
      append({kind: 'task.failed', task, reason: 'attempts_exhausted', text: 'Logical job attempt allowance exhausted', context}); return;
    }
    const attempts = failedAttempts(session.events.filter(e => e.task !== task), row);
    if (attempts.length >= REPEAT_LIMIT) {
      append({kind: 'task.failed', task, reason: 'repeat', attempts: attempts.map(a => a.task), context,
        text: repeatRefusal(row, attempts, profiles[row.profile]?.model || null)});
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
      // Say what happened, not just which rule fired: this row is all the rail shows, and a task that was
      // refused in the same second it was submitted otherwise reads as one queued forever.
      append({kind: 'task.failed', task, reason: 'depth', context,
        // A retry inherits its predecessor's parent, so retrying this refused task is refused again
        // (observed live, 3c7e7d25 seq 948); what continues the work is a retry of the parent's job.
        text: `delegation under ${String(parent).slice(0, 8)} exceeds depth cap ${depthCap}; continue the work with retryOf ${parent} (its job, at an allowed depth), or submit it as a new root task (parent null, no retryOf)`});
      return;
    }
    // `profile: "auto"`: route before anything reads the profile. Jev picks (when enabled for
    // routing and confident, with a policy fitting the orders' access needs); otherwise the
    // fallback builder — an orchestrator that uses `auto` never breaks. A task cancelled while
    // the decision was in flight gets no routing row.
    if (row.profile === AUTO_PROFILE) {
      if (routing.has(task)) return; // a reconcile() during the route await: this dispatch already owns the task
      routing.add(task);
      let decision;
      try { decision = jev ? await jev.route({task, orders: row.orders, profiles}) : {chosen: routingFallback(profiles), fallback: true, reason: 'routing unavailable', probabilities: {}, confidence: 0}; }
      finally { routing.delete(task); }
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
      if (!decision?.chosen || !profiles[decision.chosen]) {
        append({kind: 'task.failed', task, reason: 'error', text: 'malformed: profile (no worker profile to route auto to)', context});
        return;
      }
      // A job AND its AI from the one ask: the agent's `models:` opens with `auto` and the AI answer was confident.
      const played = decision.agent && decision.ai ? compose(decision.agent, decision.ai, decision.local ?? null) : null;
      if (played) {
        append({kind: 'jev.routed', task, chosen: played, agent: decision.agent, ai: decision.ai, ...(decision.local ? {local: decision.local} : {}), via: 'auto', probabilities: decision.probabilities ?? {}, confidence: decision.confidence ?? 0, fallback: false, reason: null, model: decision.model ?? null,
          text: `Routed auto → ${decision.agent} on ${decision.ai} (job and AI chosen by Jev, confidence ${Number(decision.confidence ?? 0).toFixed(2)})`, context});
      } else
      append({kind: 'jev.routed', task, chosen: decision.chosen, ...(decision.tier ? {tier: decision.tier} : {}), ...(decision.agent !== undefined ? {agent: decision.agent, ...(decision.agentReason ? {agentReason: decision.agentReason} : {})} : {}), probabilities: decision.probabilities ?? {}, confidence: decision.confidence ?? 0, fallback: decision.fallback === true, reason: decision.reason ?? null, model: decision.model ?? null,
        text: decision.fallback ? `Routed auto → ${decision.chosen} (fallback: ${decision.reason ?? 'unavailable'})` : `Routed auto → ${decision.chosen} (${decision.agent ? 'job chosen by ' : ''}Jev${decision.tier ? `: tier ${decision.tier}` : ''}, confidence ${Number(decision.confidence ?? 0).toFixed(2)})`, context});
      row = submittedRow(task);
    } else if (profiles[row.profile]?.auto === true && !row.replaces && jev?.routeAI && !session.events.some(e => e.kind === 'jev.routed' && e.task === task)) {
      // An agent whose `models:` opens with `auto`: the job is given, Jev picks the AI. A recovery
      // task (`replaces`) is never routed — it is the job falling to its own chain.
      if (routing.has(task)) return;
      routing.add(task);
      const agent = row.profile;
      let decision;
      try { decision = await jev.routeAI({task, orders: row.orders, profiles, head: profiles[agent]}); }
      finally { routing.delete(task); }
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return;
      const played = decision?.ai ? compose(agent, decision.ai, decision.local ?? null) : null;
      // Jev off asks nothing and journals nothing: the journal is what it was without `auto`.
      if (decision?.asked) {
        append({kind: 'jev.routed', task, chosen: played ?? agent, agent, ai: played ? decision.ai : null, via: 'agent-auto', probabilities: decision.probabilities ?? {}, confidence: decision.confidence ?? 0, fallback: !played, reason: played ? null : decision.reason ?? 'unavailable', model: decision.model ?? null,
          ...(played && decision.tier ? {tier: decision.tier} : {}), ...(played && decision.local ? {local: decision.local} : {}),
          text: played ? `Routed ${agent} → ${decision.ai} (AI chosen by Jev${decision.tier ? `: tier ${decision.tier}` : ''}, confidence ${Number(decision.confidence ?? 0).toFixed(2)})` : `Routed ${agent} → its own models (fallback: ${decision.reason ?? 'unavailable'})`, context});
        row = submittedRow(task);
      }
    }
    const profile = profiles[row.profile];
    if (!profile) {
      append({kind: 'task.failed', task, reason: 'error', text: `malformed: profile`, context});
      return;
    }
    const capabilityProblem = validateRequirements(row.requires);
    const missing = capabilityProblem ? [] : missingCapabilities(profile, row.requires);
    if (capabilityProblem || missing.length) {
      append({kind: 'task.failed', task, reason: 'capability_mismatch', text: capabilityProblem ?? `Required capabilities unavailable: ${missing.join(', ')}`, context});
      return;
    }
    if (Object.values(view).some(t => t.state === 'blocked' && session.events.findLast(e => e.task === t.id && e.kind === 'task.blocked')?.reason === 'orphaned')
      || session.events.findLast(e => ['main.starting', 'main.started', 'main.terminal', 'main.blocked'].includes(e.kind))?.reason === 'orphaned') {
      append({kind: 'task.blocked', task, reason: 'termination_unverified', text: 'A worker from the previous daemon may still be writing; verify its termination before starting more work', context});
      return;
    }
    {
      const refusal = policyRefusal(profile);
      if (refusal) {
        append({kind: 'task.failed', task, reason: refusal.reason, text: refusal.text, context});
        return;
      }
    }
    if (LOCAL_ADAPTERS.has(profile.adapter)) {
      const endpoint = profile.endpoint ?? 'lmstudio';
      const running = localRunning(endpoint), slots = localSlots(endpoint);
      const onModel = localRunning(endpoint, profile.model), perModel = modelSlots(endpoint);
      const full = running >= slots ? `Waiting for a local slot on ${endpoint}: ${running} of ${slots} in use`
        : onModel >= perModel ? `Waiting for a local slot on ${endpoint} for ${profile.model}: ${onModel} of ${perModel} in use` : null;
      if (full) {
        if (!slotWaiters.has(task)) append({kind: 'task.milestone', task, phase: 'queued', text: full, next: 'dispatch when a local turn ends', context});
        slotWaiters.add(task);
        return;
      }
      slotWaiters.delete(task);
    }
    if (CLOUD_ADAPTERS.has(profile.adapter)) {
      const running = cloudRunning();
      const full = running >= maxConcurrentCloud ? `Waiting for a cloud slot: ${running} of ${maxConcurrentCloud} in use` : null;
      if (full) {
        if (!slotWaiters.has(task)) append({kind: 'task.milestone', task, phase: 'queued', text: full, next: 'dispatch when a cloud turn ends', context});
        slotWaiters.add(task);
        return;
      }
      slotWaiters.delete(task);
    }
    if (row.inPlace) {
      // §6: one in-place task at a time, and never while an integration (any task's) is
      // mid-flight — it waits for that one integration, never for a copy worker.
      if (inPlaceBusy()) {
        if (!inPlaceWaiters.has(task)) append({kind: 'task.milestone', task, phase: 'queued', reason: 'in_place_busy',
          text: `Waiting for ${inPlaceHolder() ?? 'an integration in progress'} (in place)`, next: 'dispatch when it clears', context});
        inPlaceWaiters.add(task);
        return;
      }
      inPlaceWaiters.delete(task);
      // Jev's risk check, when enabled, layers on top of the structural (cited-row) admission
      // already done at submit time; off/unconfident/unavailable falls back to that check with a jev.skipped row.
      const judged = jev ? await jev.inPlace(inPlaceRiskInputs(row)) : {verdict: 'unresolved', reason: 'jev unavailable', confidence: 0, probabilities: {}, model: null};
      if (judged.verdict === 'exceeds' || judged.verdict === 'unrelated') {
        append({kind: 'task.failed', task, reason: judged.verdict === 'exceeds' ? 'in_place_exceeds_request' : 'in_place_unrelated',
          text: `Jev leaned ${judged.verdict} (confidence ${Number(judged.confidence ?? 0).toFixed(2)}) on the message that authorized this in-place task; narrow the orders to what it asked, or ask the user.`,
          confidence: judged.confidence ?? 0, probabilities: judged.probabilities ?? {}, context});
        return;
      }
      if (judged.verdict === 'authorized') {
        append({kind: 'jev.decided', task, decision: 'in_place', verdict: judged.verdict, confidence: judged.confidence ?? 0,
          probabilities: judged.probabilities ?? {}, model: judged.model ?? null,
          text: `Jev: in-place task authorized (confidence ${Number(judged.confidence ?? 0).toFixed(2)})`, context});
      } else {
        append({kind: 'jev.skipped', task, reason: judged.reason ?? 'unconfident',
          text: `Jev in-place risk check unavailable (${judged.reason ?? 'unconfident'}); the structural check alone authorized this task`, context});
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
  async function deliverTo(task, row, target) {
    const entry = target.review ? [...reviews.values()].find(item => item.task === task && item.handle) : handles.get(task);
    const delivered = (tier, text = null) => append({kind: 'task.delivered', task, tier, message: row.id, text, from: 'bounce', context: row.context});
    if (target.entry && (entry !== target.entry || entry?.handle.turnId !== target.turnId)) return delivered('failed', 'turn changed before delivery');
    if (!entry || reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) return delivered('queued', 'no live worker');
    if (typeof row.text !== 'string') return delivered('queued', 'no text');
    let outcome;
    try {
      const tier = await entry.adapter.deliver(entry.handle, {text: row.text, ...(target.turnId ? {expectedTurnId: target.turnId} : {})});
      outcome = TIERS.has(tier) ? [tier] : ['queued', `adapter reported an unknown tier: ${tier}`];
    } catch (error) { outcome = ['queued', error.message]; }
    delivered(...outcome);
  }

  // One delivery at a time per worker, so both the adapter calls and the journaled rows are
  // FIFO for that task. An adapter may queue internally as well; the scheduler simply never
  // overlaps two deliveries to the same worker.
  const deliveryTails = new Map(); // task -> promise for the last delivery still in flight
  function enqueueDelivery(task, row) {
    const review = row.to?.startsWith('review:');
    const entry = review ? [...reviews.values()].find(item => item.task === task && item.handle) : handles.get(task);
    const target = {entry, turnId: entry?.handle.turnId, review};
    const tail = (deliveryTails.get(task) ?? Promise.resolve())
      .then(() => deliverTo(task, row, target))
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
  function taskDeadlineMs(submitted) { return submitted?.deadline ?? ((limits.minutes ?? DEFAULT_DEADLINE_MINUTES) * 60000); }
  // With leases: the end of the current lease — one lease per `task.lease.renewed` in the lineage,
  // plus the first — never past the ceiling. The same arithmetic as reducers.watchdog.
  function deadlineAtFor(task) {
    return reducers.attemptLease(session.events, task, {defaultDeadlineMs: taskDeadlineMs(submittedRow(task)), ceilingMs})?.deadlineAt ?? null;
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

  // A lease end (docs/plans/task-leases.md). The deadline is not a kill: a worker that made progress
  // in this lease, is not repeating itself and that Jev (when present) does not judge stuck gets
  // another lease; otherwise, or at the ceiling, it is asked for its conclusion, and only a worker
  // that gives none within concludeGrace is cancelled. Nothing here needs Jev.
  const seconds = ms => `${Math.round(ms / 1000)} s`;
  const minutesText = ms => `${Math.round(ms / 60000)} min`;
  const concludeWhy = {ceiling: r => `the ${minutesText(r.ceilingAt - r.startedAt)} ceiling`, no_progress: () => 'no progress in the last lease', stuck: () => 'repeating earlier work with nothing new'};
  const concludePrompt = concludeAsk;
  const expiredHead = (reason, who, r) => reason === 'ceiling' ? `${who} reached its ${minutesText(r.ceilingAt - r.startedAt)} ceiling`
    : reason === 'stuck' ? `${who} repeated earlier work with nothing new` : `${who} made no progress in its last ${minutesText(r.leaseMs)} lease`;
  const submitterOf = task => rootSubmitterFrom(task) === 'orchestrator' ? 'orchestrator' : 'user';

  async function handleLeaseEnd(r, now) {
    const row = submittedRow(r.task);
    const concluding = session.events.findLast(e => e.kind === 'task.concluding' && e.task === r.task);
    if (concluding) {
      // Waited for while it shows activity (the adapter heartbeats a step that is still generating),
      // never past concludeCap; quiet for concludeGrace, it has nothing coming.
      const askedAt = Date.parse(concluding.time);
      if (now - Math.max(r.lastActivityAt, askedAt) >= watchdogConfig.concludeGrace || now - askedAt >= watchdogConfig.concludeCap) await expireLease(r, concluding.reason, row, now - askedAt);
      return;
    }
    if (leaseChecks.has(r.task)) return;
    leaseChecks.add(r.task);
    try {
      if (r.deadlineAt >= r.ceilingAt) { await concludeTask(r, 'ceiling', row); return; }
      const decision = await leaseDecision(r, now, row);
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[r.task]?.state)) return; // it ended while Jev was asked
      if (decision.conclude) { await concludeTask(r, decision.conclude, row); return; }
      append({kind: 'task.lease.renewed', task: r.task, ...(r.stage === 'review' ? {stage: 'review'} : {}), lease: r.renewals + 1, until: Math.min(r.deadlineAt + r.leaseMs, r.ceilingAt),
        evidence: {sinceProgress: now - Math.max(r.lastActivityAt, r.lastProgressAt), calls: decision.calls},
        jev: decision.jev ? {verdict: decision.jev.verdict, confidence: decision.jev.confidence} : null, context: row?.context});
      if (decision.jev?.verdict === 'drifting') append({kind: 'policy.escalated', task: r.task, reason: 'drifting', to: submitterOf(r.task), context: row?.context,
        text: `Jev judged ${row?.profile ?? 'the worker'} to be drifting from its orders (${decision.jev.confidence.toFixed(2)}) at its lease renewal; it keeps running. Steer it with a message, cancel it, or let it run.`});
    } finally { leaseChecks.delete(r.task); }
  }

  // Progress in this lease, then repetition, then Jev — each only able to stop a renewal, and the
  // first two need nothing but the log and the live activity. A tool call only counts when the
  // adapter names it (OpenCode does): a generic activity line says nothing about what was read.
  async function leaseDecision(r, now, row) {
    const calls = toolCalls.get(r.task) ?? [];
    const inLease = calls.filter(c => c.at > r.leaseStartAt);
    const before = calls.filter(c => c.at <= r.leaseStartAt);
    if (Math.max(r.lastActivityAt, r.lastProgressAt) <= r.leaseStartAt) return {conclude: 'no_progress', jev: null, calls: inLease.length};
    if (inLease.length && before.length && !inLease.some(c => c.change) && inLease.every(c => before.some(b => b.call === c.call))) return {conclude: 'stuck', jev: null, calls: inLease.length};
    let judged = null;
    if (jev?.lease) {
      try {
        judged = await jev.lease({task: r.task, orders: row?.orders ?? '', lease: r.renewals + 1, minutes: Math.round((now - r.startedAt) / 60000),
          observed: session.events.filter(e => e.kind === 'task.observed' && e.task === r.task).slice(-3).map(e => e.text), calls: calls.slice(-20).map(c => c.call)});
      } catch (error) { judged = {verdict: null, confidence: 0, reason: error?.code ?? error?.message ?? 'error', model: null}; }
      if (judged?.reason === 'jev disabled') judged = null;
      else append({kind: 'jev.lease', task: r.task, verdict: judged?.verdict ?? null, confidence: judged?.confidence ?? 0, reason: judged?.reason ?? null, model: judged?.model ?? null, context: row?.context});
    }
    return {conclude: judged?.verdict === 'stuck' ? 'stuck' : null, jev: judged, calls: inLease.length};
  }

  // A worker states a finding the moment it confirms it, as a `FINDING: {json}` line (the reviewer's
  // orders ask for it), so a review stopped before its final answer still hands its findings on. Kept
  // once each; a line that is not JSON is kept as text.
  function recordFindings(task, text, context) {
    for (const line of String(text ?? '').split('\n')) {
      const match = /^\s*FINDING:\s*(.+)$/.exec(line);
      if (!match) continue;
      const said = `FINDING: ${match[1].trim()}`;
      if (session.events.some(e => e.kind === 'task.finding' && e.task === task && e.text === said)) continue;
      let finding = null;
      try { const parsed = JSON.parse(match[1]); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) finding = parsed; } catch {}
      append({kind: 'task.finding', task, finding, text: said.slice(0, 4000), from: workerFrom(task), context});
    }
  }
  const findingLine = e => e.finding ? [e.finding.severity, e.finding.file ? `${e.finding.file}${e.finding.line ? `:${e.finding.line}` : ''}` : null, e.finding.title ?? e.finding.description].filter(Boolean).join(' ')
    : e.text.replace(/^FINDING:\s*/, '');

  // Asked through the adapter when it can stop the turn and ask again with its tools off (OpenCode);
  // otherwise as a message on the ordinary delivery path (a codex steer, the claude socket).
  async function concludeTask(r, reason, row) {
    const prompt = concludePrompt(concludeWhy[reason](r));
    append({kind: 'task.concluding', task: r.task, ...(r.stage === 'review' ? {stage: 'review'} : {}), reason, text: prompt, context: row?.context});
    // A review's turn belongs to its own peer handle, not the worker's.
    const entry = r.stage === 'review' ? [...reviews.values()].find(candidate => candidate.task === r.task && candidate.handle) : handles.get(r.task);
    if (typeof entry?.adapter?.conclude === 'function') {
      try { await entry.adapter.conclude(entry.handle, {prompt, reason}); return; }
      catch (error) { append({kind: 'diagnostic', task: r.task, text: `conclude failed: ${error.message}; asking by message`, context: row?.context}); }
    }
    append({kind: 'message', to: r.stage === 'review' ? reviewFrom(r.task) : workerFrom(r.task), from: 'bounce', text: prompt, context: row?.context});
  }

  async function expireLease(r, reason, row, waited) {
    const found = session.events.filter(e => e.kind === 'task.finding' && e.task === r.task);
    const findings = found.length ? `. ${found.length} finding${found.length === 1 ? '' : 's'} recorded before the stop:\n${found.map(e => `- ${findingLine(e)}`).join('\n')}` : '';
    append({kind: 'task.deadline', task: r.task, reason, text: `no final answer ${seconds(waited)} after being asked to conclude (${reason}) at ${seconds(r.elapsed)}${findings}`, findings: found.length, from: 'bounce', context: row?.context});
    // A deadline is bounce's decision, never the user's: the cancel says so, and whoever submitted the
    // task is told, with the way forward. Found live: journaled as reason `user`, the orders' "a user
    // cancellation is final" applied, and the orchestrator stopped the whole run over one slow analyst.
    await cancel(r.task, {force: true, reason: 'deadline'});
    append({kind: 'policy.escalated', task: r.task, reason: 'deadline', to: submitterOf(r.task), context: row?.context,
      text: `${expiredHead(reason, row?.profile ?? 'the worker', r)} and gave no final answer within ${seconds(waited)} of being asked.${found.length ? ` Its ${found.length} recorded finding${found.length === 1 ? ' is' : 's are'} in the deadline row.` : ''} Its partial progress is in the journal: resubmit what is left with that progress in the orders, or drop it.`});
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
      const text = `bounce watchdog: ${reason} for ${elapsedSeconds} s — ${reportInstruction(profiles[row?.profile])} with op:milestone and evidence, or op:blocked with the blocker; include phase, text and next`;
      append({kind: 'message', to: workerFrom(r.task), from: 'bounce', text, context: row?.context});
      return;
    }
    const correctedAt = Date.parse(corrected.at(-1).time);
    // Missing authored milestones are not evidence of a dead worker while observed work
    // continues. Silence or the hard deadline may terminate it; missing reports alone may not.
    if (reason === 'silent' && now >= correctedAt + watchdogConfig.grace) {
      append({kind: 'policy.escalated', task: r.task, reason: 'cancelled', text: `${reason} persisted through correction and grace`, context: row?.context});
      await cancel(r.task, {reason: 'watchdog'});
    }
  }

  // §1: runs the watchdog policy once against clock(). Deterministic and driven entirely off
  // the log plus the live `activity` map — no hidden state of its own, so calling it twice with
  // the same log/activity/now is idempotent beyond the dedupe rules §3 already specifies.
  async function tick() {
    const now = clock();
    for (const [task, pending] of [...launchingAttempts, ...[...reviews.values()].filter(entry => entry.pending).map(entry => [entry.task, entry])]) {
      if (pending.cancelReason || pending.phase === 'admission' || now - pending.requestedAt < watchdogConfig.startupMs) continue;
      append({kind: 'policy.escalated', task, reason: 'startup_timeout', text: 'Provider startup exceeded its allowance; verifying termination before recovery'});
      await cancelOne(task, reducers.tasks(session.events), 'watchdog');
    }
    const rows = reducers.watchdog(session.events, now, {activity, watchdog: {...watchdogConfig, defaultDeadlineMs: (limits.minutes ?? DEFAULT_DEADLINE_MINUTES) * 60000, ceilingMs}});
    for (const r of rows) {
      // A parked task (blocked) never expires here — it holds no slot and is never killed by its
      // lease/ceiling; this escalation (once per blocker) is only ever informational.
      if (r.verdicts.includes('blocked')) { await handleBlocked(r); continue; }
      if (r.verdicts.includes('deadline')) { await handleLeaseEnd(r, now); continue; }
      for (const reason of ['silent', 'stalled']) if (r.verdicts.includes(reason)) await handleSignature(r, reason, now);
    }
  }
  let watchdogInterval = null;
  if (typeof watchdogConfig.interval === 'number' && watchdogConfig.interval > 0) {
    watchdogInterval = setInterval(() => { tick().catch(error => append({kind: 'policy.escalated', reason: 'watchdog_error', text: error.message})); }, watchdogConfig.interval);
    watchdogInterval.unref?.();
  }

  // F2/A5: the live activity map is never journaled and never restored on restart, so it must
  // also never be left to grow forever — prune a task's entry the moment its own row actually
  // lands it in a terminal state (a task.completed into 'reviewing' does not prune; the later
  // task.accepted/rejected/rework path does its own transition and gets checked in turn).
  const TERMINAL_ROW_KINDS = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.deadline', 'task.rejected', 'task.accepted']);
  function requestDispatch(row, cause = 0) {
    requestAction(session, {actionId: `dispatch:${row.task}:${cause}`, type: 'dispatch', task: row.task, cause});
  }
  function requestTerminal(row, events = []) {
    const attempt = row.attempt ?? reducers.tasks(session.events)[row.task]?.attempt ?? 0;
    requestAction(session, {actionId: `terminal:${row.task}:${row.kind}:${attempt}`, type: 'terminal', task: row.task, payload: {kind: row.kind}}, events);
  }
  const effects = createActionRunner({session, handlers: {
    integrate: action => {
      try {
        const {artifactId, file, dir, continuation} = action.payload;
        const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (artifact.id !== artifactId) throw new Error('artifact identity mismatch');
        const result = integrateArtifact({cwd: session.cwd, artifact, dir});
        if (result.status !== 'integrated') {
          append({kind: 'task.blocked', task: action.task, reason: `integration_${result.status}`, text: `Artifact integration ${result.status}${result.path ? `: ${result.path}` : ''}; isolated work preserved`, artifactId});
          return;
        }
        if (!session.events.some(e => e.kind === 'task.integrated' && e.task === action.task && e.artifactId === artifactId)) append({kind: 'task.integrated', task: action.task, artifactId, resultHash: artifact.resultHash});
        // A follow-up (retryOf) reusing this same workspace diffs against what's now in the
        // checkout, not the pre-integration copy it started from — see advanceBaseline.
        const workspace = existingWorkspace(action.task);
        if (workspace && !workspace.disposable) workspaces.set(action.task, advanceBaseline(workspace, artifact));
        append(continuation);
      } catch (error) {
        append({kind: 'task.blocked', task: action.task, reason: 'integration_interrupted', text: `Artifact integration interrupted: ${error.message}; durable manifest retained for restart recovery`});
        throw error;
      }
    },
    terminal: action => {
      const row = session.events.findLast(e => e.task === action.task && e.kind === action.payload.kind);
      if (!row) return;
      if (row.kind === 'task.failed' || (row.kind === 'task.cancelled' && row.reason === 'watchdog')) maybeFallback(row);
      else if (row.kind === 'task.cancelled' && row.reason !== 'deadline') append({kind: 'policy.fallback.skipped', task: row.task, reason: 'explicit_cancellation', text: 'user cancellation never recovers', context: row.context, ref: `cancel-skip:${row.task}`});
      else if (row.kind === 'task.deadline') append({kind: 'policy.fallback.skipped', task: row.task, reason: 'deadline_exhausted', text: 'logical deadline exhausted', context: row.context, ref: `deadline-skip:${row.task}`});
      handleTerminal(row);
    },
    plan: async action => {
      const row = session.events.find(e => e.kind === 'plan.submitted' && e.plan === action.payload.plan);
      if (!row || session.events.some(e => ['plan.accepted', 'plan.rejected', 'plan.unavailable'].includes(e.kind) && e.plan === row.plan)) return;
      if (!campaignActive(null, row.campaignId) && !await waitForCampaign(null, row.campaignId)) return;
      const capabilityFindings = (row.chunks ?? []).flatMap(chunk => {
        const required = requireFinalReport && row.from === 'orchestrator' && chunk.requires === undefined
          ? 'declare requires for this chunk' : validateRequirements(chunk.requires);
        const missing = !required && profiles[chunk.profile] ? missingCapabilities(profiles[chunk.profile], chunk.requires) : [];
        return required || missing.length ? [{chunk: chunk.id, check: 'capabilities', confidence: 1,
          fix: required ?? `Profile ${chunk.profile} lacks ${missing.join(', ')}; split source analysis from command verification`}] : [];
      });
      const result = await supervisePlan({events: session.events, plan: row.plan, now: clock,
        startupMs: watchdogConfig.startupMs, signal: planController.signal,
        append: event => append({...event, planId: row.plan, phase: row.phase, campaignId: row.campaignId, context: row.context}),
        run: ({signal}) => capabilityFindings.length ? {verdict: 'reject', findings: capabilityFindings} : jev?.plan ? jev.plan({plan: row, ceilingMinutes: ceilingMs / 60000, signal})
          : judgePlan({plan: row, settings: {enabled: false}, ceilingMinutes: ceilingMs / 60000, signal})});
      if (result.status !== 'decision' || closed) return;
      const decision = result.decision ?? {verdict: 'unavailable', reason: 'empty_decision'};
      const kind = decision.verdict === 'accept' ? 'plan.accepted' : decision.verdict === 'rework' || decision.verdict === 'reject' ? 'plan.rejected' : 'plan.unavailable';
      append({kind, plan: row.plan, planId: row.plan, phase: row.phase, campaignId: row.campaignId, chunks: row.chunks?.length ?? 0,
        findings: decision.findings ?? [], noted: decision.noted ?? [], model: decision.model ?? null,
        reason: decision.reason ?? null, context: row.context, text: `${row.phase ?? 'Plan'}: ${kind}${decision.reason ? ` (${decision.reason})` : ''}`});
    },
    completion: async action => {
      try { await handleCompleted(action.task); }
      catch (error) { append({kind: 'task.failed', task: action.task, reason: 'error', text: error.message}); }
    },
    dispatch: async action => {
      const row = submittedRow(action.task);
      const current = reducers.tasks(session.events)[action.task];
      if (!row || !current || !['queued', 'waiting'].includes(current.state) || handles.has(action.task)) return;
      try { await dispatch(row); }
      catch (error) { append({kind: 'task.failed', task: row.task, reason: 'error', text: error.message, context: row.context}); }
    },
  }, reconcile: action => {
    if (action.type === 'integrate') return session.events.filter(e => e.kind === 'orchestration.action.started' && e.actionId === action.actionId).length < 3 ? 'retry' : 'blocked';
    if (action.type === 'terminal') return 'retry';
    if (action.type === 'plan') return session.events.some(e => ['plan.accepted', 'plan.rejected', 'plan.unavailable'].includes(e.kind) && e.plan === action.payload.plan) ? 'settled' : 'retry';
    const state = reducers.tasks(session.events)[action.task]?.state;
    if (reducers.TERMINAL.has(state)) return 'settled';
    if (action.type === 'completion' && !session.events.some(e => e.task === action.task && e.kind === 'review.started' && e.seq > (action.cause ?? action.seq))) return 'retry';
    const launched = session.events.some(e => e.task === action.task && ['task.launch.requested', 'task.started', 'review.started'].includes(e.kind));
    return state === 'queued' && !launched ? 'retry' : 'blocked';
  }, gate: action => {
    // An integrate action never runs while an in-place task holds the lock; it stays 'requested'
    // (never 'started', so the retry cap above never sees it) until wakeInPlace() reconciles again.
    if (action.type !== 'integrate' || !inPlaceRunning()) return true;
    if (!integrationWaiting.has(action.actionId)) {
      integrationWaiting.add(action.actionId);
      append({kind: 'task.milestone', task: action.task, phase: 'queued', reason: 'in_place_busy',
        text: `Waiting for ${inPlaceHolder() ?? 'an in-place task'} (in place)`, next: 'integrate when it clears', context: submittedRow(action.task)?.context});
    }
    return false;
  }});
  // Wakes both halves of the lock (§5, §6) once it can plausibly have cleared: released
  // integrate actions in their original order, then any in-place task waiting its turn.
  function wakeInPlace(cause) {
    if (inPlaceRunning()) return; // still held: nothing to wake yet
    integrationWaiting.clear();
    effects.reconcile();
    if (integrationInFlight() || !inPlaceWaiters.size) return;
    for (const task of [...inPlaceWaiters]) {
      if (reducers.tasks(session.events)[task]?.state !== 'queued') { inPlaceWaiters.delete(task); continue; }
      const row = submittedRow(task);
      if (row) requestDispatch(row, cause);
    }
  }
  const unsubscribe = session.subscribe(row => {
    if (row.kind === 'campaign.resumed' || row.kind === 'task.cancelled') for (const wake of [...campaignWaiters]) wake();
    if (row.kind === 'campaign.resumed') {
      for (const task of Object.values(reducers.tasks(session.events))) if (task.campaignId === row.campaignId && ['queued', 'waiting'].includes(task.state) && !handles.has(task.id)) {
        const submitted = submittedRow(task.id);
        if (submitted) requestDispatch(submitted, row.seq);
      }
    }
    if (row.task && TERMINAL_ROW_KINDS.has(row.kind) && reducers.TERMINAL.has(reducers.tasks(session.events)[row.task]?.state)) {
      activity.delete(row.task); toolCalls.delete(row.task);
    }
    // §5/§6: any task-scoped row is a candidate to have moved an in-place task off `running`,
    // or an integrate action to have settled — wakeInPlace() itself checks whether the lock
    // has actually cleared before doing anything, so this is cheap to call liberally.
    if (row.task && (inPlaceWaiters.size || integrationWaiting.size)) queueMicrotask(() => wakeInPlace(row.seq));
    if (row.kind === 'plan.submitted') requestAction(session, {actionId: `plan:${row.plan}`, type: 'plan', payload: {plan: row.plan}, cause: row.seq});
    if (row.kind === 'task.submitted') {
      // Any throw here (including one from before the first `await`, which an async
      // function turns into a rejection rather than a synchronous throw) must land on the
      // task as its own failure — never disappear, leaving the task queued forever.
      requestDispatch(row);
    }
    if (row.kind === 'task.completed') {
      // STRATEGY (CONTRACT.md §2 onCompleted): a second (and later) task.completed on the same
      // task re-enters review exactly the same way — the hook and runCompletionReview both
      // read state fresh off the log every time.
      requestAction(session, {actionId: `completion:${row.task}:${reducers.tasks(session.events)[row.task]?.attempt ?? 0}`, type: 'completion', task: row.task});
    }
    else if (['task.failed', 'task.cancelled', 'task.deadline', 'task.accepted', 'task.rejected'].includes(row.kind)) requestTerminal(row);
    // Messages to `user`/`orchestrator`/anyone else — and a malformed empty worker
    // address — are not this subscriber's business.
    else if (row.kind === 'message' && typeof row.to === 'string' && /^(worker|review):.+/.test(row.to)) {
      const target = row.to.slice(row.to.indexOf(':') + 1);
      enqueueDelivery(target, row);
      // Deferred a microtask (see resumeOnMessage): lets every message appended in this same
      // synchronous burst enqueue its own delivery first.
      if (row.to.startsWith('worker:')) queueMicrotask(() => resumeOnMessage(target, row.context));
    }
    // task.activity is a LIVE_KIND (never journaled): the only way the watchdog ever learns
    // about it is right here, off the same subscriber every other peer-published row reaches.
    // An integer `expect` declares a bounded slow step; §2 caps it at the task's own deadline
    // so a declared step can never itself grant an infinite reprieve.
    else if (row.kind === 'task.activity' && row.task && !row.startup) {
      const at = Date.parse(row.time);
      const prev = activity.get(row.task);
      let expectUntil = prev?.expectUntil ?? null;
      if (Number.isInteger(row.expect) && row.expect > 0) {
        const dAt = deadlineAtFor(row.task);
        expectUntil = dAt != null ? Math.min(at + row.expect, dAt) : at + row.expect;
      }
      activity.set(row.task, {at, expectUntil});
      if (typeof row.call === 'string') {
        const calls = toolCalls.get(row.task) ?? [];
        calls.push({at, call: row.call, change: row.change === true});
        toolCalls.set(row.task, calls.slice(-CALL_MEMORY));
      }
    }
  });

  // Reconcile at construction: every task the log reports mid-flight has no live handle (a
  // restart lost the worker) — retain it blocked: a detached process may still be writing.
  // No replacement or new dispatch may assume that lost ownership proves termination. The start it reserved
  // was genuinely consumed (the worker ran), so — as for any worker that ran and failed — the
  // reservation is not released; releases are only for launches that never happened.
  const initialView = reducers.tasks(session.events);
  const MID_FLIGHT = new Set(['running', 'waiting', 'blocked', 'input_required', 'reviewing']);
  // `attempt` is set by task.started: a parent is 'waiting' the moment a child is submitted even
  // if it never launched, and a dispatch refusal leaves a never-started task 'blocked' — neither
  // had a worker to lose, so neither is orphaned.
  const executionEnded = task => {
    const started = session.events.findLast(e => e.task === task && ['task.launch.requested', 'task.started', 'review.started'].includes(e.kind));
    const ended = session.events.findLast(e => e.task === task && (e.kind === 'task.attempt.ended' && e.verifiedTermination || e.kind === 'review.finished'));
    return ended && ended.seq > (started?.seq ?? Infinity);
  };
  // A verified exit can precede persistence of its result. Keep this crash window
  // visible; an exited process cannot supply the missing answer on replay.
  const pendingRecovery = [...actionState(session.events).values()];
  for (const t of Object.values(initialView)) {
    if (!executionEnded(t.id) || !['running', 'reviewing', 'waiting'].includes(t.state)) continue;
    const recoverable = pendingRecovery.some(action => action.task === t.id &&
      ['integrate', 'completion'].includes(action.type) && !['settled', 'cancelled'].includes(action.status));
    const completed = session.events.some(e => e.task === t.id && e.kind === 'task.completed');
    if (!recoverable && !completed) append({kind: 'task.blocked', task: t.id,
      reason: 'outcome_recovery_required', context: t.context,
      text: 'Worker exit was verified, but no durable outcome was recorded; inspect preserved work and submit an explicit retry'});
  }
  for (const t of Object.values(initialView)) if (!executionEnded(t.id) && (MID_FLIGHT.has(t.state) || t.state === 'queued') && (t.attempt != null || session.events.some(row => row.task === t.id && ['task.local_selected', 'task.launch.requested', 'review.started'].includes(row.kind))) && !handles.has(t.id))
    if (session.events.findLast(e => e.task === t.id && e.kind === 'task.blocked')?.reason !== 'orphaned') append({kind: 'task.blocked', task: t.id, reason: 'orphaned', text: 'termination unverified after daemon restart; inspect the previous worker process before resubmitting', context: t.context});

  // Cycle-guarded for the same reason as the root-walkers above.
  const postOrder = (view, id, seen = new Set()) => {
    if (seen.has(id)) return [];
    seen.add(id);
    return [...(view[id]?.children ?? []).flatMap(child => postOrder(view, child, seen)), id];
  };

  async function cancelOne(id, view, reason = 'user') {
    if (session.events.findLast(e => e.task === id && e.kind === 'task.blocked')?.reason === 'orphaned') return false;
    if (!cancellationRequests.has(id)) {
      cancellationRequests.add(id);
      append({kind: 'task.cancel.requested', task: id, attempt: view[id]?.attempt ?? null, reason, context: view[id]?.context});
    }
    const launching = launchingAttempts.get(id);
    if (launching) {
      launching.cancelReason = reason;
      launching.localController?.abort();
      if (launching.phase === 'admission') {
        append({kind: 'task.cancelled', task: id, reason, from: workerFrom(id), context: view[id].context});
        return true;
      }
      append({kind: 'task.blocked', task: id, text: 'termination pending: worker launch has not resolved', context: view[id].context});
      return false;
    }
    // A review handle (A3) is cancelled before the worker's — a task can only have one of the
    // two live at a time (review during queued/reviewing, worker otherwise: the CORE runs a
    // multi-reviewer round one reviewer at a time, CONTRACT §5, so at most one entry per task
    // is ever in `reviews`), and a review that reports unverified blocks the task exactly like
    // an unverified worker termination.
    const reviewFound = [...reviews.entries()].find(([, entry]) => entry.task === id);
    if (reviewFound) {
      const [peer, reviewEntry] = reviewFound;
      if (reviewEntry.pending) {
        reviewEntry.cancelReason = reason;
        reviewEntry.localController?.abort();
        append({kind: 'task.blocked', task: id, text: 'termination pending: review launch has not resolved', context: view[id].context});
        return false;
      }
      const reviewResult = await stopReview(reviewEntry);
      if (reviewResult?.verified !== true) {
        append({kind: 'task.blocked', task: id, text: 'termination unverified', from: peer, context: view[id].context});
        return false;
      }
    }
    const entry = handles.get(id);
    const result = entry ? await entry.adapter.cancel(entry.handle) : {verified: true};
    if (result?.verified !== true) {
      append({kind: 'task.blocked', task: id, text: 'termination unverified', from: workerFrom(id), context: view[id].context});
      return false;
    }
    append({kind: 'task.cancelled', task: id, reason, from: workerFrom(id), context: view[id].context});
    return true;
  }

  function stopReview(entry) {
    return entry.stopping ??= Promise.resolve().then(() => entry.adapter.cancel(entry.handle)).catch(() => ({verified: false}));
  }

  function admitAttempt(task, context, {reportOnly = false} = {}) {
    const submitted = submittedRow(task);
    const jobId = submitted?.jobId;
    const starts = session.events.filter(e => e.kind === 'task.started' && e.purpose !== 'report' && (jobId ? submittedRow(e.task)?.jobId === jobId : e.task === task));
    if (!reportOnly && starts.length >= (limits.attempts ?? 3)) {
      append({kind: 'task.failed', task, reason: 'attempts_exhausted', text: 'Logical job attempt allowance exhausted; retain progress and request a scope decision', context});
      return false;
    }
    if (starts.length && clock() >= Date.parse(starts[0].time) + ceilingMs) {
      append({kind: 'task.failed', task, reason: 'deadline', text: 'Logical job ceiling exhausted', context});
      return false;
    }
    return true;
  }

  // `force` only ever applies to `taskId` itself, never its descendants: the watchdog's deadline
  // handler journals `task.deadline` (state -> `timed_out`, terminal) THEN cancels — the process
  // is still live and must actually be torn down, so this one caller needs to reach a task the
  // ordinary terminal-skip below would otherwise treat as already handled.
  async function cancel(taskId, {force = false, reason = 'user'} = {}) {
    const view = reducers.tasks(session.events);
    if (!view[taskId]) return {verified: true}; // nothing was ever submitted under this id: nothing to cancel
    let verified = true;
    for (const id of postOrder(view, taskId)) {
      if (reducers.TERMINAL.has(view[id]?.state) && !(force && id === taskId)) continue;
      if (!(await cancelOne(id, view, reason))) verified = false;
    }
    return {verified};
  }

  async function stop() {
    const view = reducers.tasks(session.events);
    const roots = Object.values(view).filter(t => !t.parent && !reducers.TERMINAL.has(t.state));
    const cancelled = [], unverified = [];
    for (const root of roots) for (const id of postOrder(view, root.id)) {
      if (reducers.TERMINAL.has(view[id]?.state)) continue;
      (await cancelOne(id, view, 'user') ? cancelled : unverified).push(id);
    }
    return {cancelled, unverified};
  }

  return {
    // An agent's derived chain, replaced wholesale from the agent files: every entry passes the
    // same policy ceiling as an activation, and entries the new chain no longer has are dropped.
    // Tasks already running keep the profile object they were dispatched with.
    replaceAgent(name, chain, local) {
      for (const [key, profile] of Object.entries(chain)) {
        if (profile.agent?.name !== name || profile.role === 'orchestrator') throw new Error(`${key} is not a backend of agent ${name}`);
        const refusal = policyRefusal(profile);
        if (refusal) throw new Error(refusal.text);
      }
      if (Object.values(chain).some(profile => LOCAL_ADAPTERS.has(profile.adapter))) {
        localResolver.configure(local);
      }
      // `name@ai` entries are this agent played by an AI Jev picked: they follow the new head, or go with `auto`.
      const played = Object.entries(profiles).filter(([, profile]) => profile.agent?.name === name && profile.ai).map(([, profile]) => [profile.ai, profile.backend ? {endpoint: profile.endpoint, model: profile.model} : null]);
      for (const key of Object.keys(profiles)) if (profiles[key].agent?.name === name && !Object.hasOwn(chain, key)) delete profiles[key];
      Object.assign(profiles, chain);
      for (const [ai, local] of played) compose(name, ai, local);
    },
    // The submit predicate, exposed so the bus refuses a malformed task.submitted before it is journaled.
    validate: spec => validate(spec, reducers.tasks(session.events)),
    // The submit decoration the bus applies before journaling a peer's task.submitted (Jev review).
    prepare,
    submit, report, acceptOverride, reworkOverride, roundsAvailable, cancel, stop, tick, reconcile,
    tasks: () => reducers.tasks(session.events),
    budgets: () => reducers.budgets(session.events),
    spend: () => reducers.spend(session.events),
    // Test-only observable for the live activity map's size (F2/A5) — never used by production code.
    _activitySize: () => activity.size,
    close: () => { closed = true; planController.abort(); for (const entry of [...launchingAttempts.values(), ...reviews.values()]) entry.localController?.abort(); for (const wake of [...campaignWaiters]) wake(); effects.close(); unsubscribe(); if (watchdogInterval) clearInterval(watchdogInterval); },
  };
}
