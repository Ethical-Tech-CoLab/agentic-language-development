import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { collectE02Observations } from './collect-e02-observations.mjs';

// Development only: no registration claim, no promotion to E02 outcomes.
const [directory, seed, mode, profile = 'full'] = process.argv.slice(2);
assert.ok(process.argv.length === 5 || process.argv.length === 6,
  'usage: develop-e02-observations.mjs <development-directory> <seed> <prototype|research-grade> [full|smoke]');
assert.ok(['full', 'smoke'].includes(profile));
const softwareCommit = mode === 'prototype'
  ? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  : process.env['ALD_SOFTWARE_COMMIT'];
const result = await collectE02Observations({ directory, seed, mode, profile, softwareCommit });
if (!result.passed) process.exitCode = 1;
