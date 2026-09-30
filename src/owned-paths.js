// The paths a task's worker says its work belongs in. owns is a hint, not a fence (2026-09-29,
// decided after a real session: 36 tasks named owns, bounce widened them 38 times, blocked once for
// them, and of 5 pairs of tasks that overlapped in time none touched the same file) — it tells the
// worker where to look and helps the orchestrator plan chunks that can run side by side. What
// actually protects the checkout is src/workspace-artifacts.js's integrateArtifact, which refuses a
// change whose file in the checkout is no longer what the worker's copy started from.

export function validOwns(owns) {
  return Array.isArray(owns) && owns.every(own => typeof own === 'string' && own && !own.startsWith('/') && !own.includes('\0') && !own.split('/').some(part => part === '..'));
}
