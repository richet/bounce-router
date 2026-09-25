import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveSessionName} from '../src/session-names.js';

test('deriveSessionName: deterministic, matches the adjective-noun shape, two ids differ', () => {
  const id = 'e9353126-0000-0000-0000-000000000000';
  const first = deriveSessionName(id);
  assert.equal(deriveSessionName(id), first, 'same id must always derive the same name');
  assert.match(first, /^[a-z]+-[a-z]+$/);
  const other = deriveSessionName('12345678-0000-0000-0000-000000000000');
  assert.notEqual(other, first);
  assert.match(other, /^[a-z]+-[a-z]+$/);
});

test('deriveSessionName: fixed fixtures give the expected name', () => {
  // Pinned against the current word lists and hash scheme; a deliberate list/scheme change
  // updates these together.
  assert.equal(deriveSessionName('e9353126-1111-1111-1111-111111111111'), 'wide-meteor');
  assert.equal(deriveSessionName('abc'), 'happy-horizon');
  assert.equal(deriveSessionName('session-123'), 'sure-viper');
});

test('deriveSessionName: word lists have no duplicates', async () => {
  const mod = await import('../src/session-names.js');
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/session-names.js', import.meta.url), 'utf8'));
  const list = (name) => [...src.matchAll(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`, 'g'))][0][1].match(/'[a-z]+'/g).map(w => w.slice(1, -1));
  const adjectives = list('ADJECTIVES'), nouns = list('NOUNS');
  assert.equal(new Set(adjectives).size, adjectives.length);
  assert.equal(new Set(nouns).size, nouns.length);
  assert.ok(adjectives.length >= 150 && nouns.length >= 150);
  void mod;
});

test('deriveSessionName: the two lists are disjoint (a word in both could derive "word-word")', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/session-names.js', import.meta.url), 'utf8'));
  const list = (name) => [...src.matchAll(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`, 'g'))][0][1].match(/'[a-z]+'/g).map(w => w.slice(1, -1));
  const adjectives = list('ADJECTIVES'), nouns = list('NOUNS');
  const overlap = adjectives.filter(w => nouns.includes(w));
  assert.deepEqual(overlap, []);
});
