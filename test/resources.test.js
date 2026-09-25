// What the machine can run (docs/plans/resource-aware.md). Every fixture here is real output from the
// machine this was built on (2026-09-22): 128 GiB, 8.5 GB of swap already used with no pressure, a 92 GB
// GPU wiring cap, a 20 GB model resident and a 73 GB one on disk. Nothing in these tests reads the
// machine: the reads are injected, so the numbers cannot drift under the assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVmStat, parseSwapUsage, readMachine, underPressure, residentModels, sizeOf, fitLocal, createResources, gb, DEFAULT_RESERVE_BYTES} from '../src/resources.js';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                1544971.
Pages active:                              3523032.
Pages inactive:                            2732464.
Pages speculative:                           64893.
Pages throttled:                                 0.
Pages wired down:                           388904.
Pages purgeable:                             42450.
"Translation faults":                   8536417176.
Swapins:                                  20364200.
Swapouts:                                 23085999.
`;
const SWAP = 'total = 10240.00M  used = 8505.88M  free = 1734.12M  (encrypted)\n';
const GB = 1024 ** 3;
const run = (over = {}) => (cmd, args) => {
  if (cmd === 'vm_stat') return over.vm ?? VM_STAT;
  if (cmd === 'sysctl' && args[1] === 'hw.memsize') return String(128 * GB);
  if (cmd === 'sysctl' && args[1] === 'vm.swapusage') return over.swap ?? SWAP;
  if (cmd === 'sysctl' && args[1] === 'iogpu.wired_limit_mb') { if (over.noCap) throw new Error('unknown oid'); return '92000'; }
  if (cmd === 'sysctl' && args[1] === 'kern.memorystatus_vm_pressure_level') { if (over.noPressure) throw new Error('unknown oid'); return `${over.pressure ?? 1}\n`; }
  throw new Error(`unexpected ${cmd} ${args?.join(' ')}`);
};

test('R1 the machine is read, never guessed: page size from vm_stat, available = free + inactive + purgeable', () => {
  assert.deepEqual(parseVmStat(VM_STAT), {pageSize: 16384, available: (1544971 + 2732464 + 42450) * 16384, wired: 388904 * 16384});
  assert.equal(parseVmStat('nonsense'), null);
  assert.deepEqual(parseSwapUsage(SWAP), {used: 8505.88 * 1024 ** 2});
  const m = readMachine({run: run()});
  assert.deepEqual([m.known, m.ramTotal, m.wiredLimit, m.pressure], [true, 128 * GB, 92000 * 1024 ** 2, 1]);
  assert.equal(gb(m.available), '65.9 GB');
  // no GPU cap on this machine: the total is the cap, and nothing throws
  assert.equal(readMachine({run: run({noCap: true})}).wiredLimit, 128 * GB);
  // a machine that cannot be read has no opinion, and every caller then behaves as before
  assert.deepEqual(readMachine({run: () => { throw new Error('nope'); }}), {known: false, reason: 'nope'});
  assert.equal(fitLocal({sizeBytes: 999 * GB, machine: {known: false}}).ok, true, 'unknown never blocks');
});

test('R2 memory pressure is macOS\'s own verdict: warning or critical, never swap in use or a swapout counter', () => {
  assert.equal(underPressure(readMachine({run: run()})), false, '8.3 GB already swapped at normal pressure is not pressure');
  assert.equal(underPressure(readMachine({run: run({pressure: 2})})), true, 'warning');
  assert.equal(underPressure(readMachine({run: run({pressure: 4})})), true, 'critical');
  // a level bounce cannot read has no opinion
  assert.deepEqual([readMachine({run: run({noPressure: true})}).pressure, underPressure(readMachine({run: run({noPressure: true})}))], [null, false]);
  assert.equal(underPressure({known: false}), false);
});

test('R3 what is resident, what it costs, and what is idle', () => {
  const catalogs = [{provider: 'local', endpoint: 'lmstudio', models: [
    {id: 'qwen3.6-35b-a3b-mlx', ready: true, size: 20 * GB, ttl: 2368},
    {id: 'qwen3.8-27b-mlx@4bit', ready: true, size: 16 * GB, ttl: 600},
    {id: 'minimax-m2-reap-139b-a10b', ready: false, size: 73 * GB, ttl: null}]}];
  assert.deepEqual(residentModels(catalogs, ['lmstudio/qwen3.6-35b-a3b-mlx']), [
    {name: 'lmstudio/qwen3.6-35b-a3b-mlx', endpoint: 'lmstudio', model: 'qwen3.6-35b-a3b-mlx', sizeBytes: 20 * GB, idle: false, ttl: 2368},
    {name: 'lmstudio/qwen3.8-27b-mlx@4bit', endpoint: 'lmstudio', model: 'qwen3.8-27b-mlx@4bit', sizeBytes: 16 * GB, idle: true, ttl: 600}]);
  assert.equal(sizeOf(catalogs, 'lmstudio', 'minimax-m2-reap-139b-a10b'), 73 * GB);
  assert.equal(sizeOf(catalogs, 'lmstudio', 'nope'), 0);
});

test('R4 the fit rule: greedy on what is free, a reserve beside the weights, idle models are reclaimable', () => {
  const machine = readMachine({run: run()}); // 65.9 GB available, 92 GB cap
  const resident = [{name: 'lmstudio/35b', sizeBytes: 20 * GB, idle: false, ttl: 2368}, {name: 'lmstudio/27b', sizeBytes: 16 * GB, idle: true, ttl: 600}];
  // a loaded model costs nothing to choose
  assert.deepEqual(fitLocal({sizeBytes: 16 * GB, loaded: true, machine, resident}), {ok: true, known: true, loaded: true, needs: 0, available: machine.available});
  // 20 GB + the 8 GB reserve fits in 65.9 GB, and 36 + 20 GB stays under the 92 GB cap
  assert.deepEqual(fitLocal({sizeBytes: 20 * GB, machine, resident}).unload, []);
  // 62 GB + reserve does not fit in 65.9 GB, but does once the idle 27B is unloaded
  const tight = fitLocal({sizeBytes: 62 * GB, machine, resident});
  assert.deepEqual([tight.ok, tight.unload], [true, ['lmstudio/27b']]);
  // 73 GB fits nowhere here: the busy 35B may not be touched, and the cap would break anyway
  const huge = fitLocal({sizeBytes: 73 * GB, machine, resident});
  assert.deepEqual([huge.ok, huge.unload], [false, []]);
  assert.equal(huge.reason, 'needs 73.0 GB plus a reserve of 8.0 GB, and only 65.9 GB is free even after unloading lmstudio/27b');
  assert.equal(DEFAULT_RESERVE_BYTES, 8 * GB);
});

test('R5 the reader caches briefly; pressure is judged on the latest read', () => {
  let now = 0, pressure = 1;
  const resources = createResources({clock: () => now, ttlMs: 3000, run: (cmd, args) => run({pressure})(cmd, args)});
  const first = resources.read();
  pressure = 4;
  assert.equal(resources.read(), first, 'inside the ttl the same read is reused');
  assert.equal(resources.underPressure(), false);
  now = 4000;
  resources.read();
  assert.equal(resources.underPressure(), true, 'critical on the fresh read');
});

// `bounce resources`: the same numbers the gate uses, in one screen, so "why is it waiting" has an
// answer before anyone reads the journal.
test('R6 the report: what is free, what is resident, and what each model would cost to load', async () => {
  const {resourceReport} = await import('../src/resources.js');
  const fleet = [{provider: 'local', endpoint: 'lmstudio', models: [
    {id: 'qwen3.6-35b-a3b-mlx', ready: true, size: 20 * GB, ttl: 2368},
    {id: 'qwen3.8-27b-mlx@4bit', ready: false, size: 16 * GB, ttl: null},
    {id: 'minimax-m2-reap-139b-a10b', ready: false, size: 73 * GB, ttl: null}]}];
  const text = resourceReport({machine: readMachine({run: run()}), fleet, busy: ['lmstudio/qwen3.6-35b-a3b-mlx']});
  assert.equal(text, [
    'Machine: 128.0 GB total · 65.9 GB free · 8.3 GB swapped · memory pressure normal · GPU wiring cap 89.8 GB',
    'Resident: lmstudio/qwen3.6-35b-a3b-mlx 20.0 GB (busy, 39 min left)',
    'Local models, with a reserve of 8.0 GB beside the weights:',
    '  lmstudio/qwen3.6-35b-a3b-mlx  20.0 GB  loaded',
    '  lmstudio/qwen3.8-27b-mlx@4bit  16.0 GB  fits',
    '  lmstudio/minimax-m2-reap-139b-a10b  73.0 GB  does not fit: needs 73.0 GB plus a reserve of 8.0 GB, and only 65.9 GB is free',
  ].join('\n'));
  assert.equal(resourceReport({machine: {known: false, reason: 'vm_stat unreadable'}, fleet}), 'Machine: unknown (vm_stat unreadable) · bounce will not hold a local task back');
});
