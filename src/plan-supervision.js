const terminal = (events, plan) => events.find(event => event.plan === plan && ['plan.accepted', 'plan.rejected', 'plan.unavailable'].includes(event.kind));

export async function supervisePlan({events, append, plan, run, now = () => Date.now(), startupMs = 120_000, deadlineAt = null, maxAttempts = 3, signal}) {
  if (terminal(events, plan)) return {status: 'settled'};
  const startedAt = now();
  const previousAttempts = events.filter(event => event.kind === 'plan.attempt' && event.plan === plan);
  const priorDueAt = previousAttempts.reduce((earliest, event) => Number.isFinite(event.dueAt) && (earliest == null || event.dueAt < earliest) ? event.dueAt : earliest, null);
  const absoluteDeadline = deadlineAt ?? priorDueAt;
  const timeoutMs = Math.min(startupMs, absoluteDeadline == null ? Infinity : Math.max(0, absoluteDeadline - startedAt));
  const attempts = previousAttempts.length;
  const unavailable = reason => {
    if (!terminal(events, plan)) append({kind: 'plan.unavailable', plan, reason});
    return {status: 'unavailable', reason};
  };
  if (attempts >= maxAttempts) return unavailable('attempts_exhausted');
  const attempt = attempts + 1;
  append({kind: 'plan.attempt', plan, attempt, dueAt: startedAt + timeoutMs});
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort(signal.reason);
    return {status: 'cancelled'};
  }
  if (timeoutMs <= 0) {
    controller.abort();
    return unavailable('deadline_exhausted');
  }
  let timer, cancel;
  const cancelled = new Promise(resolve => {
    cancel = () => { controller.abort(signal.reason); resolve({type: 'cancelled'}); };
    signal?.addEventListener('abort', cancel, {once: true});
  });
  let result;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => run({signal: controller.signal}))
        .then(decision => ({type: 'decision', decision}), error => ({type: 'error', error})),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({type: 'timeout'}); }, timeoutMs); }),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  if (result.type === 'cancelled') return {status: 'cancelled'};
  if (result.type === 'decision') return terminal(events, plan) ? {status: 'settled'} : {status: 'decision', decision: result.decision};
  return unavailable(result.type === 'timeout' ? 'startup_timeout' : result.error?.message ?? 'plan_failed');
}
