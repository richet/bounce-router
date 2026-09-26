import { effectivePolicy } from './profiles.js';

const CAPABILITIES = ['read', 'exec', 'write', 'docker'];

export function validateRequirements(requires) {
  if (requires === undefined) return null;
  if (!Array.isArray(requires)) return 'task.requires must be an array';
  if (requires.some((capability) => !CAPABILITIES.includes(capability))) {
    return 'task.requires must contain only read, exec, write, docker';
  }
  return null;
}

export function taskCapabilities(profile) {
  if (profile.adapter === 'local' || profile.adapter === 'typesafe') return ['read'];

  switch (effectivePolicy(profile)) {
    case 'plan':
    case 'read-only': return ['read'];
    // A probe worker's sandbox is otherwise network-fenced to localhost. Only the OpenCode
    // adapter's probe fence is a sandbox-exec profile bounce writes itself, so only it can add an
    // explicit allow rule for the Docker socket (src/adapters/opencode-live.js probeSandbox).
    // Codex's read-only/workspace-write sandbox policies have no such allow-list mechanism (its
    // own report bus socket cannot reach through them either — see codex-live.js permissionsFor),
    // so docker is refused there.
    case 'probe': return profile.adapter === 'opencode' ? ['read', 'exec', 'docker'] : ['read', 'exec'];
    // A full write/yolo worker already runs unsandboxed (or, isolated, with only the source
    // checkout fenced against writes — see writeFenceSandbox): the Docker socket is already
    // reachable, so docker is available with no extra wiring.
    default: return ['read', 'exec', 'write', 'docker'];
  }
}

export function missingCapabilities(profile, requires) {
  const available = new Set(taskCapabilities(profile));
  return [...new Set(Array.isArray(requires) ? requires : [])].filter((capability) => !available.has(capability));
}
