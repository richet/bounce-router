// Jev (TypeSafe AI's System One decision model) as an optional decision primitive: settings,
// the API key's secret store, the HTTP client, and the pure question/decision helpers the
// completion-verdict reviewer (src/adapters/typesafe-live.js) and the model router
// (scheduler dispatch of `profile: "auto"`) share. Jev itself is OFF by default; once
// `jev.enabled` is on, everything it can do (verdicts and routing) is on unless switched off.
// With it off, or the key/endpoint unavailable, callers fall through to today's behaviour
// and journal why (`jev.skipped`).
//
// Jev answers typed questions over a `state`: a Choice picks one option and carries a
// probability distribution plus a confidence; a Noul is a yes/no probability. It emits no
// text, so every decision below is combined in code, and the sanctioned pattern of gating
// on confidence (below the threshold → today's behaviour) is applied everywhere.
import fs from 'node:fs';
import path from 'node:path';
import {dataRoot, saveJSON} from './core.js';

export const JEV_DEFAULT_MODEL = 'jev-1.13.0'; // pinned: an alias (`jev-latest`) moves between releases and shifts calibrated thresholds
export const JEV_REVIEWER = 'jev'; // the synthetic read-only critic profile the daemon registers
export const JEV_KEY_ENV = 'TYPESAFE_API_KEY';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_TIMEOUT_MS = 10_000;
export const PROFILE_TIERS = ['cheapest', 'mid', 'strongest'];
// A tier is a three-way question Jev answers well (measured live: right 5/5 at 0.60–1.00), so it
// decides at a lower bar than a choice between named profiles, which never reached 0.8.
export const JEV_TIER_CONFIDENCE = 0.6;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

// ---- settings (config.json `jev`, never the key) ------------------------------------------

// Both switches default ON: enabling Jev means everything it does, and a switch exists only
// to turn one part off.
export function normalizeJevSettings(input) {
  const raw = isObject(input) ? input : {};
  const routing = isObject(raw.routing)
    ? {enabled: bool(raw.routing.enabled, true), default: typeof raw.routing.default === 'string' && raw.routing.default ? raw.routing.default : null}
    : {enabled: bool(raw.routing, true), default: null};
  const confidence = typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0.8;
  return {
    enabled: bool(raw.enabled, false),
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : JEV_DEFAULT_MODEL,
    review: bool(raw.review, true),
    routing,
    confidence,
  };
}

// The shape written back to config.json: `routing` stays a plain boolean until a default is set.
export function persistedJevSettings(settings) {
  const n = normalizeJevSettings(settings);
  return {enabled: n.enabled, model: n.model, review: n.review, routing: n.routing.default ? {enabled: n.routing.enabled, default: n.routing.default} : n.routing.enabled, confidence: n.confidence};
}

// Read at use time (the daemon never caches it), so `/jev on` in the TUI applies to the next
// decision without a restart. A missing or unreadable config reads as disabled.
export function readJevSettings(root = dataRoot()) {
  try { return normalizeJevSettings(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).jev); }
  catch { return normalizeJevSettings(); }
}

export function jevStatusLine(settings, key) {
  const s = normalizeJevSettings(settings);
  const keyText = key ? `key …${key.key.slice(-4)} (${key.source})` : 'no key';
  const routing = s.routing.enabled ? `routing on${s.routing.default ? ` (default ${s.routing.default})` : ''}` : 'routing off';
  return `Jev (TypeSafe): ${s.enabled ? 'enabled' : 'disabled'} · ${keyText} · model ${s.model} · review ${s.review ? 'on' : 'off'} · ${routing} · confidence ${s.confidence}`;
}

// One short token for the sidebar's provider · mode line (≤ 11 chars so the 30-column rail
// keeps the whole line); empty when Jev does nothing.
export function jevSidebarLabel(settings) {
  const s = normalizeJevSettings(settings);
  if (!s.enabled) return '';
  if (s.review && s.routing.enabled) return 'jev+routing';
  if (s.routing.enabled) return 'jev routing';
  return s.review ? 'jev' : 'jev idle';
}

// ---- the key: env overrides a 0600 file under the data root; never config.json, never a journal ----

const secretsFile = root => path.join(root, 'secrets.json');
const readSecrets = root => { try { const value = JSON.parse(fs.readFileSync(secretsFile(root), 'utf8')); return isObject(value) ? value : {}; } catch { return {}; } };

export function readJevKey({root = dataRoot(), env = process.env} = {}) {
  const fromEnv = env?.[JEV_KEY_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return {key: fromEnv.trim(), source: 'env'};
  const fromFile = readSecrets(root).typesafe;
  if (typeof fromFile === 'string' && fromFile.trim()) return {key: fromFile.trim(), source: 'file'};
  return null;
}

export function writeJevKey(key, {root = dataRoot()} = {}) {
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key.trim())) throw new Error('The TypeSafe key must be a single non-empty token');
  saveJSON(secretsFile(root), {...readSecrets(root), typesafe: key.trim()}); // saveJSON writes 0600 under a 0700 dir
  try { fs.chmodSync(secretsFile(root), 0o600); } catch {}
}

export function clearJevKey({root = dataRoot()} = {}) {
  const {typesafe, ...rest} = readSecrets(root);
  if (typesafe === undefined) return false;
  saveJSON(secretsFile(root), rest);
  return true;
}

// ---- HTTP client: one POST, Bearer key read at call time, 10 s timeout, one retry on 429/529 ----

const jevError = (code, message) => Object.assign(new Error(message), {code});

// `retry-after` is seconds or an HTTP date; anything unreadable waits a short fixed beat.
export function retryAfterMs(header, {now = Date.now(), max = 15_000, fallback = 1_000} = {}) {
  if (header == null || header === '') return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(max, Math.max(0, seconds * 1000));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(max, Math.max(0, at - now));
  return fallback;
}

export function createJevClient({fetchImpl = (...args) => globalThis.fetch(...args), readKey = () => readJevKey(), endpoint = JEV_ENDPOINT, timeoutMs = JEV_TIMEOUT_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now} = {}) {
  async function once(body, key, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(jevError('aborted', 'TypeSafe request cancelled'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(jevError('timeout', `TypeSafe request timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      return await fetchImpl(endpoint, {method: 'POST', headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'}, body: JSON.stringify(body), signal: controller.signal});
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason?.code) throw controller.signal.reason;
      throw jevError('network', `TypeSafe request failed: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  // Resolves {answers, model, usage, latencyMs}; rejects with error.code in
  // missing_key | timeout | aborted | network | http_<status> | protocol. The key is read
  // here and only ever placed on the request header — never on the error, never returned.
  async function ask({state, questions, model = JEV_DEFAULT_MODEL, signal} = {}) {
    const found = readKey();
    if (!found?.key) throw jevError('missing_key', `No TypeSafe API key: set ${JEV_KEY_ENV} or run /jev key`);
    const body = {state, model, questions};
    const started = clock();
    for (let attempt = 0; ; attempt++) {
      const response = await once(body, found.key, signal);
      const status = Number(response?.status ?? 0);
      if ((status === 429 || status === 529) && attempt === 0) {
        await sleep(retryAfterMs(response.headers?.get?.('retry-after'), {now: clock()}));
        if (signal?.aborted) throw jevError('aborted', 'TypeSafe request cancelled');
        continue;
      }
      if (!response?.ok) {
        let detail = '';
        try { detail = String(await response.text()).slice(0, 300); } catch {}
        throw jevError(`http_${status || 'error'}`, `TypeSafe HTTP ${status || 'error'}${detail ? `: ${detail}` : ''}`);
      }
      let json;
      try { json = await response.json(); } catch { throw jevError('protocol', 'TypeSafe returned a non-JSON body'); }
      if (!isObject(json) || !isObject(json.answers)) throw jevError('protocol', 'TypeSafe response carries no answers');
      return {answers: json.answers, model: typeof json.model === 'string' ? json.model : model, usage: isObject(json.usage) ? json.usage : null, latencyMs: clock() - started};
    }
  }

  return {ask};
}

// ---- completion verdict: one Choice {accept, rework} plus narrow Nouls over {orders, report, diff} ----

// Each check is one narrow yes/no over the same state; a check that fires (≥ 0.5) becomes a
// must-fix line in the rework round. Instructions are literal on purpose: Jev answers the
// question written, and one judgement per question keeps the answers independent.
export const VERDICT_CHECKS = {
  outside_scope: {
    instructions: 'The diff changes files outside the paths the orders name as owned, allowed or in scope for this task.',
    fix: 'The diff touches files outside the owned paths the orders name; revert those changes or keep them inside scope.',
  },
  forbidden_files: {
    instructions: 'The diff changes a file or area the orders explicitly say must not be changed.',
    fix: 'The diff changes something the orders forbid changing; revert it.',
  },
  unbacked_tests: {
    instructions: 'The report claims tests were run or passed, but the report shows no test output or result lines for them.',
    fix: 'The report claims tests it shows no output for; run them and include the actual result lines.',
  },
  remaining_work: {
    instructions: 'The report says the task is done, yet its summary or text names work that is still remaining or left out.',
    fix: 'The report says done but names remaining work; finish it or report the task as blocked/failed with what is left.',
  },
  unmet_acceptance: {
    instructions: 'An acceptance criterion or required deliverable stated in the orders is not met by the diff and the report together.',
    fix: 'An acceptance criterion in the orders is not met; address it and show how it is met.',
  },
  unverified_claims: {
    instructions: 'The report asserts an outcome (works, verified, fixed, passes) without any command output, file or artifact in the report or diff backing it.',
    fix: 'The report asserts outcomes without evidence; back each claim with command output, a file or an artifact.',
  },
  empty_diff: {
    instructions: 'The orders require repository changes, but the diff is empty or unrelated to what the orders ask for.',
    fix: 'The orders require repository changes but the diff shows none that address them.',
  },
};

export function verdictQuestions() {
  return {
    decision: {
      type: 'choice',
      instructions: 'Given the orders, the worker\'s final report and the diff of its changes, should this task be accepted as done or sent back to the same worker for rework?',
      criteria: {
        accept: 'The diff and the report satisfy the orders: scope respected, claims backed by output or files, no material work left undone.',
        rework: 'Something material is wrong or missing: scope violated, a claim unbacked, an acceptance criterion unmet, or named work remaining.',
      },
    },
    ...Object.fromEntries(Object.entries(VERDICT_CHECKS).map(([name, check]) => [name, {type: 'noul', instructions: check.instructions}])),
  };
}

// Pure: `rework` only when the Choice says so with confidence at or above the threshold;
// anything else (accept, low confidence, an unexpected answer shape) is today's accept.
export function decideVerdict(answers, {confidence = 0.8, state = null} = {}) {
  const decision = isObject(answers?.decision) ? answers.decision : {};
  const choice = typeof decision.choice === 'string' ? decision.choice : null;
  const conf = Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : 0;
  const checks = Object.fromEntries(Object.keys(VERDICT_CHECKS).map(name => [name, Number.isFinite(Number(answers?.[name]?.noul)) ? Number(answers[name].noul) : null]));
  const firedRaw = Object.keys(VERDICT_CHECKS).filter(name => checks[name] !== null && checks[name] >= 0.5);
  // A check the state itself contradicts is not a finding the worker can act on: `empty_diff` says
  // the diff shows nothing, so when the diff Jev was shown is not empty the check is dropped. A rework
  // that keeps no actionable finding is an accept. (Observed live: a correct change sent back three
  // times on checks it could not satisfy.)
  const dropped = state && typeof state.diff === 'string' && state.diff.trim() ? firedRaw.filter(name => name === 'empty_diff') : [];
  const fired = firedRaw.filter(name => !dropped.includes(name));
  const rework = choice === 'rework' && conf >= confidence && !(dropped.length && !fired.length);
  const findings = rework ? (fired.length ? fired.map(name => VERDICT_CHECKS[name].fix) : ['Jev judged the work not ready against the orders; re-read the orders and the report against the diff before resubmitting.']) : [];
  return {verdict: rework ? 'rework' : 'accept', choice, confidence: conf, threshold: confidence, probabilities: isObject(decision.probabilities) ? decision.probabilities : {}, checks, fired, ...(dropped.length ? {dropped} : {}), findings};
}

// ---- model routing: a Choice over the roster plus Nouls for the access the orders need ----

// Every worker profile is a routing target except the orchestrator, a decision model, and the
// backends derived from an agent file: `auto` chooses between AIs, while an agent is a job the
// orchestrator names, with its own ordered list of AIs.
export const routable = ([, profile]) => Boolean(profile) && profile.role !== 'orchestrator' && profile.adapter !== 'typesafe' && profile.derived !== true;

// The profile `auto` resolves to when routing is off, unavailable or unconfident: the configured
// default if it names a routable profile, else the first writing builder that is not the
// orchestrator. Null when the roster has no such profile.
export function routingFallback(profiles = {}, preferred = null) {
  if (preferred && routable([preferred, profiles[preferred]])) return preferred;
  return Object.entries(profiles).find(entry => routable(entry) && entry[1].policy === 'write' && entry[1].role === 'builder')?.[0]
    ?? Object.entries(profiles).find(entry => routable(entry) && entry[1].policy === 'write')?.[0]
    ?? null;
}

export const TIER_HINT = {cheapest: 'cheapest: locating files, symbols and call sites; extracting structured facts', mid: 'mid: research, routine implementation, test triage', strongest: 'strongest: independent review, ambiguous or cross-cutting debugging, security-sensitive work'};

// One criterion per routable profile: what it runs on, what it may do, and — from the profile's
// own `tier`/`capabilities` or the roster notes bounce wrote for its model (src/roster-notes.js)
// — what the model is good and bad at, so the choice weighs ability, not just names.
// The jobs `auto` may choose between: the head of each agent file's derived chain (its hidden
// `name~n` backends are the AIs that may play it, not separate jobs).
export const agentHeads = (profiles = {}) => Object.entries(profiles).filter(([name, p]) => p?.derived === true && p.agent?.name === name && p.role !== 'orchestrator');

// `job: true` describes the profile as an AI only — the role and policy are the job's, not its.
const profileCriteria = (profiles, notes, {job = false} = {}) => Object.fromEntries(Object.entries(profiles).filter(routable).map(([name, p]) => {
  const tier = p.tier ?? notes[name]?.tier;
  const capabilities = p.capabilities ?? notes[name]?.capabilities;
  return [name, [
    `${p.adapter}${p.model ? `/${p.model}` : ''}`,
    ...(job ? [] : [`role ${p.role ?? 'builder'}`, `policy ${p.policy ?? 'write'}${p.policy === 'read-only' ? ' (cannot edit files or run commands)' : ''}`]),
    tier ? `tier ${TIER_HINT[tier] ?? tier}` : '',
    capabilities ? `capabilities: ${capabilities}` : '',
  ].filter(Boolean).join(' · ')];
}));

// TIER FIRST. Jev says which tier the orders need; which profile of that tier runs them is not a
// question for a model — inside a tier the AIs are near-equal — so bounce takes the first fitting
// one in the provider order. The question offers only tiers some routable profile has (its own
// `tier`, else the roster notes'), and is left out entirely for a roster nobody tiered.
const tierOf = (name, profile, notes) => profile.tier ?? notes?.[name]?.tier;
const tierQuestion = (profiles, notes, locals = []) => {
  const present = PROFILE_TIERS.filter(tier => locals.some(item => item.tier === tier) || Object.entries(profiles).some(entry => routable(entry) && tierOf(entry[0], entry[1], notes) === tier));
  return present.length ? {tier: {
    type: 'choice',
    instructions: {question: 'Which tier of AI do these orders need?', guidance: 'Pick the cheapest tier whose contract fits the orders.'},
    criteria: Object.fromEntries(present.map(tier => [tier, TIER_HINT[tier]])),
  }} : {};
};
// Pure. {name, tier, confidence, probabilities} when the tier is confident and a profile of it
// passes `fits`; otherwise {name: null, reason}. `reason` is null when no tier was asked at all.
// `locals` (src/local-models.js localCandidates) join the tier only for an agent's AI, and only while
// `/local` is on. A local model of the needed tier runs first — it costs nothing — a loaded one before
// one that would have to be loaded; the tiers do the mixing: cheap work local, the rest cloud.
// The local models an agent's own list names, by walking its derived chain from the head.
const namedLocals = (profiles, head) => {
  const names = []; const seen = new Set();
  for (let current = head; current && !seen.has(current); current = profiles[current.fallback?.[0]]) { seen.add(current); if (current.backend) names.push(`${current.endpoint}/${current.model}`); }
  return names;
};
function tierPick(answers, {profiles, notes, order = [], fits = () => true, unfit = '', locals = [], head = null}) {
  if (!isObject(answers?.tier)) return {name: null, reason: null};
  const tier = PROFILE_TIERS.includes(answers.tier.choice) ? answers.tier.choice : null;
  const confidence = Number.isFinite(Number(answers.tier.confidence)) ? Number(answers.tier.confidence) : 0;
  if (!tier) return {name: null, reason: 'no tier chosen'};
  if (confidence < JEV_TIER_CONFIDENCE) return {name: null, reason: `tier confidence ${confidence.toFixed(2)} below ${JEV_TIER_CONFIDENCE}`};
  const rank = adapter => { const at = order.indexOf(adapter); return at === -1 ? order.length : at; };
  const cloud = Object.entries(profiles).filter(entry => routable(entry) && tierOf(entry[0], entry[1], notes) === tier && fits(entry[1]))
    .sort((a, b) => rank(a[1].adapter) - rank(b[1].adapter)).map(([name]) => ({name}));
  // Between local models of the tier: the one the agent's own list names (a reviewer keeps its
  // reviewer model), then a loaded one before one that would have to be loaded.
  const named = head ? namedLocals(profiles, head) : [];
  const local = locals.filter(item => item.tier === tier).sort((a, b) => Number(named.includes(b.name)) - Number(named.includes(a.name)) || Number(b.loaded) - Number(a.loaded)).map(item => ({name: item.name, local: {endpoint: item.endpoint, model: item.model}}));
  const first = [...local, ...cloud][0] ?? null;
  const name = first?.name ?? null;
  return name ? {name, ...(first.local ? {local: first.local} : {}), tier, confidence, probabilities: isObject(answers.tier.probabilities) ? answers.tier.probabilities : {}} : {name: null, reason: `no ${tier} profile ${unfit || 'is routable'}`};
}

export function routingQuestions(profiles = {}, notes = {}) {
  const criteria = profileCriteria(profiles, notes);
  // Which JOB the orders describe, when there are agent files to choose from. `none` is always an
  // option, so a generic task keeps going to a plain worker profile exactly as before.
  const jobs = agentHeads(profiles);
  const agent = jobs.length ? {agent: {
    type: 'choice',
    instructions: {
      question: 'Which job do these orders describe?',
      guidance: 'Pick a job only when the orders clearly ask for that kind of work; a job\'s policy limits what it may do. Pick none when no listed job fits or the orders are a general implementation task.',
    },
    criteria: {...Object.fromEntries(jobs.map(([name, p]) => [name, `${p.agent.description} · policy ${p.policy}${p.policy === 'read-only' ? ' (cannot edit files or run commands)' : ''}`])),
      none: 'No listed job fits; a general worker should carry out the orders.'},
  }} : {};
  return {
    ...agent,
    ...tierQuestion(profiles, notes),
    profile: {
      type: 'choice',
      instructions: {
        question: 'Which worker profile should carry out these orders?',
        guidance: 'Weigh each profile\'s capabilities against what the orders demand, then prefer the cheapest tier whose contract fits: cheapest for locating files and extracting facts, mid for research and routine implementation, strongest for independent review, ambiguous or cross-cutting debugging and security-sensitive work. A read-only profile cannot edit files or run commands.',
      },
      criteria,
    },
    needs_write: {type: 'noul', instructions: 'Carrying out these orders requires creating, editing or deleting files in the repository.'},
    needs_shell: {type: 'noul', instructions: 'Carrying out these orders requires running commands in a shell (tests, builds, scripts, git).'},
  };
}

// Pure: the top choice wins only with confidence at or above the threshold and a policy that
// satisfies the access the Nouls say the orders need; otherwise the fallback, with the reason.
export function decideRoute(answers, {profiles = {}, confidence = 0.8, fallback = null, notes = {}, order = [], locals = []} = {}) {
  const answer = isObject(answers?.profile) ? answers.profile : {};
  const chosen = typeof answer.choice === 'string' ? answer.choice : null;
  const conf = Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : 0;
  const needs = {write: Number(answers?.needs_write?.noul ?? 0) >= 0.5, shell: Number(answers?.needs_shell?.noul ?? 0) >= 0.5};
  // The job first. A confident job whose policy fits the access the orders need is the route: the
  // task goes to that agent, and the agent file's own `models:` order decides the AI — Jev never
  // overrides a list a person wrote. Anything less is `agent: null` and the profile choice below.
  let job = {};
  if (isObject(answers?.agent)) {
    const name = typeof answers.agent.choice === 'string' ? answers.agent.choice : null;
    const jobConfidence = Number.isFinite(Number(answers.agent.confidence)) ? Number(answers.agent.confidence) : 0;
    const head = name && name !== 'none' ? agentHeads(profiles).find(([candidate]) => candidate === name)?.[1] : null;
    const why = !name || name === 'none' ? 'no job fits' : !head ? 'no such job'
      : jobConfidence < confidence ? `job confidence ${jobConfidence.toFixed(2)} below ${confidence}`
      // Only WRITE access is a hard misfit for a job. Measured live: Jev scores "needs a shell" at
      // 0.6–0.8 for plain searching and reviewing, while picking the read-only analyst/reviewer at
      // 0.99–1.00 from criteria that already say "cannot edit files or run commands" — so the shell
      // need is weighed in the job choice itself. A read-only job genuinely cannot produce edits.
      : needs.write && head.policy !== 'write' ? `${name} is read-only but the orders need write access` : null;
    // An agent whose `models:` opens with `auto` also takes this ask's AI answer, when it is a
    // confident one; the scheduler composes the two. Any other agent keeps the list a person wrote.
    // Local models are candidates for a job's AI only; a plain worker profile is never local.
    const picked = !why && head.auto ? decideAI(answers, {profiles, confidence, notes, order, locals, head}) : null;
    if (!why) return {chosen: name, agent: name, ...(picked?.ai ? {ai: picked.ai, ...(picked.local ? {local: picked.local} : {})} : {}), fallback: false, reason: null, probabilities: isObject(answers.agent.probabilities) ? answers.agent.probabilities : {}, confidence: jobConfidence, needs};
    job = {agent: null, agentReason: why};
  }
  // The tier first; a named profile chosen with confidence is the second chance.
  const access = needs.write || needs.shell;
  const tiered = tierPick(answers, {profiles, notes, order, fits: profile => !access || profile.policy === 'write', unfit: access ? `can ${needs.write ? 'write' : 'run commands'}` : ''});
  if (tiered.name) return {chosen: tiered.name, tier: tiered.tier, fallback: false, reason: null, probabilities: tiered.probabilities, confidence: tiered.confidence, needs, ...job};
  let reason = null;
  if (!chosen || !routable([chosen, profiles[chosen]])) reason = 'no routable choice';
  else if (conf < confidence) reason = `confidence ${conf.toFixed(2)} below ${confidence}`;
  else if ((needs.write || needs.shell) && profiles[chosen].policy !== 'write') reason = `${chosen} is read-only but the orders need ${needs.write ? 'write' : 'shell'} access`;
  if (reason && tiered.reason) reason = `${tiered.reason}; ${reason}`;
  return {chosen: reason ? fallback : chosen, fallback: Boolean(reason), reason, probabilities: isObject(answer.probabilities) ? answer.probabilities : {}, confidence: conf, needs, ...job};
}

// Which AI plays an agent whose `models:` opens with `auto`. The job is given, so the question is
// about ability and cost alone: no role, no policy, no access Nouls.
export function aiQuestions(profiles = {}, notes = {}, head = null, locals = []) {
  const named = {profile: {
    type: 'choice',
    instructions: {
      question: `Which AI should do this job?${head?.agent ? ` The job: ${head.agent.description} (policy ${head.policy})` : ''}`,
      guidance: 'Weigh each AI\'s capabilities against what the orders demand, then prefer the cheapest tier that fits: cheapest for locating files and extracting facts, mid for research and routine implementation, strongest for independent review, ambiguous or cross-cutting debugging and security-sensitive work.',
    },
    criteria: {...profileCriteria(profiles, notes, {job: true}), ...Object.fromEntries(locals.map(item => [item.name, [
      `local model ${item.name}`, 'runs on this machine at no cost', ...(item.loaded ? [] : ['not loaded: choosing it costs a model load first']),
      ...(item.context ? [`context ${Math.round(item.context / 1024)}k`] : []), `tier ${TIER_HINT[item.tier] ?? item.tier}`, `capabilities: ${item.capabilities}`].join(' · ')]))},
  }};
  return {...tierQuestion(profiles, notes, locals), ...named};
}

// Pure: the AI is taken only when it is a routable profile chosen with confidence; the job's policy
// is its own, so there is no access gate here.
export function decideAI(answers, {profiles = {}, confidence = 0.8, notes = {}, order = [], locals = [], head = null} = {}) {
  const tiered = tierPick(answers, {profiles, notes, order, locals, head});
  if (tiered.name) return {ai: tiered.name, ...(tiered.local ? {local: tiered.local} : {}), tier: tiered.tier, reason: null, confidence: tiered.confidence, probabilities: tiered.probabilities};
  const answer = isObject(answers?.profile) ? answers.profile : {};
  const chosen = typeof answer.choice === 'string' ? answer.choice : null;
  const conf = Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : 0;
  const localChoice = locals.find(item => item.name === chosen);
  const named = !chosen || !(localChoice || routable([chosen, profiles[chosen]])) ? 'no routable choice' : conf < confidence ? `confidence ${conf.toFixed(2)} below ${confidence}` : null;
  const reason = named && tiered.reason ? `${tiered.reason}; ${named}` : named;
  return {ai: reason ? null : chosen, ...(!reason && localChoice ? {local: {endpoint: localChoice.endpoint, model: localChoice.model}} : {}), reason, confidence: conf, probabilities: isObject(answer.probabilities) ? answer.probabilities : {}};
}

// The AI for one task submitted to an `auto` agent. Never throws. `asked: false` means Jev was not
// consulted at all (off, or nothing to choose between), so the scheduler journals nothing.
export async function routeAgentAI({orders, profiles, head, settings, ask, notes = {}, order = [], locals = [], signal} = {}) {
  const s = normalizeJevSettings(settings);
  if (!s.enabled || !s.routing.enabled || typeof ask !== 'function') return {ai: null, asked: false};
  let known = {};
  try { known = (typeof notes === 'function' ? await notes() : notes) ?? {}; } catch { known = {}; }
  let here = [];
  try { here = (typeof locals === 'function' ? await locals() : locals) ?? []; } catch { here = []; }
  const questions = aiQuestions(profiles, known, head, here);
  if (!Object.keys(questions.profile.criteria).length) return {ai: null, asked: false};
  try {
    const result = await ask({state: {orders: String(orders ?? '').slice(0, 24_000)}, questions, model: s.model, signal});
    return {...decideAI(result.answers, {profiles, confidence: s.confidence, notes: known, order, locals: here, head}), asked: true, model: result.model, latencyMs: result.latencyMs};
  } catch (error) {
    return {ai: null, asked: true, reason: error?.code ?? error?.message ?? 'error', confidence: 0, probabilities: {}, model: null};
  }
}

// The whole routing decision for one submitted task. Never throws: any Jev failure is a
// fallback with its reason, so `profile: "auto"` always resolves when a fallback exists.
// `notes` is the roster's per-profile {tier, capabilities} (or a function returning them);
// notes that cannot be read only narrow the criteria, never the decision.
export async function routeTask({orders, profiles, settings, ask, notes = {}, order = [], locals = [], signal} = {}) {
  const s = normalizeJevSettings(settings);
  const fallback = routingFallback(profiles, s.routing.default);
  const off = reason => ({chosen: fallback, fallback: true, reason, probabilities: {}, confidence: 0, needs: null, model: null});
  if (!s.enabled) return off('jev disabled');
  if (!s.routing.enabled) return off('routing off');
  if (typeof ask !== 'function') return off('routing unavailable');
  let known = {};
  try { known = (typeof notes === 'function' ? await notes() : notes) ?? {}; } catch { known = {}; }
  const questions = routingQuestions(profiles, known);
  if (!Object.keys(questions.profile.criteria).length) return off('no routable profiles');
  try {
    const result = await ask({state: {orders: String(orders ?? '').slice(0, 24_000)}, questions, model: s.model, signal});
    let here = [];
    if (agentHeads(profiles).some(([, head]) => head.auto)) { try { here = (typeof locals === 'function' ? await locals() : locals) ?? []; } catch { here = []; } }
    return {...decideRoute(result.answers, {profiles, confidence: s.confidence, fallback, notes: known, order, locals: here}), model: result.model, latencyMs: result.latencyMs};
  } catch (error) {
    return off(error?.code ?? error?.message ?? 'error');
  }
}

// ---- the plan gate: judge a phase's breakdown before any worker runs ----------------------------

// Per chunk. Overlap and a deadline over the cap are structural and decided by bounce itself; the
// other two are what Jev is for. Found live: a 40-minute "finish P2" task; two builders on git.ts at
// once; chunks with no acceptance criterion; a chunk run against a tree another was still changing.
export const PLAN_CHECKS = {
  phase_sized: {instructions: chunk => `Chunk "${chunk}" describes a whole phase or several independent pieces of work, not one bounded piece a worker finishes in its deadline.`,
    fix: 'this is a phase, not a chunk: split it into pieces a worker finishes within the deadline, each with its own acceptance'},
  no_acceptance: {instructions: chunk => `Chunk "${chunk}" names no concrete acceptance criterion, or no way for the worker to verify it (a command, a test, an observable result).`,
    fix: 'say what done looks like and how the worker proves it (a command to run and the output that means pass)'},
  overlapping_paths: {instructions: chunk => `Chunk "${chunk}" would edit files that another chunk in this plan also edits, so two workers would write the same paths at once.`,
    fix: 'give each chunk disjoint owned paths, or make one depend on the other'},
  hidden_dependency: {instructions: chunk => `Chunk "${chunk}" needs the result of another chunk in this plan (a file it creates, a change it makes) but does not declare that dependency.`,
    fix: 'declare depends_on so it runs after the chunk it needs'},
};

const globRe = glob => new RegExp(`^${glob.split('**').map(part => part.split('*').map(seg => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
const pathsOverlap = (a, b) => a === b || globRe(a).test(b) || globRe(b).test(a);

export function planQuestions(plan) {
  const chunks = (plan?.chunks ?? []).map(c => ({id: c.id, profile: c.profile, orders: String(c.orders ?? '').slice(0, 6000), owns: c.owns ?? [], depends_on: c.depends_on ?? [],
    ...(Number.isFinite(c.deadline) ? {deadline_minutes: Math.round(c.deadline / 60000)} : {})}));
  const questions = {};
  for (const c of chunks) for (const [name, check] of Object.entries(PLAN_CHECKS)) questions[`${c.id}.${name}`] = {type: 'noul', instructions: check.instructions(c.id)};
  return {state: {phase: String(plan?.phase ?? ''), chunks}, questions};
}

// Pure. Structural findings first (no model needed), then Jev's confident ones; the rest are noted.
export function decidePlan(answers, {plan, confidence = 0.8, taskMinutes = null} = {}) {
  const chunks = plan?.chunks ?? [];
  const findings = [], noted = [];
  for (const c of chunks) {
    const others = chunks.filter(o => o !== c && !(c.depends_on ?? []).includes(o.id) && !(o.depends_on ?? []).includes(c.id));
    if ((c.owns ?? []).some(p => others.some(o => (o.owns ?? []).some(q => pathsOverlap(p, q))))) findings.push({chunk: c.id, check: 'overlapping_paths', confidence: 1, fix: PLAN_CHECKS.overlapping_paths.fix});
    if (taskMinutes && Number.isFinite(c.deadline) && c.deadline > taskMinutes * 60000) findings.push({chunk: c.id, check: 'phase_sized', confidence: 1, fix: `${PLAN_CHECKS.phase_sized.fix} (deadline ${Math.round(c.deadline / 60000)} min over the ${taskMinutes} min cap)`});
  }
  for (const c of chunks) for (const name of Object.keys(PLAN_CHECKS)) {
    if (findings.some(f => f.chunk === c.id && f.check === name)) continue;
    const v = Number(answers?.[`${c.id}.${name}`]?.noul);
    if (!Number.isFinite(v) || v < 0.5) continue;
    if (v >= confidence) findings.push({chunk: c.id, check: name, confidence: v, fix: PLAN_CHECKS[name].fix});
    else noted.push({chunk: c.id, check: name, confidence: v});
  }
  return {verdict: findings.length ? 'reject' : 'accept', findings, noted};
}

// Never throws: with Jev off or failing the plan is accepted with the reason on record, so the gate
// itself never blocks an orchestrator that plans. Structural findings are still made without Jev.
export async function judgePlan({plan, settings, ask, taskMinutes = null, signal} = {}) {
  const s = normalizeJevSettings(settings);
  const structural = decidePlan({}, {plan, confidence: s.confidence, taskMinutes});
  const off = reason => ({...structural, reason, model: null});
  if (!s.enabled) return off('jev disabled');
  if (typeof ask !== 'function') return off('routing unavailable');
  const {state, questions} = planQuestions(plan);
  if (!Object.keys(questions).length) return off('no chunks');
  try {
    const result = await ask({state, questions, model: s.model, signal});
    return {...decidePlan(result.answers, {plan, confidence: s.confidence, taskMinutes}), reason: null, model: result.model, latencyMs: result.latencyMs};
  } catch (error) { return off(error?.code ?? error?.message ?? 'error'); }
}

// The read-only critic profile the daemon registers so a root task's `review.completion`
// can name it. `model: ''` leaves the model to the settings read at verdict time.
export function jevReviewerProfile(settings = {}) {
  return {adapter: 'typesafe', model: '', mode: settings.mode === 'plan' ? 'plan' : 'yolo', policy: 'read-only', fallback: [], role: 'critic', executables: {...(settings.executables ?? {})}};
}

// The scheduler's `jev` seam: settings read at use time, the reviewer name, and the router
// bound to the typesafe adapter's client. `notes` (a function, may be async) supplies the
// roster's {tier, capabilities} per profile at route time — the roster setup of
// src/roster-notes.js in the daemon; absent, routing sees adapter/model/role/policy only.
export function createJevDecisions({root = dataRoot(), adapter, readSettings = () => readJevSettings(root), notes = null, order = () => [], locals = null} = {}) {
  return {
    reviewer: JEV_REVIEWER,
    settings: readSettings,
    plan: ({plan, taskMinutes, signal}) => judgePlan({plan, settings: readSettings(), ask: adapter?.ask, taskMinutes, signal}),
    routeAI: ({orders, profiles, head, signal}) => routeAgentAI({orders, profiles, head, order: order(), ...(locals ? {locals} : {}), settings: readSettings(), ask: adapter?.ask, ...(notes ? {notes} : {}), signal}),
    route: ({orders, profiles, signal}) => routeTask({orders, profiles, order: order(), ...(locals ? {locals} : {}), settings: readSettings(), ask: adapter?.ask, ...(notes ? {notes} : {}), signal}),
  };
}

// User-only control row from the TUI after `/jev …` saved config.json: the daemon re-reads the
// settings, refreshes the orchestrator's standing orders and confirms with a status row.
// The row carries no key material: the daemon reads the secret store itself for the status.
// `setup(row)` (the roster setup) runs afterwards when routing is on, so the models a newly
// enabled router chooses between get described without a restart; `refresh: 'roster'` on the
// row asks for the notes to be written again.
export function createJevActivation({session, readSettings, readKey = () => readJevKey(), refresh = () => {}, setup = null}) {
  return session.subscribe(row => {
    if (row.kind !== 'control.jev' || row.from !== 'user') return;
    let warning = '';
    try { refresh(); } catch (error) { warning = ` Standing orders could not be refreshed: ${error.message}.`; }
    const settings = normalizeJevSettings(readSettings());
    session.append({kind: 'status', text: `${jevStatusLine(settings, readKey())} · applies to the next decision${warning}`});
    if (setup && settings.enabled && settings.routing.enabled) Promise.resolve().then(() => setup({force: row.refresh === 'roster'})).catch(() => {});
  });
}
