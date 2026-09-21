// Found live: bounce started from the home folder, so every worker — a local model with a shell
// included — ran from there, and nothing was inside the project it was asked to work on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {homeSessionWarning} from '../src/reload.js';

test('a session opened in the home folder says so; one inside a project says nothing', () => {
  assert.equal(homeSessionWarning('/Users/ana', '/Users/ana'), 'This session is in your home folder (/Users/ana): every worker runs, reads and edits from here, not inside a project. Quit and start bounce from the project folder.');
  assert.equal(homeSessionWarning('/Users/ana/', '/Users/ana'), homeSessionWarning('/Users/ana', '/Users/ana'));
  assert.equal(homeSessionWarning('/Users/ana/code/nirby', '/Users/ana'), null);
  assert.equal(homeSessionWarning(undefined, '/Users/ana'), null);
});
