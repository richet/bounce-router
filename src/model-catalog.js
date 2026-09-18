// The shipped model catalog: what bounce already knows about every model the cloud vendors
// expose in the `/model` picker (`bounce models --json`), so Jev routing (src/jev.js) has a cost
// tier and a capabilities sentence for each out of the box and no agent turn is spent
// describing them (src/roster-notes.js consults this before its cache and before asking).
// Keyed like roster-notes.js modelKey — `adapter/model`, `default` for a profile with no model.
// A profile's own `tier`/`capabilities` in config.json still win over anything here.
//
// Ranking within a vendor follows the vendor's own catalog descriptions; the sentences say what
// each model is safe for and what it is wasteful or risky for, in the vocabulary of TIER_HINT
// (cheapest: locating and extracting; mid: research and routine implementation; strongest:
// review, ambiguous or cross-cutting debugging, security-sensitive work). Local (LM Studio)
// models are dynamic and deliberately absent: /local setup describes them.
export const CATALOG_SOURCE = 'catalog';

const CLAUDE_OPUS = {
  tier: 'strongest',
  capabilities: 'Opus 5 with a 1M-token context: frontier reasoning, dependable tool use and long-horizon autonomy, so it is safe for independent review, ambiguous or cross-cutting debugging, security-sensitive changes and work that must hold a large codebase in context; slow and expensive, so wasteful for lookups, structured extraction and routine single-file edits.',
};

const CLAUDE_FABLE = {
  tier: 'strongest',
  capabilities: 'Fable 5.1 with a 1M-token context: Anthropic\'s most capable model, built for the hardest and longest-running tasks — deep multi-step refactors, subtle cross-cutting bugs, architecture-level decisions and final independent review; the slowest and priciest choice, so reserve it for work Opus 5 struggles with and never spend it on lookups, extraction or routine edits.',
};

const CLAUDE_SONNET = {
  tier: 'mid',
  capabilities: 'Sonnet 5: efficient, fast and a strong coding agent with reliable tool use; safe for routine implementation, tests, research summaries and test-failure triage in a well-scoped task; weaker than Opus on ambiguous multi-module debugging, security-sensitive changes and judgment calls, so escalate those rather than let it guess.',
};

const CLAUDE_HAIKU = {
  tier: 'cheapest',
  capabilities: 'Haiku 4.5: the fastest and cheapest Claude, good at locating files, symbols and call sites, extracting structured facts and small mechanical edits from a precise brief; limited depth on multi-step reasoning and long autonomous runs, so risky for open-ended implementation, cross-cutting debugging or anything that needs independent judgment.',
};

const CODEX_ASTRA = {
  tier: 'strongest',
  capabilities: 'GPT-6 Astra: OpenAI\'s most capable model for complex, demanding work — strong multi-step reasoning, solid Codex CLI tool use, good at ambiguous cross-cutting debugging, hard implementation and independent review; the slowest and most expensive Codex option, so wasteful for file lookups, fact extraction or routine edits a mid-tier model handles.',
};

const CODEX_SOL = {
  tier: 'mid',
  capabilities: 'GPT-5.6 Sol: OpenAI\'s reliable agentic workhorse for everyday tasks — steady on multi-step implementation, test triage and research with dependable tool use, the more thorough of the two mid-tier 5.6 models; safe for routine features and bug fixes with clear acceptance criteria; for ambiguous cross-cutting debugging or security review prefer Astra.',
};

const CODEX_TERRA = {
  tier: 'mid',
  capabilities: 'GPT-5.6 Terra: balanced agentic coding model for everyday work — well-scoped implementation, tests, refactors and research at moderate cost with good tool use; safe for routine builds and triage; weaker than Astra on judgment-heavy, ambiguous or security-sensitive work, and dearer than Luna for plain lookups and extraction.',
};

const CODEX_LUNA = {
  tier: 'cheapest',
  capabilities: 'GPT-5.6 Luna: fast and affordable agentic coding model — good at locating files, symbols and call sites, extracting structured facts, small mechanical edits and quick checks; limited on long multi-step autonomy and ambiguous debugging, so risky for open-ended implementation or anything that needs independent judgment or review.',
};

const CODEX_55 = {
  tier: 'mid',
  capabilities: 'GPT-5.5: proven previous-generation model for coding and general work — dependable on routine implementation, research and test triage with familiar Codex tool use; a safe fallback when the 5.6 models are limited, but behind Sol and Terra on agentic reliability and behind Astra on hard reasoning, so not the pick for ambiguous, cross-cutting or security-sensitive work.',
};

const MUSE_13 = {
  tier: 'mid',
  capabilities: 'Muse Spark 1.3 (Meta): the current Muse model — a capable general coding assistant for research, routine implementation and test triage through the muse CLI, with reasonable tool use; less proven than the Claude and Codex frontier models on long autonomous runs and cross-cutting debugging, so treat as a mid-tier builder and escalate ambiguous or security-sensitive work.',
};

const MUSE_12 = {
  tier: 'mid',
  capabilities: 'Muse Spark 1.2 (Meta): the previous Muse release — fine for research, routine implementation and test triage as a fallback when 1.3 is limited, but behind 1.3 on agentic reliability and tool use; escalate ambiguous, cross-cutting or security-sensitive work to a frontier model rather than let it guess.',
};

// The -contributor variants run the same models but share prompts and code with the vendor for
// product improvement: same tier, and the note leads with that so routing never sends
// confidential work there by accident. They are kept out of the default roster for the same reason.
const MUSE_13_CONTRIBUTOR = {
  tier: 'mid',
  capabilities: 'Muse Spark 1.3 contributor variant: shares your prompts and code with the vendor for product improvement, so never route confidential repositories to it; otherwise the same mid-tier Muse model — fine for research, routine implementation and test triage on public or throwaway code, and not the pick for ambiguous or security-sensitive work.',
};

const MUSE_12_CONTRIBUTOR = {
  tier: 'mid',
  capabilities: 'Muse Spark 1.2 contributor variant: shares your prompts and code with the vendor for product improvement, so never route confidential repositories to it; otherwise the previous mid-tier Muse release — a fallback for research and routine implementation on public or throwaway code, behind 1.3 on agentic reliability.',
};

export const MODEL_CATALOG = Object.freeze({
  // claude: `default` (no model) and `opus[1m]` are the same model in the picker; plain `opus` is
  // what a hand-written profile most often says.
  'claude/default': CLAUDE_OPUS,
  'claude/opus[1m]': CLAUDE_OPUS,
  'claude/opus': CLAUDE_OPUS,
  'claude/claude-fable-5-1[1m]': CLAUDE_FABLE,
  'claude/sonnet': CLAUDE_SONNET,
  'claude/haiku': CLAUDE_HAIKU,
  // codex
  'codex/gpt-6-astra': CODEX_ASTRA,
  'codex/gpt-5.6-sol': CODEX_SOL,
  'codex/gpt-5.6-terra': CODEX_TERRA,
  'codex/gpt-5.6-luna': CODEX_LUNA,
  'codex/gpt-5.5': CODEX_55,
  // muse
  'muse/muse-spark-1.3': MUSE_13,
  'muse/muse-spark-1.3-contributor': MUSE_13_CONTRIBUTOR,
  'muse/muse-spark-1.2': MUSE_12,
  'muse/muse-spark-1.2-contributor': MUSE_12_CONTRIBUTOR,
});

// The shipped note for a model key (`adapter/model`), or null when bounce does not know it.
export const catalogNote = key => MODEL_CATALOG[key] ?? null;
