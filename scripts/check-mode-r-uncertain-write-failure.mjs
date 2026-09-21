import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path = 'reports/research/mode-r-uncertain-write-development-v1-failure.json';
const report = JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (target) => createHash('sha256').update(readFileSync(target)).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

assert.equal(report.schemaVersion, 1);
assert.equal(report.classification, 'selected-mode-r-uncertain-write-development-failure');
assert.equal(report.researchFinding, false);
assert.equal(report.b12Closed, false);
assert.equal(report.passed, false);
assert.equal(report.terminal.controllerExitCode, 1);
assert.equal(report.terminal.controllerOomKilled, false);
assert.equal(report.terminal.unexpectedRunningAfterTeardown, 0);
assert.equal(git('show', '-s', '--format=%T', report.executionCommit), report.executionTree);
assert.equal(JSON.parse(git('show', `${report.executionCommit}:package.json`)).version,
  report.executionVersion);
assert.equal(readFileSync(report.protocol.path).byteLength, report.protocol.bytes);
assert.equal(sha256(report.protocol.path), report.protocol.sha256.slice(7));

if (process.argv.includes('--live-evidence')) {
  assert.equal(readFileSync(report.rawReceipt.path).byteLength, report.rawReceipt.bytes);
  assert.equal(sha256(report.rawReceipt.path), report.rawReceipt.sha256.slice(7));
  const raw = JSON.parse(readFileSync(report.rawReceipt.path, 'utf8'));
  assert.equal(raw.executionCommit, report.executionCommit);
  assert.equal(raw.passed, false);
  assert.equal(raw.injectTerminal.exitCode, 1);
  assert.equal(raw.injectTerminal.oomKilled, false);
  assert.equal(raw.unexpectedRunningAfterTeardown, 0);
}

console.log('selected uncertain-write v1 failure reconciles; B12 remains open');
