// What Jev answers for a finding to come out at a given strength: the answers behind each of the
// seven findings (src/jev.js VERDICT_CHECKS). A test says "unverified_claims: 0.9" and its fake Jev
// answers the questions that finding is worked out from.
const not = value => Math.round((1 - value) * 100) / 100;
const BEHIND = {
  outside_scope: value => ({changes_outside_scope: value}),
  forbidden_files: value => ({changes_forbidden_file: value}),
  unbacked_tests: value => ({claims_tests_passed: value}),
  remaining_work: value => ({names_remaining_work: value}),
  unmet_acceptance: value => ({meets_acceptance: not(value)}),
  unverified_claims: value => ({claims_outcome: value, shows_backing: not(value)}),
  empty_diff: value => ({orders_need_changes: value}),
};

export const findingAnswers = (findings = {}) => Object.fromEntries(Object.entries(findings)
  .flatMap(([name, value]) => Object.entries(BEHIND[name] ? BEHIND[name](value) : {[name]: value}))
  .map(([name, noul]) => [name, {type: 'noul', noul}]));
