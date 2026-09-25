// The `typesafe` live adapter: Jev (TypeSafe AI) as a completion reviewer. It is a decision
// call, not a worker — no process, no shell, no files it can touch, no session to resume —
// so it only ever launches as a review (`review` in the launch args) and ends with the
// verdict protocol every reviewer uses: the last line of `result.text` is JSON with a string
// `verdict` (src/scheduler.js parseVerdict). Registered in the live registry only
// (src/reload.js), never in src/adapters/index.js: no /login, no model catalog.
//
// Hard rules kept here: the request (headers/body) is never yielded as a `raw` event (raw
// rows are journaled verbatim); the key is read inside the client at call time and lives on
// the request header alone; every failure (no key, HTTP error, timeout, 4xx/5xx after one
// retry on 429/529) yields a `jev.skipped` row and today's verdict — accept.
import {execFile} from 'node:child_process';
import {createJevClient, decideVerdict, readJevSettings, verdictQuestions} from '../jev.js';

const DIFF_CHARS = 80_000; // ≈ 24k tokens of diff, inside Jev's 32k-token state + question cap
const ORDERS_CHARS = 12_000;
const REPORT_CHARS = 12_000;
const SUMMARY_CHARS = 4_000;
const TEST_LINES = 80;
const TEST_LINE = /(^#\s*(pass|fail|tests|skipped)\b)|(\b\d+\s+(passing|failing|pending|passed|failed|tests?|assertions?)\b)|(\b(PASS|FAIL|ok|not ok)\b)|(Tests?:|Test Suites?:|✓|✔|✗|✘)/;

function makeStream() {
  const ready = [], waiting = [];
  let ended = false;
  const iterator = {
    [Symbol.asyncIterator]() { return iterator; },
    next() {
      if (ready.length) return Promise.resolve({value: ready.shift(), done: false});
      return ended ? Promise.resolve({done: true}) : new Promise(resolve => waiting.push(resolve));
    },
  };
  return {
    iterator,
    push(event) {
      if (ended) return;
      const waiter = waiting.shift();
      if (waiter) waiter({value: event, done: false}); else ready.push(event);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiting.splice(0)) waiter({done: true});
    },
  };
}

// Bounded git reads; any failure (not a repo, timeout) reads as empty rather than blocking the verdict.
function defaultGit(args, cwd, signal) {
  return new Promise(resolve => {
    try {
      execFile('git', args, {cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, signal, windowsHide: true}, (error, stdout) => resolve(error ? '' : String(stdout ?? '')));
    } catch { resolve(''); }
  });
}

const truncate = (text, max, what) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}\n[… ${what} truncated at ${max} characters …]` : value;
};

export function testOutputLines(report) {
  const sources = [report?.text, ...(Array.isArray(report?.evidence) ? report.evidence : [])].filter(value => typeof value === 'string');
  const lines = sources.flatMap(text => text.split('\n')).map(line => line.trim()).filter(line => line && TEST_LINE.test(line));
  return lines.slice(0, TEST_LINES);
}

// The state Jev judges: the orders, the worker's final report, the diff of the working tree
// against the task's start ref (falling back to HEAD outside a recorded start), untracked
// files, and the test result lines found in the report — nothing from the journal beyond that.
export async function buildReviewState({review, reviewState = null, cwd, git = defaultGit, signal} = {}) {
  if (reviewState && typeof reviewState === 'object') {
    const report = reviewState.report ?? review?.report ?? {};
    const files = Array.isArray(reviewState.files) ? reviewState.files.map(String).slice(0, 200) : [];
    return {
      orders: truncate(reviewState.orders ?? review?.orders, ORDERS_CHARS, 'orders'),
      report: {
        summary: truncate(report.summary ?? review?.summary ?? '', SUMMARY_CHARS, 'summary'),
        text: truncate(report.text ?? '', REPORT_CHARS, 'report'),
        evidence: Array.isArray(report.evidence) ? report.evidence.slice(0, 32).map(item => String(item).slice(0, 400)) : [],
        remaining: typeof report.remaining === 'string' ? report.remaining.slice(0, 2000) : '',
      },
      diff: truncate(reviewState.diff ?? '', DIFF_CHARS, 'diff'),
      diff_base: reviewState.baseHead ?? null,
      untracked_files: files,
      test_output: testOutputLines(report),
    };
  }
  const report = review?.report ?? {};
  const base = typeof review?.head === 'string' && review.head ? review.head : 'HEAD';
  let diff = await git(['diff', base, '--'], cwd, signal);
  if (!diff && base !== 'HEAD') diff = await git(['diff', 'HEAD', '--'], cwd, signal);
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], cwd, signal)).split('\n').map(line => line.trim()).filter(Boolean).slice(0, 200);
  return {
    orders: truncate(review?.orders, ORDERS_CHARS, 'orders'),
    report: {
      summary: truncate(report.summary ?? review?.summary ?? '', SUMMARY_CHARS, 'summary'),
      text: truncate(report.text ?? '', REPORT_CHARS, 'report'),
      evidence: Array.isArray(report.evidence) ? report.evidence.slice(0, 32).map(item => String(item).slice(0, 400)) : [],
      remaining: typeof report.remaining === 'string' ? report.remaining.slice(0, 2000) : '',
    },
    diff: truncate(diff, DIFF_CHARS, 'diff'),
    diff_base: base,
    untracked_files: untracked,
    test_output: testOutputLines(report),
  };
}

async function askVerdict({stream, client, state, profile, settings, controller}) {
  stream.push({kind: 'activity', text: `Jev verdict · asking ${profile?.model || settings.model}`});
  let result;
  try {
    result = await client.ask({state, questions: verdictQuestions(), model: profile?.model || settings.model, signal: controller.signal});
  } catch (error) {
    const reason = error?.code ?? 'error';
    stream.push({kind: 'jev', name: 'skipped', data: {reason}, text: `Jev verdict unavailable · ${error?.message ?? String(error)}`});
    stream.push({kind: 'result', status: 'completed', text: JSON.stringify({verdict: 'unavailable', jev: 'skipped', reason})});
    return;
  }
  const decision = decideVerdict(result.answers, {confidence: settings.confidence, state});
  const fired = decision.fired.length ? ` · fired: ${decision.fired.join(', ')}` : '';
  stream.push({kind: 'model', model: result.model});
  if (result.usage && Number.isFinite(result.usage.input_tokens)) stream.push({kind: 'usage', usage: {input: result.usage.input_tokens, output: result.usage.output_tokens ?? 0}});
  stream.push({kind: 'jev', name: 'verdict', data: {verdict: decision.verdict, choice: decision.choice, confidence: decision.confidence, threshold: decision.threshold, probabilities: decision.probabilities, checks: decision.checks, fired: decision.fired, model: result.model, latencyMs: result.latencyMs, diffBase: state.diff_base},
    text: `Jev verdict · ${decision.verdict}${decision.choice && decision.choice !== decision.verdict ? ` (chose ${decision.choice} below threshold)` : ''} · confidence ${decision.confidence.toFixed(2)} of ${decision.threshold}${fired} · ${result.latencyMs} ms`});
  stream.push({kind: 'result', status: 'completed', text: JSON.stringify({verdict: decision.verdict, findings: decision.findings, confidence: decision.confidence, source: 'jev'})});
}

export function createTypesafeLive({fetchImpl, readKey, readSettings = () => readJevSettings(), git = defaultGit, clock = Date.now, timeoutMs} = {}) {
  const client = createJevClient({...(fetchImpl ? {fetchImpl} : {}), ...(readKey ? {readKey} : {}), ...(timeoutMs ? {timeoutMs} : {}), clock});

  const skipped = (stream, reason, text) => {
    stream.push({kind: 'jev', name: 'skipped', data: {reason}, text: `Jev verdict unavailable · ${text ?? reason}`});
    stream.push({kind: 'result', status: 'completed', text: JSON.stringify({verdict: 'unavailable', jev: 'skipped', reason})});
  };

  async function run(handle, {profile, cwd, review, reviewState}) {
    const {stream, controller} = handle;
    const settings = readSettings();
    if (review.stage !== 'completion') return skipped(stream, 'stage', `${review.stage} review is not a Jev decision`);
    if (!settings.enabled) return skipped(stream, 'disabled', 'Jev is disabled (/jev on)');
    if (!settings.review) return skipped(stream, 'review_off', 'Jev completion review is off (/jev review on)');
    // A launch context carries the scheduler's per-attempt snapshot, including an unborn repository.
    // The legacy fallback below remains for callers that have not adopted that context yet.
    if (reviewState && typeof reviewState === 'object') {
      stream.push({kind: 'activity', text: 'Jev verdict · collecting the report and attempt diff'});
      const state = await buildReviewState({review, reviewState, cwd, git, signal: controller.signal});
      if (controller.signal.aborted) return skipped(stream, 'aborted', 'cancelled');
      return askVerdict({stream, client, state, profile, settings, controller});
    }
    // Every verdict question is about the diff. Outside a repository there is none: an empty diff
    // reads as "nothing was done" and sends correct work back for rework round after round (observed
    // live), so Jev is not asked at all.
    if ((await git(['rev-parse', '--is-inside-work-tree'], cwd, controller.signal)).trim() !== 'true') return skipped(stream, 'no_repository', 'the working folder is not a git repository, so there is no diff to judge');
    // A repository with no commit yet (`git init`, nothing tracked) is inside a work tree, but every
    // diff against it is empty. Observed live: a worker that made the change and passed every gate was
    // sent back three times on `empty_diff`.
    if (!(await git(['rev-parse', '--verify', 'HEAD'], cwd, controller.signal)).trim()) return skipped(stream, 'no_repository', 'the working folder has no commit to diff against, so there is no diff to judge');
    stream.push({kind: 'activity', text: 'Jev verdict · collecting the report and diff'});
    const state = await buildReviewState({review, cwd, git, signal: controller.signal});
    if (controller.signal.aborted) return skipped(stream, 'aborted', 'cancelled');
    return askVerdict({stream, client, state, profile, settings, controller});
  }

  return {
    // The scheduler's own client seam for routing decisions (src/jev.js routeTask).
    ask: client.ask,
    async launch(args) {
      if (!args?.review) throw Object.assign(new Error('typesafe profiles run only as completion reviewers; they cannot carry out a task'), {code: 'unsupported'});
      const stream = makeStream();
      const controller = new AbortController();
      const abort = () => controller.abort(args.signal?.reason);
      if (args.signal?.aborted) abort(); else args.signal?.addEventListener('abort', abort, {once: true});
      const handle = {stream, controller, done: null, startedAt: clock()};
      handle.done = run(handle, args)
        .catch(error => skipped(stream, 'error', error?.message ?? String(error)))
        .finally(() => { args.signal?.removeEventListener('abort', abort); stream.end(); });
      return handle;
    },
    events: handle => handle.stream.iterator,
    async cancel(handle) {
      handle.controller.abort();
      await handle.done;
      return {verified: true};
    },
    async deliver() { return 'queued'; },
    capabilities: () => ({executionPolicies: ['read-only']}),
  };
}
