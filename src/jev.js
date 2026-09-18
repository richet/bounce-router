// Jev (TypeSafe AI's System One decision model) as an optional decision primitive: settings,
// the API key's secret store, the HTTP client, and the pure question/decision helpers the
// completion-verdict reviewer (src/adapters/typesafe-live.js) and the model router
// (scheduler dispatch of `profile: "auto"`) share. Everything here is OFF by default; with
// `jev.enabled` false, or the key/endpoint unavailable, callers fall through to today's
// behaviour and journal why (`jev.skipped`).
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

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

// ---- settings (config.json `jev`, never the key) ------------------------------------------

export function normalizeJevSettings(input) {
  const raw = isObject(input) ? input : {};
  const routing = isObject(raw.routing)
    ? {enabled: bool(raw.routing.enabled, false), default: typeof raw.routing.default === 'string' && raw.routing.default ? raw.routing.default : null}
    : {enabled: bool(raw.routing, false), default: null};
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
export function decideVerdict(answers, {confidence = 0.8} = {}) {
  const decision = isObject(answers?.decision) ? answers.decision : {};
  const choice = typeof decision.choice === 'string' ? decision.choice : null;
  const conf = Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : 0;
  const checks = Object.fromEntries(Object.keys(VERDICT_CHECKS).map(name => [name, Number.isFinite(Number(answers?.[name]?.noul)) ? Number(answers[name].noul) : null]));
  const fired = Object.keys(VERDICT_CHECKS).filter(name => checks[name] !== null && checks[name] >= 0.5);
  const rework = choice === 'rework' && conf >= confidence;
  const findings = rework ? (fired.length ? fired.map(name => VERDICT_CHECKS[name].fix) : ['Jev judged the work not ready against the orders; re-read the orders and the report against the diff before resubmitting.']) : [];
  return {verdict: rework ? 'rework' : 'accept', choice, confidence: conf, threshold: confidence, probabilities: isObject(decision.probabilities) ? decision.probabilities : {}, checks, fired, findings};
}

// ---- model routing: a Choice over the roster plus Nouls for the access the orders need ----

const routable = ([, profile]) => profile && profile.role !== 'orchestrator' && profile.adapter !== 'typesafe';

// The profile `auto` resolves to when routing is off, unavailable or unconfident: the configured
// default if it names a routable profile, else the first writing builder that is not the
// orchestrator. Null when the roster has no such profile.
export function routingFallback(profiles = {}, preferred = null) {
  if (preferred && routable([preferred, profiles[preferred]])) return preferred;
  return Object.entries(profiles).find(entry => routable(entry) && entry[1].policy === 'write' && entry[1].role === 'builder')?.[0]
    ?? Object.entries(profiles).find(entry => routable(entry) && entry[1].policy === 'write')?.[0]
    ?? null;
}

const TIER_HINT = {cheapest: 'cheapest: locating files, symbols and call sites; extracting structured facts', mid: 'mid: research, routine implementation, test triage', strongest: 'strongest: independent review, ambiguous or cross-cutting debugging, security-sensitive work'};

export function routingQuestions(profiles = {}) {
  const criteria = Object.fromEntries(Object.entries(profiles).filter(routable).map(([name, p]) => [name, [
    `${p.adapter}${p.model ? `/${p.model}` : ''}`, `role ${p.role ?? 'builder'}`, `policy ${p.policy ?? 'write'}${p.policy === 'read-only' ? ' (cannot edit files or run commands)' : ''}`,
    p.tier ? `tier ${TIER_HINT[p.tier] ?? p.tier}` : '',
  ].filter(Boolean).join(' · ')]));
  return {
    profile: {
      type: 'choice',
      instructions: {
        question: 'Which worker profile should carry out these orders?',
        guidance: 'Prefer the cheapest tier whose contract fits: cheapest for locating files and extracting facts, mid for research and routine implementation, strongest for independent review, ambiguous or cross-cutting debugging and security-sensitive work. A read-only profile cannot edit files or run commands.',
      },
      criteria,
    },
    needs_write: {type: 'noul', instructions: 'Carrying out these orders requires creating, editing or deleting files in the repository.'},
    needs_shell: {type: 'noul', instructions: 'Carrying out these orders requires running commands in a shell (tests, builds, scripts, git).'},
  };
}

// Pure: the top choice wins only with confidence at or above the threshold and a policy that
// satisfies the access the Nouls say the orders need; otherwise the fallback, with the reason.
export function decideRoute(answers, {profiles = {}, confidence = 0.8, fallback = null} = {}) {
  const answer = isObject(answers?.profile) ? answers.profile : {};
  const chosen = typeof answer.choice === 'string' ? answer.choice : null;
  const conf = Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : 0;
  const needs = {write: Number(answers?.needs_write?.noul ?? 0) >= 0.5, shell: Number(answers?.needs_shell?.noul ?? 0) >= 0.5};
  let reason = null;
  if (!chosen || !routable([chosen, profiles[chosen]])) reason = 'no routable choice';
  else if (conf < confidence) reason = `confidence ${conf.toFixed(2)} below ${confidence}`;
  else if ((needs.write || needs.shell) && profiles[chosen].policy !== 'write') reason = `${chosen} is read-only but the orders need ${needs.write ? 'write' : 'shell'} access`;
  return {chosen: reason ? fallback : chosen, fallback: Boolean(reason), reason, probabilities: isObject(answer.probabilities) ? answer.probabilities : {}, confidence: conf, needs};
}

// The whole routing decision for one submitted task. Never throws: any Jev failure is a
// fallback with its reason, so `profile: "auto"` always resolves when a fallback exists.
export async function routeTask({orders, profiles, settings, ask, signal} = {}) {
  const s = normalizeJevSettings(settings);
  const fallback = routingFallback(profiles, s.routing.default);
  const off = reason => ({chosen: fallback, fallback: true, reason, probabilities: {}, confidence: 0, needs: null, model: null});
  if (!s.enabled) return off('jev disabled');
  if (!s.routing.enabled) return off('routing off');
  if (typeof ask !== 'function') return off('routing unavailable');
  const questions = routingQuestions(profiles);
  if (!Object.keys(questions.profile.criteria).length) return off('no routable profiles');
  try {
    const result = await ask({state: {orders: String(orders ?? '').slice(0, 24_000)}, questions, model: s.model, signal});
    return {...decideRoute(result.answers, {profiles, confidence: s.confidence, fallback}), model: result.model, latencyMs: result.latencyMs};
  } catch (error) {
    return off(error?.code ?? error?.message ?? 'error');
  }
}

// The read-only critic profile the daemon registers so a root task's `review.completion`
// can name it. `model: ''` leaves the model to the settings read at verdict time.
export function jevReviewerProfile(settings = {}) {
  return {adapter: 'typesafe', model: '', mode: settings.mode === 'plan' ? 'plan' : 'yolo', policy: 'read-only', fallback: [], role: 'critic', executables: {...(settings.executables ?? {})}};
}

// The scheduler's `jev` seam: settings read at use time, the reviewer name, and the router
// bound to the typesafe adapter's client.
export function createJevDecisions({root = dataRoot(), adapter, readSettings = () => readJevSettings(root)} = {}) {
  return {
    reviewer: JEV_REVIEWER,
    settings: readSettings,
    route: ({orders, profiles, signal}) => routeTask({orders, profiles, settings: readSettings(), ask: adapter?.ask, signal}),
  };
}

// User-only control row from the TUI after `/jev …` saved config.json: the daemon re-reads the
// settings, refreshes the orchestrator's standing orders and confirms with a status row.
// The row carries no key material: the daemon reads the secret store itself for the status.
export function createJevActivation({session, readSettings, readKey = () => readJevKey(), refresh = () => {}}) {
  return session.subscribe(row => {
    if (row.kind !== 'control.jev' || row.from !== 'user') return;
    let warning = '';
    try { refresh(); } catch (error) { warning = ` Standing orders could not be refreshed: ${error.message}.`; }
    session.append({kind: 'status', text: `${jevStatusLine(readSettings(), readKey())} · applies to the next decision${warning}`});
  });
}
