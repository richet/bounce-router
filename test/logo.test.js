import test from 'node:test';
import assert from 'node:assert/strict';
import {BOUNCE_LOGO} from '../src/logo.js';
import {clean} from '../src/format.js';

test('logo is multi-line plain ASCII art that survives display cleaning', () => {
  const lines = BOUNCE_LOGO.split('\n');
  assert.ok(lines.length >= 3, 'logo should be multi-line art');
  assert.ok(lines.every(line => line.length > 0), 'no blank lines inside the art');
  assert.ok(lines.every(line => line.length <= 60), 'fits narrow terminals without wrapping');
  assert.ok(lines.every(line => /^[\x20-\x7e]*$/.test(line)), 'printable ASCII only');
  assert.ok(lines.every(line => line === line.trimEnd()), 'no load-bearing trailing spaces');
  assert.equal(clean(BOUNCE_LOGO), BOUNCE_LOGO, 'clean() must not alter the art');
  const ink = BOUNCE_LOGO.replace(/ /g, '');
  assert.ok(ink.length > BOUNCE_LOGO.length / 2, 'logo should be mostly letterforms, not whitespace');
});
