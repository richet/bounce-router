import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateOrchestration} from './profiles.js';

// User-only control, independent of provider turns. The daemon reads the saved configuration;
// a caller cannot smuggle a different permission grant into the activation event.
export function createLocalActivation({session, scheduler, profiles, settings, readSettings, refresh}) {
  return session.subscribe(row => {
    if (row.kind !== 'control.local_activate' || row.from !== 'user') return;
    try {
      if (settings.operation !== 'orchestrator') throw new Error('Start an orchestrator session to activate workers');
      if (!Array.isArray(row.names) || !row.names.length || row.names.length > 128 ||
          row.names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))) {
        throw new Error('Invalid local worker names');
      }
      const saved = readSettings();
      const validated = validateOrchestration(saved).profiles;
      const additions = {};
      const selected = {};
      for (const name of new Set(row.names)) {
        const profile = validated[name];
        if (!profile || profile.adapter !== 'local' || profile.role === 'orchestrator') throw new Error(`${name} is not a saved local worker`);
        if (Object.hasOwn(profiles, name)) {
          if (!isDeepStrictEqual(profiles[name], profile)) throw new Error(`Profile ${name} is already active with different settings`);
        } else {
          additions[name] = profile;
        }
        selected[name] = profile;
      }
      for (const profile of Object.values(additions)) {
        if (profile.fallback.some(name => !Object.hasOwn(profiles, name) && !Object.hasOwn(additions, name))) {
          throw new Error('Activate all referenced fallback profiles together');
        }
      }
      scheduler.registerLocalProfiles(additions, saved.local);
      let warning = '';
      try {
        refresh();
      } catch (error) {
        warning = ` Standing orders could not be refreshed: ${error.message}. Use the activated roster below.`;
      }
      const names = Object.keys(selected);
      const roster = Object.entries(profiles).filter(([, profile]) => profile.adapter === 'local')
        .map(([name, profile]) => `${name} → ${profile.adapter}/${profile.model || 'auto'} (${profile.policy})`).join('; ');
      session.append({kind: 'local.profiles.activated', requestId: row.requestId, names,
        text: `Local workers active in this session: ${roster}. Use these exact profiles for local requests; never substitute a cloud worker for a requested local worker. Read the updated orchestrator ORDERS.md for scopes and commands.${warning}`});
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
