#!/usr/bin/env node
// Prints one line the integrator pastes into a dispatch and the worker reproduces byte-for-byte:
//   <sha> branch=<name> dirty=<n> tests=<pass>/<total> fail=<n> check=<ok|fail>
import {execFileSync, spawnSync} from 'node:child_process';
const git = args => execFileSync('git', args, {encoding: 'utf8'}).trim();
const sha = git(['rev-parse', '--short', 'HEAD']), branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
const test = spawnSync('npm', ['test'], {encoding: 'utf8'});
const count = key => Number((test.stdout.match(new RegExp(`^# ${key} (\\d+)`, 'm')) ?? [])[1] ?? -1);
const check = spawnSync('npm', ['run', 'check'], {encoding: 'utf8'}).status === 0 ? 'ok' : 'fail';
console.log(`${sha} branch=${branch} dirty=${dirty} tests=${count('pass')}/${count('tests')} fail=${count('fail')} check=${check}`);
