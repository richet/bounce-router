import { effectivePolicy } from './profiles.js';

const CAPABILITIES = ['read', 'exec', 'write'];

export function validateRequirements(requires) {
  if (requires === undefined) return null;
  if (!Array.isArray(requires)) return 'task.requires must be an array';
  if (requires.some((capability) => !CAPABILITIES.includes(capability))) {
    return 'task.requires must contain only read, exec, write';
  }
  return null;
}

export function taskCapabilities(profile) {
  if (profile.adapter === 'local' || profile.adapter === 'typesafe') return ['read'];

  switch (effectivePolicy(profile)) {
    case 'plan':
    case 'read-only': return ['read'];
    case 'probe': return ['read', 'exec'];
    default: return ['read', 'exec', 'write'];
  }
}

export function missingCapabilities(profile, requires) {
  const available = new Set(taskCapabilities(profile));
  return [...new Set(Array.isArray(requires) ? requires : [])].filter((capability) => !available.has(capability));
}
