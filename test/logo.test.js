import test from 'node:test';
import assert from 'node:assert/strict';
import {BOUNCE_LOGO} from '../src/logo.js';
import {clean} from '../src/format.js';

test('compact wordmark fits the sidebar and survives display cleaning', () => {
  assert.equal(BOUNCE_LOGO, 'BOUNCE');
  assert.equal(clean(BOUNCE_LOGO), BOUNCE_LOGO);
});
