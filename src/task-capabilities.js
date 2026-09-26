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
    // A probe worker never gets Docker: a container can bind-mount the checkout and write it, which no
    // sandbox around the worker can stop (decided 2026-09-25: Docker only for tasks that may write).
    case 'probe': return ['read', 'exec'];
    // A full write/yolo worker already runs unsandboxed (or, isolated, with only the source
    // checkout fenced against writes — see writeFenceSandbox): the Docker socket is already reachable.
    default: return ['read', 'exec', 'write', 'docker'];
  }
}

export function missingCapabilities(profile, requires) {
  const available = new Set(taskCapabilities(profile));
  return [...new Set(Array.isArray(requires) ? requires : [])].filter((capability) => !available.has(capability));
}
