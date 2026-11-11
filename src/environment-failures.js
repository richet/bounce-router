// A check that failed for a reason outside the code: the machine, not the work. Found live: checks failed on a copy
// whose git objects were unreachable, a full disk, an overloaded host and Docker export timeouts, and each time the
// builder was restarted although it had nothing to fix. One table, read in order; add a signature here.
export const ENVIRONMENT_SIGNATURES = [
  {cause: 'git_objects', label: 'git objects missing or unreachable in the copy',
    pattern: /unable to read [0-9a-f]{7,40}|(?:bad|missing|unreachable) object|object [0-9a-f]{7,40} is missing|did not receive expected object|alternates? .*(?:not found|missing|unreachable)|could not read from alternate/i},
  {cause: 'disk_full', label: 'the disk is full', pattern: /ENOSPC|no space left on device|disk (?:is )?full|disk quota exceeded/i},
  {cause: 'out_of_memory', label: 'the machine ran out of memory', pattern: /out of memory|oom[- ]?kill(?:ed|er)?|killed process \d+|JavaScript heap out of memory|cannot allocate memory/i},
  {cause: 'docker_daemon', label: 'the Docker daemon is not reachable', pattern: /cannot connect to the docker daemon|is the docker daemon running|error during connect:.*docker/i},
  {cause: 'docker_timeout', label: 'Docker timed out', pattern: /context deadline exceeded|(?:docker|export(?:ing)?|image|layers?|pull(?:ing)?)\b[^\n]{0,80}\b(?:timed out|timeout)|TLS handshake timeout/i},
];

// The signature a failed check's output matches, or null. A passed check, or one that could not run, has none.
export function environmentCause(check) {
  if (!check || check.passed || check.unrunnable || check.timedOut) return null;
  const output = String(check.output ?? '');
  const found = ENVIRONMENT_SIGNATURES.find(signature => signature.pattern.test(output));
  return found ? {cause: found.cause, label: found.label} : null;
}
