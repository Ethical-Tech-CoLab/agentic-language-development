import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const receipt = JSON.parse(readFileSync(
  'reports/research/mode-r-signer-reference-audit-receipt.json', 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const ancestor = (first, second) => {
  execFileSync('git', ['merge-base', '--is-ancestor', first, second]);
};
const tracks = ['no-learning', 'scratch-rl', 'self-supervised', 'hybrid'];
const signerServices = ['signer-baby-a-ledger', 'signer-baby-b-ledger',
  'signer-channel', 'signer-affect', 'signer-audit', 'signer-witness'];

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification,
  'bounded-mode-r-signer-reference-independent-audit');
assert.equal(receipt.originalEvidenceRoot,
  'evidence/validation/mode-r-study-2358394');
assert.match(receipt.originalTerminalSha256, /^sha256:[a-f0-9]{64}$/u);
assert.match(receipt.rustAuditorSha256, /^sha256:[a-f0-9]{64}$/u);
assert.equal(receipt.allFourOriginalBundlesVerified, true);
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.publicChainTransaction, false);
assert.equal(receipt.b12Closed, false);
assert.equal(receipt.executionTree,
  git('rev-parse', `${receipt.executionCommit}^{tree}`));
assert.equal(receipt.executionVersion,
  JSON.parse(git('show', `${receipt.executionCommit}:package.json`)).version);
ancestor(receipt.executionCommit, receipt.auditCommit);
ancestor(receipt.auditCommit, 'HEAD');
assert.ok(git('show',
  `${receipt.auditCommit}:scripts/audit-mode-r-signer-reference.mjs`)
  .includes('mode-r-signer-reference-independent-audit'));
assert.equal(receipt.runs.length, tracks.length);

const ids = [];
for (const [index, run] of receipt.runs.entries()) {
  const track = tracks[index];
  assert.equal(run.track, track);
  assert.equal(run.runId, `mode-r-study-${track}`);
  assert.match(run.summarySha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(run.bundleManifestHash, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(run.signedEventCount) && run.signedEventCount > 0);
  assert.ok(Number.isSafeInteger(run.checkpointCount) && run.checkpointCount > 0);
  assert.equal(run.typescriptVerified, true);
  assert.equal(run.rustVerified, true);
  assert.deepEqual(Object.keys(run.signerContainerIds).sort(), [...signerServices].sort());
  for (const id of Object.values(run.signerContainerIds)) {
    assert.match(id, /^[a-f0-9]{64}$/u);
    ids.push(id);
  }
}
assert.equal(new Set(ids).size, tracks.length * signerServices.length);
assert.ok(receipt.limits.some((limit) => limit.includes('not a public-chain')));
assert.ok(receipt.limits.some((limit) => limit.includes('does not qualify the selected E10+')));
process.stdout.write('Mode R signer reference portable receipt valid; raw evidence replay is separate\n');
