// The scheduler's host-facing defaults, replaced for tests: no memory probe (an unknown machine skips
// the memory gate by design), no local model discovery, no `lms unload`. Spread into createScheduler
// by every test that dispatches a local profile; test/helpers/hermetic.js refuses the real ones.
export const hostless = {
  resources: {read: () => ({known: false}), underPressure: () => false},
  localFleet: async () => null,
  unloadLocal: async name => { throw new Error(`test tried to unload ${name}`); },
};
