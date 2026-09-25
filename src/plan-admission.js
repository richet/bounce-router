import {isDeepStrictEqual} from 'node:util';

const PLAN_DECISIONS = new Set(['plan.accepted', 'plan.rejected', 'plan.unavailable']);
const OPTIONAL_CONSTRAINTS = ['review', 'steps', 'risk', 'size', 'checkpoint', 'requires'];

const planIdOf = row => row?.planId ?? row?.plan;
const before = (row, boundary) => boundary === undefined || row.seq === undefined || row.seq < boundary;
const sameList = (left, right) => isDeepStrictEqual([...(left ?? [])].sort(), [...(right ?? [])].sort());

function planContext(events, planId, boundary) {
  const decision = events.findLast(row => PLAN_DECISIONS.has(row.kind) && planIdOf(row) === planId && before(row, boundary));
  if (!decision || decision.kind !== 'plan.accepted') return {problem: 'plan is not accepted'};
  const plan = events.findLast(row => row.kind === 'plan.submitted' && planIdOf(row) === planId
    && before(row, decision.seq));
  if (!plan) return {problem: 'accepted plan has no submitted definition'};
  if (!Array.isArray(plan.chunks) || decision.chunks !== undefined && decision.chunks !== plan.chunks.length) {
    return {problem: 'accepted plan chunk count mismatch'};
  }
  return {decision, plan};
}

function chunkFor(plan, chunkId) {
  const matches = plan.chunks.filter(chunk => chunk?.id === chunkId);
  if (!matches.length) return {problem: 'unknown plan chunk'};
  if (matches.length !== 1) return {problem: 'plan chunk id is not unique'};
  return {chunk: matches[0]};
}

function initialConstraintProblem(spec, chunk) {
  for (const field of ['profile', 'orders']) {
    if (field === 'profile' && !Object.hasOwn(chunk, field)) continue;
    if (!isDeepStrictEqual(spec[field], chunk[field])) return `plan chunk ${field} mismatch`;
  }
  if (!sameList(spec.owns, chunk.owns)) return 'plan chunk owns mismatch';
  if (!isDeepStrictEqual(spec.deadline ?? null, chunk.deadline ?? null)) return 'plan chunk deadline mismatch';
  for (const field of OPTIONAL_CONSTRAINTS) {
    if (Object.hasOwn(chunk, field) && !isDeepStrictEqual(spec[field], chunk[field])) return `plan chunk ${field} mismatch`;
  }
  return null;
}

function predecessor(events, row) {
  const id = row.retryOf ?? row.replaces;
  return id ? events.find(candidate => candidate.kind === 'task.submitted' && candidate.task === id
    && before(candidate, row.seq)) : null;
}

function lineageRoot(events, row) {
  const seen = new Set();
  let current = row;
  while (current && !seen.has(current.task)) {
    seen.add(current.task);
    const prior = predecessor(events, current);
    if (!prior) return current;
    current = prior;
  }
  return null;
}

function immutableRetryProblem(spec, prior, chunk) {
  if (spec.jobId !== prior.jobId) return 'plan retry job mismatch';
  if (spec.planId !== prior.planId || spec.chunkId !== prior.chunkId) return 'plan retry identity mismatch';
  if (!sameList(spec.owns, prior.owns)) return 'plan retry owns mismatch';
  if (!isDeepStrictEqual(spec.deadline ?? null, prior.deadline ?? null)) return 'plan retry deadline mismatch';
  for (const field of OPTIONAL_CONSTRAINTS) {
    if (Object.hasOwn(chunk, field) && !isDeepStrictEqual(spec[field], prior[field])) return `plan retry ${field} mismatch`;
  }
  return null;
}

function canonicalDependency(events, decision, plan, spec, taskId, expectedChunkId) {
  const row = events.find(candidate => candidate.kind === 'task.submitted' && candidate.task === taskId
    && before(candidate, spec.seq));
  if (!row || row.seq <= decision.seq || row.planId !== planIdOf(plan) || row.chunkId !== expectedChunkId) return false;
  const root = lineageRoot(events, row);
  if (!root || root.planId !== planIdOf(plan) || root.chunkId !== expectedChunkId || root.seq <= decision.seq) return false;
  return row.jobId === root.jobId && planTaskAdmission(events, row).ok;
}

function dependencyProblem(events, decision, plan, spec, chunk) {
  const expected = [...(chunk.depends_on ?? [])];
  const actual = [...(spec.depends_on ?? [])];
  if (actual.length !== expected.length) return 'plan chunk dependencies mismatch';
  const resolved = actual.map(taskId => {
    const row = events.find(candidate => candidate.kind === 'task.submitted' && candidate.task === taskId
      && before(candidate, spec.seq));
    return expected.find(chunkId => canonicalDependency(events, decision, plan, spec, taskId, chunkId) && row?.chunkId === chunkId) ?? null;
  });
  if (resolved.some(value => value === null) || new Set(resolved).size !== expected.length
    || !sameList(resolved, expected)) return 'plan chunk dependencies mismatch';
  return null;
}

export function planTaskAdmission(events, spec) {
  const hasPlan = typeof spec.planId === 'string' && spec.planId.length > 0;
  const hasChunk = typeof spec.chunkId === 'string' && spec.chunkId.length > 0;
  if (spec.planId === undefined && spec.chunkId === undefined) return {ok: true, spec, planned: false};
  if (!hasPlan || !hasChunk) return {ok: false, reason: 'plan correlation requires planId and chunkId'};

  const context = planContext(events, spec.planId, spec.seq);
  if (context.problem) return {ok: false, reason: context.problem};
  const found = chunkFor(context.plan, spec.chunkId);
  if (found.problem) return {ok: false, reason: found.problem};

  const prior = predecessor(events, spec);
  if (spec.retryOf || spec.replaces) {
    if (!prior) return {ok: false, reason: 'plan retry predecessor missing'};
    const problem = (!planTaskAdmission(events, prior).ok ? 'plan retry predecessor is not admitted' : null)
      ?? immutableRetryProblem(spec, prior, found.chunk)
      ?? dependencyProblem(events, context.decision, context.plan, spec, found.chunk);
    return problem ? {ok: false, reason: problem} : {ok: true, spec, planned: true, plan: context.plan, decision: context.decision, chunk: found.chunk};
  }

  const problem = initialConstraintProblem(spec, found.chunk)
    ?? dependencyProblem(events, context.decision, context.plan, spec, found.chunk);
  if (problem) return {ok: false, reason: problem};
  const earlier = events.some(row => row.kind === 'task.submitted' && row.planId === spec.planId && row.chunkId === spec.chunkId
    && row.task !== spec.task && before(row, spec.seq));
  if (earlier) return {ok: false, reason: 'plan chunk already dispatched'};
  const expectedJob = `plan:${spec.planId}:${spec.chunkId}`;
  if (spec.jobId !== expectedJob) return {ok: false, reason: 'plan chunk job mismatch'};
  return {ok: true, spec, planned: true, plan: context.plan, decision: context.decision, chunk: found.chunk};
}

export function admittedPlanDispatches(events, planId) {
  return events.filter(row => row.kind === 'task.submitted' && row.planId === planId)
    .filter(row => planTaskAdmission(events, row).ok);
}
