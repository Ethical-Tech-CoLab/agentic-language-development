import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { verifyBundle } from '@ald/verifier';

const mode = process.argv[2];
assert.ok(process.argv.length === 3 && ['--audit', '--write'].includes(mode),
  'usage: node scripts/audit-mode-r-signer-reference.mjs --audit|--write');

const root = 'evidence/validation/mode-r-study-2358394';
const receiptPath = 'reports/research/mode-r-signer-reference-audit-receipt.json';
const auditorPath = '.artifacts/cargo-target/release/ald-integrity-auditor';
const tracks = ['no-learning', 'scratch-rl', 'self-supervised', 'hybrid'];
const signerServices = ['signer-baby-a-ledger', 'signer-baby-b-ledger',
  'signer-channel', 'signer-affect', 'signer-audit', 'signer-witness'];
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

assert.equal(git('status', '--porcelain'), '', 'audit requires clean source');
const auditCommit = git('rev-parse', 'HEAD');
const terminalPath = join(root, 'terminal.json');
const terminal = read(terminalPath);
assert.equal(terminal.schemaVersion, 1);
assert.equal(terminal.classification, 'mode-r-signer-container-reference-terminal');
assert.equal(terminal.researchFinding, false);
assert.equal(terminal.publicChainTransaction, false);
assert.equal(terminal.b12Closed, false);
assert.equal(terminal.allSealedAndVerified, true);
assert.equal(terminal.independentRustAuditCompleted, false);
assert.equal(terminal.fortComposeBoundaryVerified, true);
assert.equal(terminal.recurrentCapacityMatched, true);
assert.equal(terminal.execution.cleanBeforeAndAfter, true);
assert.equal(resolve(terminal.outputDir), resolve(root));
assert.equal(terminal.execution.tree,
  git('rev-parse', `${terminal.execution.commit}^{tree}`));
assert.equal(terminal.execution.version,
  JSON.parse(git('show', `${terminal.execution.commit}:package.json`)).version);
assert.equal(terminal.runs.length, tracks.length);

const originalContainerIds = [];
const runs = [];
for (const [index, track] of tracks.entries()) {
  const runId = `mode-r-study-${track}`;
  const recorded = terminal.runs[index];
  const summaryPath = join(root, `${runId}-summary.json`);
  const summary = read(summaryPath);
  const { signerContainerIds, ...recordedSummary } = recorded;
  assert.deepEqual(recordedSummary, summary, `${track}: terminal and original summary differ`);
  assert.equal(summary.track, track);
  assert.equal(summary.runId, runId);
  assert.equal(summary.softwareCommit, terminal.execution.commit);
  assert.equal(summary.state, 'sealed');
  assert.equal(summary.verifierExitCode, 0);
  assert.equal(summary.signerBoundary, 'six-ephemeral-container-signers');
  assert.equal(summary.researchFinding, false);
  assert.equal(summary.publicChainTransaction, false);
  assert.equal(summary.trainingTurns, 4);
  assert.equal(summary.evaluationTurns, 4);
  assert.equal(summary.anchorReceiptCount, 1);
  assert.deepEqual(Object.keys(signerContainerIds).sort(), [...signerServices].sort());
  const ids = Object.values(signerContainerIds);
  for (const id of ids) assert.match(id, /^[a-f0-9]{64}$/u);
  assert.equal(new Set(ids).size, signerServices.length);
  originalContainerIds.push(...ids);

  const bundle = join(root, 'bundles', 'runs', runId);
  const manifest = read(join(bundle, 'run-manifest.json'));
  assert.equal(manifest.runId, runId);
  assert.equal(manifest.softwareCommit, terminal.execution.commit);
  const verification = await verifyBundle(bundle, {
    verifierVersion: 'mode-r-signer-reference-independent-audit',
    now: () => new Date().toISOString(), writeReport: false,
  });
  assert.equal(verification.exitCode, 0, `${track}: TypeScript verification failed`);
  const rust = JSON.parse(execFileSync(auditorPath, [bundle], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
  }));
  assert.equal(rust.integrityPass, true, `${track}: Rust verification failed`);
  assert.equal(rust.anchored, true, `${track}: local simulated anchor missing`);
  assert.deepEqual(rust.issues, []);
  assert.equal(rust.checkpointCount, summary.checkpointCount);
  runs.push({
    track, runId, summarySha256: sha256(summaryPath),
    bundleManifestHash: verification.bundleManifestHash,
    signedEventCount: rust.eventCount, checkpointCount: rust.checkpointCount,
    signerContainerIds,
    typescriptVerified: true, rustVerified: true,
  });
}
assert.equal(new Set(originalContainerIds).size, tracks.length * signerServices.length);
assert.equal(runs[1].checkpointCount, runs[2].checkpointCount);
assert.equal(terminal.runs[1].recurrentPolicy.parameterCount,
  terminal.runs[2].recurrentPolicy.parameterCount);
assert.equal(git('status', '--porcelain'), '', 'source changed during independent audit');

const receipt = {
  schemaVersion: 1,
  classification: 'bounded-mode-r-signer-reference-independent-audit',
  executionCommit: terminal.execution.commit,
  executionTree: terminal.execution.tree,
  executionVersion: terminal.execution.version,
  auditCommit,
  originalEvidenceRoot: root,
  originalTerminalSha256: sha256(terminalPath),
  rustAuditorSha256: sha256(auditorPath),
  runs,
  allFourOriginalBundlesVerified: true,
  researchFinding: false,
  publicChainTransaction: false,
  b12Closed: false,
  limits: [
    'Host container inspection is an original-run assertion, not independently replayable after cleanup.',
    'The anchor is local and simulated; it is not a public-chain transaction.',
    'Adapter hosts are not separate Baby-twin processes; Gateway, writer, and Controller remain in Nursery.',
    'The six signer keys are ephemeral, not Fort-provisioned per domain.',
    'This reference does not qualify the selected E10+ topology or establish a behavioral result.',
  ],
};

if (mode === '--write') {
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
