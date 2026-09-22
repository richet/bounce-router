import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateOrchestration, LOCAL_ADAPTERS} from './profiles.js';

// User-only control, independent of provider turns: re-derive named agents from the agent files as
// they are NOW and swap them into the running session. The daemon reads the files and the saved
// configuration itself; a caller cannot smuggle a different grant into the activation event.
export function createLocalActivation({session, scheduler, profiles, settings, readSettings, refresh, roles = null, readRoles = () => roles}) {
  return session.subscribe(row => {
    if (row.kind !== 'control.local_activate' || row.from !== 'user') return;
    try {
      if (settings.operation !== 'orchestrator') throw new Error('Start an orchestrator session to activate workers');
      if (!Array.isArray(row.names) || !row.names.length || row.names.length > 128 ||
          row.names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))) {
        throw new Error('Invalid local worker names');
      }
      const saved = readSettings();
      const validated = validateOrchestration(saved, undefined, {roles: readRoles()}).profiles;
      const agents = {};
      for (const name of new Set(row.names)) {
        const profile = validated[name];
        // An agent name activates its whole derived chain as the agent files define it NOW — the
        // session's copy is replaced, whatever adapters the chain spans, so setup's edits are live.
        if (profile?.agent?.name === name) {
          const chain = {}; let current = name;
          while (current && validated[current]?.agent?.name === name) { chain[current] = validated[current]; current = validated[current].fallback[0]; }
          agents[name] = chain;
          continue;
        }
        throw new Error(`${name} is not an agent; see \`bounce agents\``);
      }
      for (const [name, chain] of Object.entries(agents)) scheduler.replaceAgent(name, chain, saved.local);
      let warning = '';
      try {
        refresh();
      } catch (error) {
        warning = ` Standing orders could not be refreshed: ${error.message}. Use the activated roster below.`;
      }
      const names = Object.keys(agents);
      // A local worker is named by its provider and model; opencode is the runtime it runs through.
      const ref = profile => LOCAL_ADAPTERS.has(profile.adapter) ? `${profile.endpoint ?? 'lmstudio'}/${profile.model || 'auto'} (via opencode)` : [profile.adapter, profile.model].filter(Boolean).join('/');
      const team = Object.entries(agents).map(([name, chain]) => `${name} → ${Object.values(chain).map(ref).join(', ')} · ${Object.values(chain)[0].policy}`).join('; ');
      session.append({kind: 'local.profiles.activated', requestId: row.requestId, names,
        text: `Agents updated in this session: ${team}. Submit to these names; the roster in ORDERS.md was rewritten.${warning}`});
    } catch (error) {
      session.append({kind: 'local.profiles.rejected', requestId: row.requestId,
        text: `Configuration saved, but live activation failed: ${error.message}`});
    }
  });
}

export function activateLocalProfiles(session, names, {timeoutMs = 5000} = {}) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Configuration saved; daemon did not acknowledge activation. This daemon may predate live activation. Start a new session; do not assume workers are active.'));
    }, timeoutMs);
    const unsubscribe = session.subscribe(row => {
      if (row.requestId !== requestId || !['local.profiles.activated', 'local.profiles.rejected'].includes(row.kind)) return;
      clearTimeout(timer);
      unsubscribe();
      if (row.kind === 'local.profiles.activated') resolve(row);
      else reject(new Error(row.text));
    });
    try {
      session.append({kind: 'control.local_activate', from: 'user', requestId, names});
    } catch (error) {
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    }
  });
}
