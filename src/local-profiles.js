import {normalizeLocalSettings} from './local-models.js';

const protectedNames = new Set(['.git', '.agents', '.codex', '.claude', '.bounce', '.ssh']);

function paths(value, field, fallback) {
  const entries = value ?? fallback;
  if (!Array.isArray(entries) || entries.length > 128) {
    throw new Error(`${field} must be a bounded path array`);
  }
  for (const entry of entries) {
    if (field === 'readPaths' && entry === '.') continue;
    if (typeof entry !== 'string' || !entry || entry.length > 1024 ||
        /[\\\u0000-\u001f:]/.test(entry) || entry.startsWith('/') ||
        entry.split('/').some(part => !part || part === '.' || part === '..' || protectedNames.has(part) || part.startsWith('.env'))) {
      throw new Error(`${field} must stay within unprotected workspace paths`);
    }
  }
  return [...new Set(entries)];
}

function boundedOptions(input, definitions, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${field} must be an object`);
  }
  const result = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(definitions, key)) throw new Error(`${field}.${key} is unsupported`);
  }
  for (const [key, [fallback, minimum, maximum]] of Object.entries(definitions)) {
    const value = input[key] ?? fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${field}.${key} must be between ${minimum} and ${maximum}`);
    }
    result[key] = value;
  }
  return result;
}

export function normalizeLocalProfile({raw, policy, role, settings}) {
  if (role === 'orchestrator') throw new Error('local orchestrator is not supported yet');
  if (raw.backend !== undefined && raw.backend !== 'lmstudio') throw new Error('local backend must be lmstudio');
  const local = normalizeLocalSettings(settings.local);
  const endpoint = raw.endpoint ?? 'lmstudio';
  if (!Object.hasOwn(local.endpoints, endpoint)) throw new Error('endpoint must name a configured local endpoint');
  const readPaths = paths(raw.readPaths, 'readPaths', ['.']);
  const writePaths = paths(raw.writePaths, 'writePaths', []);
  const commands = raw.commands ?? [];
  if (!Array.isArray(commands) || commands.length > 32 || commands.some(command => typeof command !== 'string' || !command.trim() || command.length > 4096 || command.includes('\0'))) {
    throw new Error('commands must be a bounded array of explicitly permitted commands');
  }
  if (policy === 'write' && !writePaths.length) throw new Error('local write requires writePaths');
  if (policy === 'read-only' && (commands.length || writePaths.length)) throw new Error('read-only local profile cannot grant writes or commands');
  const localOnly = raw.localOnly ?? true;
  if (typeof localOnly !== 'boolean') throw new Error('localOnly must be boolean');
  const options = boundedOptions(raw.localOptions ?? {}, {
    maxSteps: [32, 1, 128], maxOutputTokens: [2048, 1, 32768],
    timeoutMs: [120000, 100, 1800000], maxContextBytes: [200000, 1024, 2000000],
  }, 'localOptions');
  const container = raw.container ?? {};
  const {image = 'node:22-alpine', ...limits} = container;
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]{0,255}$/.test(image)) {
    throw new Error('container.image must be a Docker image reference');
  }
  const containerLimits = boundedOptions(limits, {
    memoryMiB: [512, 64, 16384], cpus: [1, 1, 16], pids: [64, 16, 1024],
    workspaceMiB: [128, 16, 256],
  }, 'container');
  const selections = {};
  for (const field of ['prefer', 'exclude']) {
    const refs = raw[field] ?? [];
    if (!Array.isArray(refs) || refs.length > 128 || refs.some(ref => typeof ref !== 'string' || !ref || ref.length > 512)) {
      throw new Error(`${field} must be a bounded model reference array`);
    }
    selections[field] = [...refs];
  }
  return {backend: 'lmstudio', endpoint, readPaths, writePaths, commands: [...commands],
    container: {image, ...containerLimits}, localOptions: options, localOnly, ...selections};
}
