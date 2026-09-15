import {resolveLocalModel} from './local-models.js';
import {validateOrchestration} from './profiles.js';

export function localModelEntries({catalogs, settings, profileName}) {
  const profile = validateOrchestration(settings).profiles[profileName];
  if (profile?.adapter !== 'local') throw new Error('Choose a configured local worker profile');
  const entries = [{provider: 'local', profileName, id: 'auto', label: 'Automatic selection',
    description: 'Follow role preferences and eligibility', current: !profile.model || profile.model === 'auto'}];
  for (const catalog of catalogs) {
    for (const model of catalog.models) {
      let problem = null;
      try {
        resolveLocalModel({local: settings.local, profile, catalogs, override: model.ref,
          requirements: {tools: true, context: profile.localOptions.maxOutputTokens + 1024}});
      } catch (error) {problem = error.message;}
      const readiness = catalog.stale ? 'stale' : model.ready === true ? 'loaded' : model.ready === false ? 'downloaded' : 'readiness unknown';
      const tools = model.tools === true ? 'yes' : model.tools === false ? 'no' : 'unknown';
      entries.push({provider: 'local', profileName, id: model.ref, label: `${catalog.endpoint} · ${model.label}`,
        description: `${readiness} · tools: ${tools} (${model.capabilitySource})${problem ? ` · unavailable: ${problem}` : ''}`,
        current: profile.endpoint === catalog.endpoint && profile.model === model.id, disabled: !!problem});
    }
  }
  return entries;
}

export function selectWorkerModel({settings, profileName, ref}) {
  const next = structuredClone(settings);
  const profile = next.profiles?.[profileName];
  if (profile?.adapter !== 'local' || profileName === next.orchestrator) throw new Error('Choose a configured local worker profile');
  if (ref === 'auto') profile.model = 'auto';
  else {
    const split = ref.indexOf('/');
    if (split < 1 || split === ref.length - 1) throw new Error('Use endpoint/model or auto');
    profile.endpoint = ref.slice(0, split);
    profile.model = ref.slice(split + 1);
  }
  validateOrchestration(next);
  return next;
}
