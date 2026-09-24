// What the machine can actually run, so routing and dispatch stop pretending memory is infinite.
// Found live (2026-09-22): bounce sent every review to the cloud because the local model it wanted had
// been unloaded, while the same machine holds models (73 GB, 62 GB) that cannot be loaded beside what is
// already resident. Every number here is read from the machine or from LM Studio — nothing is guessed.
//
// KV cache is deliberately NOT modelled: LM Studio does not report it, and a formula bounce has never
// measured would be false precision. Instead a flat reserve (`local.reserveGb`, default 8) must stay free
// beside the weights, and every refusal prints the numbers it used.
import {execFileSync} from 'node:child_process';

export const DEFAULT_RESERVE_BYTES = 8 * 1024 ** 3;
const GB = 1024 ** 3;
export const gb = bytes => `${(Number(bytes ?? 0) / GB).toFixed(1)} GB`;

const sh = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 5000});

// `vm_stat`: the page size is in its header line, never assumed. Free memory for our purpose is what the
// system can hand out without swapping: free + inactive + purgeable (macOS reclaims those first).
export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]) || 16384;
  const pages = name => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] ?? NaN);
  const free = pages('Pages free'), inactive = pages('Pages inactive'), purgeable = pages('Pages purgeable'), wired = pages('Pages wired down');
  const swapouts = Number(/Swapouts:\s+(\d+)/.exec(text)?.[1] ?? NaN);
  if ([free, inactive, purgeable, wired].some(Number.isNaN)) return null;
  return {pageSize, available: (free + inactive + purgeable) * pageSize, wired: wired * pageSize, swapouts: Number.isNaN(swapouts) ? null : swapouts};
}

export const parseSwapUsage = text => {
  const used = /used\s*=\s*([\d.]+)M/.exec(text);
  return used ? {used: Number(used[1]) * 1024 ** 2} : null;
};

// One read of the machine. Never throws: anything unreadable is {known: false, reason}, and every caller
// treats that as "no opinion" — bounce then behaves exactly as it did before this module existed.
export function readMachine({run = sh} = {}) {
  try {
    const vm = parseVmStat(run('vm_stat', []));
    if (!vm) return {known: false, reason: 'vm_stat unreadable'};
    const ramTotal = Number(run('sysctl', ['-n', 'hw.memsize']).trim());
    if (!Number.isFinite(ramTotal) || ramTotal <= 0) return {known: false, reason: 'hw.memsize unreadable'};
    const swap = parseSwapUsage(run('sysctl', ['-n', 'vm.swapusage'])) ?? {used: null};
    let wiredLimit = null;
    try { const raw = Number(run('sysctl', ['-n', 'iogpu.wired_limit_mb']).trim()); if (Number.isFinite(raw) && raw > 0) wiredLimit = raw * 1024 ** 2; } catch {}
    return {known: true, ramTotal, available: vm.available, wired: vm.wired, swapUsed: swap.used, swapouts: vm.swapouts, wiredLimit: wiredLimit ?? ramTotal, at: Date.now()};
  } catch (error) { return {known: false, reason: error?.message ?? 'unreadable'}; }
}

// Swapping is a state, not a level: this machine sits at 8.5 GB of swap with no pressure at all. Only a
// RISING swapout counter between two reads means the machine is paging right now.
export const swapping = (before, after) => Boolean(before?.known && after?.known
  && Number.isFinite(before.swapouts) && Number.isFinite(after.swapouts) && after.swapouts > before.swapouts);

// What LM Studio holds right now, from the catalogs src/local-models.js already fetches.
// `busy` names the models with a running turn (the scheduler knows); the rest are idle and reclaimable.
export function residentModels(catalogs = [], busy = []) {
  const rows = [];
  for (const catalog of catalogs ?? []) for (const model of catalog.models ?? []) {
    if (model.ready !== true) continue;
    rows.push({name: `${catalog.endpoint}/${model.id}`, endpoint: catalog.endpoint, model: model.id,
      sizeBytes: Number(model.size) || 0, idle: !busy.includes(`${catalog.endpoint}/${model.id}`) && !busy.includes(model.id), ttl: model.ttl ?? null});
  }
  return rows;
}

export const sizeOf = (catalogs = [], endpoint, id) => {
  for (const catalog of catalogs ?? []) { if (catalog.endpoint !== endpoint) continue; for (const model of catalog.models ?? []) if (model.id === id) return Number(model.size) || 0; }
  return 0;
};

// Can this model run now? Pure. Greedy by decision (2026-09-22): the budget is what is actually free, with
// a flat reserve kept beside the weights, and the resident set must stay inside the GPU wiring cap.
// A model that does not fit may still fit once idle resident models are unloaded — `unload` names them,
// oldest-idle first, and only as many as it takes.
export function fitLocal({sizeBytes = 0, loaded = false, machine, resident = [], reserve = DEFAULT_RESERVE_BYTES} = {}) {
  if (!machine?.known) return {ok: true, known: false};
  if (loaded) return {ok: true, known: true, loaded: true, needs: 0, available: machine.available};
  const need = sizeBytes + reserve;
  const residentBytes = resident.reduce((sum, row) => sum + row.sizeBytes, 0);
  const underCap = bytes => machine.wiredLimit == null || bytes + sizeBytes <= machine.wiredLimit;
  if (need <= machine.available && underCap(residentBytes)) return {ok: true, known: true, loaded: false, needs: need, available: machine.available, unload: []};
  const idle = resident.filter(row => row.idle).sort((a, b) => (a.ttl ?? Infinity) - (b.ttl ?? Infinity));
  const unload = [];
  let available = machine.available, kept = residentBytes;
  for (const row of idle) {
    unload.push(row.name); available += row.sizeBytes; kept -= row.sizeBytes;
    if (need <= available && underCap(kept)) return {ok: true, known: true, loaded: false, needs: need, available: machine.available, unload};
  }
  return {ok: false, known: true, loaded: false, needs: need, available: machine.available, unload: [],
    reason: `needs ${gb(sizeBytes)} plus a reserve of ${gb(reserve)}, and only ${gb(machine.available)} is free${unload.length ? ` even after unloading ${unload.join(', ')}` : ''}`};
}

// `bounce resources`: the numbers the gate uses, in one screen.
export function resourceReport({machine, fleet = [], busy = [], swapping = false, reserve = DEFAULT_RESERVE_BYTES} = {}) {
  if (!machine?.known) return `Machine: unknown (${machine?.reason ?? 'unreadable'}) · bounce will not hold a local task back`;
  const resident = residentModels(fleet, busy);
  const minutes = ttl => ttl == null ? null : `${Math.round(ttl / 60)} min left`;
  const lines = [`Machine: ${gb(machine.ramTotal)} total · ${gb(machine.available)} free · ${gb(machine.swapUsed ?? 0)} swapped (${swapping ? 'SWAPPING: local work goes to the cloud' : 'not swapping'}) · GPU wiring cap ${gb(machine.wiredLimit)}`];
  lines.push(resident.length
    ? `Resident: ${resident.map(row => `${row.name} ${gb(row.sizeBytes)} (${row.idle ? 'idle' : 'busy'}${minutes(row.ttl) ? `, ${minutes(row.ttl)}` : ''})`).join(' · ')}`
    : 'Resident: nothing loaded');
  lines.push(`Local models, with a reserve of ${gb(reserve)} beside the weights:`);
  for (const catalog of fleet ?? []) for (const model of catalog.models ?? []) {
    const name = `${catalog.endpoint}/${model.id}`;
    const loaded = model.ready === true;
    const fit = fitLocal({sizeBytes: Number(model.size) || 0, loaded, machine, resident, reserve});
    lines.push(`  ${name}  ${gb(model.size)}  ${loaded ? 'loaded' : fit.ok ? (fit.unload?.length ? `fits once ${fit.unload.join(', ')} is unloaded` : 'fits') : `does not fit: ${fit.reason}`}`);
  }
  return lines.join('\n');
}

export function createResources({run = sh, ttlMs = 3000, clock = () => Date.now()} = {}) {
  let last = null, before = null;
  return {
    read() {
      if (last && clock() - last.at < ttlMs) return last;
      before = last ?? before;
      last = {...readMachine({run}), at: clock()};
      return last;
    },
    // True only when the machine paged between the last two distinct reads.
    swapping() { return swapping(before, last); },
    reset() { last = null; before = null; },
  };
}
