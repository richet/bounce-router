import {normalizeLocalSettings, discoverLocalModels, resolveLocalModel} from './local-models.js';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const failure = (code, message) => Object.assign(new Error(message), {code});

// Supervisor-owned leases: queueing does not launch an inference or consume a start.
export function createLocalAdmission({local, discover = discoverLocalModels} = {}) {
  let settings = normalizeLocalSettings(local);
  const pools = new Map();
  const writers = new Set();
  const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  const conflicts = entry => [...writers].some(writer => writer.cwd === entry.cwd &&
    writer.paths.some(left => entry.paths.some(right => overlaps(left, right))));
  const uncertainConflict = entry => [...writers].some(writer => writer.uncertain && writer.cwd === entry.cwd &&
    writer.paths.some(left => entry.paths.some(right => overlaps(left, right))));

  function poolFor(endpoint) {
    if (!settings.endpoints[endpoint]) throw failure('LOCAL_MODEL_UNAVAILABLE', `Unknown endpoint ${endpoint}`);
    const key = settings.endpoints[endpoint].url;
    const limit = Math.min(...Object.values(settings.endpoints).filter(value => value.url === key).map(value => value.maxConcurrent));
    if (!pools.has(key)) pools.set(key, {active: 0, waiting: [], uncertain: false, limit});
    return pools.get(key);
  }

  function drain() {
    for (const pool of pools.values()) {
      for (const next of [...pool.waiting]) {
        const uncertain = pool.uncertain || uncertainConflict(next);
        if (!uncertain && (pool.active >= pool.limit || conflicts(next))) continue;
        pool.waiting = pool.waiting.filter(entry => entry !== next);
        next.cleanup();
        if (uncertain) next.reject(failure('LOCAL_CAPACITY_UNCERTAIN', 'Previous inference or overlapping writer termination is unverified'));
        else {
          pool.active++;
          if (next.paths.length) writers.add(next);
          next.resolve();
        }
      }
    }
  }

  async function acquire({profile, cwd, signal, onStatus = () => {}}) {
    const selectionSettings = settings;
    signal?.throwIfAborted();
    if (!settings.enabled) throw failure('LOCAL_DISABLED', 'Local models are disabled');
    const endpoint = profile.endpoint ?? 'lmstudio';
    const pool = poolFor(endpoint);
    const limit = pool.limit;
    let workspace = cwd;
    if (cwd) { try { workspace = realpathSync(cwd); } catch { workspace = path.resolve(cwd); } }
    const ownership = {cwd: workspace, paths: profile.policy === 'write' && profile.mode === 'yolo' ? profile.writePaths ?? [] : []};
    if (pool.uncertain || uncertainConflict(ownership)) throw failure('LOCAL_CAPACITY_UNCERTAIN', 'Previous inference or overlapping writer termination is unverified');
    if (pool.active >= limit || conflicts(ownership)) {
      onStatus(conflicts(ownership) ? 'Waiting for writer ownership · overlapping workspace paths' : `Waiting for LM Studio capacity · ${endpoint}`);
      await new Promise((resolve, reject) => {
        const entry = Object.assign(ownership, {resolve, reject, cleanup: () => signal?.removeEventListener('abort', aborted)});
        const aborted = () => {
          pool.waiting = pool.waiting.filter(item => item !== entry);
          entry.cleanup();
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        pool.waiting.push(entry);
        signal?.addEventListener('abort', aborted, {once: true});
        if (signal?.aborted) aborted();
      });
    } else {
      pool.active++;
      if (ownership.paths.length) writers.add(ownership);
    }

    let released = false;
    const release = ({verified}) => {
      if (released) return;
      released = true;
      pool.active--;
      if (!verified) { pool.uncertain = true; ownership.uncertain = true; }
      else writers.delete(ownership);
      drain();
    };
    try {
      signal?.throwIfAborted();
      onStatus(`Refreshing local model availability · ${endpoint}`);
      const catalogs = await discover(selectionSettings, {signal, maxAge: 0});
      signal?.throwIfAborted();
      const localResolved = resolveLocalModel({local: selectionSettings, profile, catalogs,
        requirements: {tools: true, context: (profile.localOptions?.maxOutputTokens ?? 2048) + 1024}});
      onStatus(`Selected ${localResolved.ref} · ${localResolved.reason}`);
      return {profile: {...profile, model: localResolved.model, localResolved,
        apiKeyEnv: selectionSettings.endpoints[localResolved.endpoint].apiKeyEnv}, release};
    } catch (error) {
      release({verified: true});
      throw error;
    }
  }

  function configure(local) {
    const next = normalizeLocalSettings(local);
    for (const [name, endpoint] of Object.entries(settings.endpoints)) {
      if (!isDeepStrictEqual(endpoint, next.endpoints[name])) {
        throw failure('LOCAL_ENDPOINT_CHANGED', `Endpoint ${name} changed; start a new session to apply endpoint changes safely`);
      }
    }
    settings = next;
    for (const [url, pool] of pools) {
      pool.limit = Math.min(...Object.values(settings.endpoints).filter(endpoint => endpoint.url === url).map(endpoint => endpoint.maxConcurrent));
    }
  }

  return {acquire, configure, quarantine({endpoint}) {
    const pool = poolFor(endpoint);
    pool.uncertain = true;
    drain();
  }};
}
