import {validateOrchestration} from './profiles.js';

export function previewLocalProfile({settings, name, options = {}}) {
  if (!/^[A-Za-z0-9_-]+$/.test(name ?? '')) throw new Error('Profile name must use letters, numbers, underscores or hyphens');
  if (settings.operation !== 'orchestrator') throw new Error('Enable orchestrator mode before adding local workers');
  if (Object.hasOwn(settings.profiles ?? {}, name)) throw new Error(`Profile ${name} already exists; edit its config or use /model worker ${name}`);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Profile options must be a JSON object');
  const allowed = new Set(['model', 'endpoint', 'role', 'policy', 'mode', 'readPaths', 'writePaths', 'commands', 'container', 'localOptions', 'localOnly', 'fallback', 'prefer', 'exclude']);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field)) throw new Error(`Unsupported local profile option: ${field}`);
  }
  const next = structuredClone(settings);
  next.profiles[name] = {adapter: 'local', backend: 'lmstudio', model: 'auto', ...options};
  const profile = validateOrchestration(next).profiles[name];
  return {settings: next, profile};
}
