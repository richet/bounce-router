// A memorable name for a session that never had one, derived from its id — computed, not
// stored, so it applies to every existing session with zero migration and never changes.
// Two curated word lists (short, common, easy to say and type) plus a hash of the full id
// give a stable "adjective-noun" pair. An explicit /rename always wins over this — see
// resolveSessionRef in sessions.js, which is where the two are reconciled.
import crypto from 'node:crypto';

// 192 adjectives, 206 nouns. Kept short and unambiguous — no near-homophones, no offensive
// or confusing words, nothing that reads oddly next to a noun, and disjoint from NOUNS (a
// word in both lists could derive "word-word").
const ADJECTIVES = [
  'amber', 'arctic', 'autumn', 'azure', 'bold', 'brave', 'bright', 'brisk', 'bronze', 'busy',
  'calm', 'candid', 'canny', 'cheerful', 'chill', 'civic', 'classic', 'clear', 'clever',
  'cobalt', 'cool', 'cosmic', 'cozy', 'crimson', 'crisp', 'curious', 'dapper',
  'daring', 'deep', 'diligent', 'dry', 'dusty', 'eager', 'early', 'earnest', 'easy', 'electric',
  'elegant', 'emerald', 'epic', 'even', 'fair', 'faithful', 'famous', 'fancy', 'fast', 'fine',
  'firm', 'flint', 'fluent', 'fond', 'fresh', 'frosty', 'gallant', 'gentle', 'giant', 'glad',
  'gold', 'golden', 'good', 'grand', 'gray', 'green', 'happy', 'hardy', 'hasty',
  'hearty', 'hidden', 'honest', 'humble', 'ideal', 'indigo', 'ivory', 'jade', 'jolly', 'jovial',
  'keen', 'kind', 'lean', 'light', 'lively', 'local', 'lofty', 'loyal', 'lucid',
  'lucky', 'lunar', 'mellow', 'merry', 'mighty', 'misty', 'modern', 'modest', 'mossy', 'muted',
  'native', 'neat', 'new', 'nice', 'nimble', 'noble', 'north', 'novel', 'ochre', 'olive',
  'open', 'opal', 'orange', 'pale', 'patient', 'peppy', 'placid', 'plucky',
  'polite', 'prime', 'proud', 'prudent', 'quick', 'quiet', 'rapid', 'rare', 'ready', 'regal',
  'robust', 'rosy', 'rough', 'round', 'royal', 'ruby', 'rugged', 'rustic', 'sandy', 'sage',
  'scarlet', 'sharp', 'shiny', 'silent', 'silver', 'simple', 'sincere', 'sleek', 'slim', 'smart',
  'smooth', 'snowy', 'sober', 'solar', 'solid', 'sound', 'south', 'spare', 'stable',
  'steady', 'steep', 'stern', 'still', 'stout', 'strong', 'sturdy', 'subtle', 'sunny', 'super',
  'sure', 'swift', 'tame', 'tan', 'teal', 'tender', 'terse', 'thrifty', 'tidy', 'tiny',
  'topaz', 'tough', 'true', 'trusty', 'upbeat', 'urban', 'valid', 'vast', 'vernal', 'vital',
  'vivid', 'warm', 'well', 'west', 'wide', 'wild', 'wise', 'witty', 'young', 'zesty',
];

const NOUNS = [
  'acorn', 'anchor', 'antelope', 'arrow', 'aspen', 'badger', 'basin', 'bay', 'beacon', 'beaver',
  'birch', 'bison', 'boulder', 'brook', 'canary', 'canyon', 'cardinal', 'cave', 'cedar', 'chalk',
  'cheetah', 'cliff', 'cloud', 'clover', 'coast', 'cobra', 'comet', 'compass', 'condor', 'coral',
  'cottage', 'cougar', 'coyote', 'crane', 'creek', 'crow', 'current', 'dawn', 'deer', 'delta',
  'desert', 'dolphin', 'dove', 'dragon', 'dune', 'eagle', 'echo', 'egret', 'elk', 'ember',
  'falcon', 'fawn', 'fern', 'field', 'finch', 'fjord', 'flame', 'forest', 'fox', 'garden',
  'gazelle', 'glacier', 'glade', 'goose', 'granite', 'grove', 'gull', 'gulf', 'harbor', 'hawk',
  'hazel', 'heron', 'hill', 'holly', 'horizon', 'hornet', 'hummingbird', 'ibis', 'iceberg', 'island',
  'ivy', 'jackal', 'jaguar', 'jasmine', 'jay', 'juniper', 'kestrel', 'kite', 'koala', 'lagoon',
  'lake', 'lantern', 'lark', 'lava', 'leaf', 'ledge', 'lemur', 'lily', 'lion', 'llama',
  'lotus', 'lynx', 'maple', 'marlin', 'marsh', 'meadow', 'mesa', 'meteor', 'mink', 'mist',
  'moon', 'moose', 'moth', 'mountain', 'mouse', 'narwhal', 'nebula', 'nest', 'newt', 'oak',
  'oasis', 'ocean', 'orbit', 'orca', 'orchid', 'osprey', 'otter', 'owl', 'panda', 'panther',
  'peak', 'pebble', 'pelican', 'penguin', 'petrel', 'pigeon', 'pine', 'plain', 'plateau', 'plover',
  'plum', 'pond', 'poppy', 'prairie', 'quail', 'quarry', 'rabbit', 'raccoon', 'rain', 'raven',
  'reef', 'ridge', 'river', 'robin', 'rock', 'rose', 'saguaro', 'salmon', 'sand', 'sequoia',
  'shadow', 'shell', 'shore', 'shrew', 'sky', 'sloth', 'snail', 'snow', 'sparrow', 'spring',
  'spruce', 'squall', 'squid', 'star', 'stone', 'stork', 'storm', 'stream', 'summit', 'sun',
  'swallow', 'swan', 'tern', 'thicket', 'thistle', 'thrush', 'thunder', 'tide', 'tiger', 'trail',
  'tundra', 'turtle', 'valley', 'viper', 'vista', 'vole', 'walrus', 'warbler', 'wave', 'whale',
  'willow', 'wolf', 'wren', 'yak', 'zebra', 'zephyr',
];

// Two uint32s out of a sha256 digest give ~2^64 of spread across the id space for a fixed,
// small list product — collisions are possible (the resolver in sessions.js handles them)
// but not clustered.
export function deriveSessionName(id) {
  const digest = crypto.createHash('sha256').update(String(id)).digest();
  const adjective = ADJECTIVES[digest.readUInt32BE(0) % ADJECTIVES.length];
  const noun = NOUNS[digest.readUInt32BE(4) % NOUNS.length];
  return `${adjective}-${noun}`;
}
