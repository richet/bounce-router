// Sessions::Title — a short, context-aware name for a session that has none yet, asked from a
// model once. `deriveSessionName` (session-names.js) stays the universal fallback; this fills
// the gap between that adjective-noun pair and an explicit /rename, using the first prompt and
// whatever model bounce already has on hand. Never blocks a turn, never retried once it has run
// or failed once — a failure leaves the derived name in place, silently.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {listSessions} from './sessions.js';
import {discoverLocalModels, localCandidates, normalizeLocalSettings} from './local-models.js';
import {setupAgent} from './roster-notes.js';
import {invocation, runProcess} from './providers.js';
import {resolveExecutable} from './executable.js';

const PROMPT_CHARS = 2000;
const MIN_WORDS = 2, MAX_WORDS = 5, MAX_CHARS = 40;
// The shipped local models reason and LM Studio cannot switch that off: measured live, a title took
// 1.5k-2.9k reasoning tokens (12-28 s) before any answer, and 256 tokens left the answer empty.
const LOCAL_TIMEOUT_MS = 60_000;
const LOCAL_MAX_TOKENS = 4096;
const CLOUD_TIMEOUT_MS = 60_000;
// bounce already knows this is claude's cheap/fast model (see roster-notes.js's own tier
// language); other providers have no equivalent cheap pin bounce is aware of, so they run their
// CLI default instead of guessing a model name that may not exist.
const CLOUD_SMALL_MODEL = {claude: 'haiku'};

// ---- sanitizing the model's answer -------------------------------------------------------

// A model's raw reply, folded into a short kebab-case slug: drop a <think> block, take the last
// non-empty line (models sometimes restate the instructions first), drop a leading label like
// "Title: " or surrounding quotes, lowercase, fold everything else to dashes, cap length and
// word count. Null means "unusable" — the caller skips, deriveSessionName remains the name.
export function sanitizeTitle(raw) {
  const withoutThink = String(raw ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  const lines = withoutThink.split('\n').map(l => l.trim().replace(/^["'`]+|["'`]+$/g, '')).filter(Boolean);
  const line = lines.at(-1) ?? '';
  const unlabeled = line.replace(/^[a-z][a-z0-9 ]{0,20}:\s+/i, '');
  const slug = unlabeled.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  const words = slug.split('-').filter(Boolean).slice(0, MAX_WORDS);
  while (words.length > 1 && words.join('-').length > MAX_CHARS) words.pop();
  const capped = words.join('-').slice(0, MAX_CHARS);
  if (capped.length < 2) return null; // empty or a single letter: not a usable title
  return capped;
}

// ---- the operation ------------------------------------------------------------------------

function buildPrompt(firstPrompt, cwd) {
  const workspace = path.basename(cwd || '') || 'this workspace';
  return [
    `A developer just opened a coding session in the workspace "${workspace}" and wrote this first message:`,
    '', String(firstPrompt ?? '').slice(0, PROMPT_CHARS), '',
    'Reply with ONLY a short 2-5 word lowercase title for this conversation, nothing else — no punctuation, no quotes, no explanation.',
  ].join('\n');
}

// The first name of this shape nobody else in the same root already has (case-insensitive
// against every session's name/explicitName) — `base`, else `base-2`, `base-3`, ….
function uniqueName(base, root, sessionId) {
  const taken = new Set(listSessions(root).filter(r => r.id !== sessionId)
    .flatMap(r => [r.name, r.explicitName]).filter(Boolean).map(n => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) { const candidate = `${base}-${n}`; if (!taken.has(candidate.toLowerCase())) return candidate; }
}

// Runs at most once per session: skipped outright if an explicit rename or an earlier titling
// already exists, or there is no first user prompt yet to title from. `ask` is the model call —
// injected so callers (and tests) never spawn a real process or hit a real endpoint by accident;
// see `createAsk` below for the default that a live daemon wires in.
export async function titleSession({session, settings, ask, root = session?.root, log = () => {}}) {
  if (!session) throw new Error('titleSession requires a session');
  if (session.events.some(e => e.kind === 'session.renamed' || e.kind === 'session.titled')) return null;
  const first = session.events.find(e => e.kind === 'user' && typeof e.text === 'string');
  if (!first) return null;
  log('info', 'Sessions::Title starting', {session: session.id});
  let name, model;
  try {
    const answer = await ask({prompt: buildPrompt(first.text, session.cwd), settings});
    if (!answer) return null;
    const sanitized = sanitizeTitle(answer.text);
    if (!sanitized) return null;
    name = uniqueName(sanitized, root, session.id);
    model = answer.model;
  } catch (error) {
    log('warn', 'Sessions::Title failed', {session: session.id, error: error.message});
    return null;
  }
  const row = session.append({kind: 'session.titled', name, source: 'model', model});
  log('info', 'Sessions::Title completed', {session: session.id, name, model});
  return row;
}

// ---- the default `ask`: a loaded local model, else the first signed-in cloud provider --------

// Only a model LM Studio already has loaded — this never triggers a load, unlike the rest of
// bounce's local-model path, because a session title is not worth waking a model up for.
async function askLocal(prompt, settings, {fetchImpl, timeoutMs}) {
  // Local models count once they are set up (/local setup writes settings.local) and switched on;
  // without that, a daemon would probe LM Studio's default port just to name a session.
  const local = settings?.local;
  if (!local || local.enabled === false) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const catalogs = await discoverLocalModels(local, {fetchImpl, signal: controller.signal, timeout: timeoutMs});
    const loaded = localCandidates(catalogs).find(model => model.loaded);
    if (!loaded) return null;
    const endpoint = normalizeLocalSettings(local ?? {}).endpoints[loaded.endpoint];
    const url = (endpoint?.url ?? 'http://127.0.0.1:1234').replace(/\/$/, '');
    const response = await fetchImpl(`${url}/v1/chat/completions`, {
      method: 'POST', signal: controller.signal, headers: {'content-type': 'application/json'},
      body: JSON.stringify({model: loaded.model, messages: [{role: 'user', content: prompt}], max_tokens: LOCAL_MAX_TOKENS, temperature: 0.2}),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return null;
    return {text, model: `${loaded.endpoint}/${loaded.model}`};
  } finally { clearTimeout(timer); }
}

async function askCloud(prompt, settings, {run, executables, onExit}) {
  const agent = setupAgent({profiles: settings?.profiles ?? {}, orchestrator: settings?.orchestrator, order: settings?.order ?? [], models: settings?.models ?? {}});
  if (!agent) return null;
  const model = CLOUD_SMALL_MODEL[agent.adapter] ?? agent.model ?? '';
  const dir = os.tmpdir();
  const promptFile = path.join(dir, `bounce-session-title-${randomUUID()}.txt`);
  fs.writeFileSync(promptFile, prompt, {mode: 0o600});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);
  // The CLI runs in its own process group, so it outlives an owner that exits first; abort it with the owner.
  const forget = onExit(() => controller.abort());
  const said = [], results = [];
  try {
    const result = await run({provider: agent.adapter, executable: resolveExecutable(agent.adapter, executables?.[agent.adapter]),
      args: invocation(agent.adapter, {model, mode: 'plan'}, promptFile), prompt, cwd: dir, signal: controller.signal,
      emit: e => { if (e.kind === 'assistant') said.push(e.text); else if (e.kind === 'result' && e.success) results.push(e.text); }});
    if (controller.signal.aborted || result.status !== 'completed') return null;
  } finally { clearTimeout(timer); forget(); fs.rmSync(promptFile, {force: true}); }
  const text = results.at(-1) ?? said.at(-1);
  if (!text) return null;
  return {text, model: `${agent.adapter}${model ? `/${model}` : ''}`};
}

// The default `ask`: try a loaded local model first (never both in parallel), else the first
// signed-in cloud provider, one-shot. Either path may return null — no usable answer, not an
// error — which titleSession treats as "skip, keep the derived name".
const exitHook = fn => { process.once('exit', fn); return () => process.off('exit', fn); };

export function createAsk({fetchImpl = globalThis.fetch, run = runProcess, executables = {}, onExit = exitHook} = {}) {
  return async function ask({prompt, settings}) {
    const local = await askLocal(prompt, settings, {fetchImpl, timeoutMs: LOCAL_TIMEOUT_MS}).catch(() => null);
    if (local) return local;
    return askCloud(prompt, settings, {run, executables, onExit}).catch(() => null);
  };
}
