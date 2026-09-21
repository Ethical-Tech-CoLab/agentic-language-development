import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.ok(process.argv.length <= 3 &&
  (process.argv[2] === undefined || process.argv[2] === '--journal'),
  'usage: node scripts/check-mode-r-signer-reference-receipt.mjs [--journal]');
const journalReference = process.argv[2] === '--journal';
const receipt = JSON.parse(readFileSync(journalReference
  ? 'reports/research/mode-r-journal-reference-audit-receipt.json'
  : 'reports/research/mode-r-signer-reference-audit-receipt.json', 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const ancestor = (first, second) => {
  execFileSync('git', ['merge-base', '--is-ancestor', first, second]);
};
const tracks = ['no-learning', 'scratch-rl', 'self-supervised', 'hybrid'];
const signerServices = ['signer-baby-a-ledger', 'signer-baby-b-ledger',
  'signer-channel', 'signer-affect', 'signer-audit', 'signer-witness'];

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification, journalReference
  ? 'bounded-mode-r-journal-reference-independent-audit'
  : 'bounded-mode-r-signer-reference-independent-audit');
assert.equal(receipt.originalEvidenceRoot, journalReference
  ? 'evidence/validation/mode-r-study-2724959'
  : 'evidence/validation/mode-r-study-2358394');
if (journalReference) {
  assert.equal(receipt.executionCommit,
    'ad81bb289284136cee5eb7ffa4cefd28db72b925');
  assert.equal(receipt.auditCommit,
    'cf15985d0dfd5d868ee7da2f9cc5472657dac433');
  assert.equal(receipt.originalTerminalSha256,
    'sha256:12304233982d6f037b3e2a79c4d8109ab72dd8a38344acf9df022e50956b3867');
}
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
  .includes(receipt.classification));
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
  if (journalReference) {
    assert.equal(run.journal?.intentCount, 16);
    assert.equal(run.journal?.confirmationCount, 16);
    assert.equal(run.journal?.unresolvedCount, 0);
    assert.ok(Number.isSafeInteger(run.journal?.logicalBytes) &&
      run.journal.logicalBytes > 0);
    assert.ok(Number.isSafeInteger(run.journal?.allocatedBytes) &&
      run.journal.allocatedBytes >= run.journal.logicalBytes);
  }
  assert.deepEqual(Object.keys(run.signerContainerIds).sort(), [...signerServices].sort());
  for (const id of Object.values(run.signerContainerIds)) {
    assert.match(id, /^[a-f0-9]{64}$/u);
    ids.push(id);
  }
}
assert.equal(new Set(ids).size, tracks.length * signerServices.length);
if (journalReference) {
  assert.equal(receipt.runs.reduce((sum, run) => sum + run.journal.logicalBytes, 0),
    24_800);
  assert.equal(receipt.runs.reduce((sum, run) => sum + run.journal.allocatedBytes, 0),
    540_672);
  assert.ok(receipt.limits.some((limit) => limit.includes('not signed research evidence')));
}
assert.ok(receipt.limits.some((limit) => limit.includes('not a public-chain')));
assert.ok(receipt.limits.some((limit) => limit.includes('does not qualify the selected E10+')));
process.stdout.write(journalReference
  ? 'Mode R journal reference portable receipt valid; raw evidence replay is separate\n'
  : 'Mode R signer reference portable receipt valid; raw evidence replay is separate\n');
