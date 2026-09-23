// Bounce guards loops inside a turn — a repeated tool call, empty steps, silence. Found live (ACE session
// c70dbb61, 2026-09-22): ten reviewer tasks in two hours, the same scope on the same local model, each one
// killed at its 60-minute ceiling and immediately replaced. Nothing counted that, and the orchestrator could
// not: it sees one outcome per handoff, never the pattern. This is the guard one level up — the same job,
// failing the same way, is stopped rather than run again.
export const REPEAT_LIMIT = 2;

// The ways a task ends that mean "this attempt got nowhere", as opposed to a verdict bounce can act on.
const DEAD_ENDS = new Set(['ceiling', 'no_progress', 'stuck', 'deadline', 'watchdog']);
const normalize = orders => String(orders ?? '').replace(/\s+/g, ' ').trim();

export const sameJob = (a, b) => a.profile === b.profile && normalize(a.orders) === normalize(b.orders);

// Every earlier attempt at this job that died a dead end, oldest first, with how it died.
export function failedAttempts(events, job) {
  const attempts = [];
  for (const event of events) {
    if (event.kind !== 'task.submitted' || !sameJob(event, job)) continue;
    const ended = events.find(e => e.task === event.task
      && (e.kind === 'task.deadline' || (e.kind === 'task.cancelled' && DEAD_ENDS.has(e.reason))));
    if (ended) attempts.push({task: event.task, reason: ended.reason ?? 'deadline', at: ended.time ?? null});
  }
  return attempts;
}

// What bounce says when it refuses to run the same thing again. It names the count, how each attempt died and
// the AI they died on, because that is what the caller needs in order to change something.
export const repeatRefusal = (job, attempts, model) =>
  `${job.profile} has already failed this same job ${attempts.length === 1 ? 'once' : attempts.length === 2 ? 'twice' : `${attempts.length} times`}`
  + `${model ? ` on ${model}` : ''} (${attempts.map(a => a.reason).join(', ')}). Change something before asking again:`
  + ' a narrower scope, a different AI, or hand it back. Resubmitting it unchanged is a loop.';
