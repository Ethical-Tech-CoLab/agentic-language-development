import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { compileRegistrationPacket } from '@ald/analysis';
import { FakeChainTransport } from '@ald/anchor';
import { PreRegistrationBindingSchema } from '@ald/types';
import { e01AttemptIds, e01GatewayCorpus, E01_STORAGE_PATHS } from '../deploy/mode-r/e01-corpus.mjs';

const packetPath = 'protocols/e01-registration.v2.json';
const bindingPath = 'protocols/e01-registration-binding.v2.json';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const writeNew = (path, value) => {
  assert.equal(existsSync(path), false, `refusing to overwrite ${path}`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};
const mode = process.argv[2];
assert.ok(['--compile', '--activate', '--check'].includes(mode) && process.argv.length === 3);

if (mode === '--compile') {
  assert.equal(git('status', '--porcelain'), '', 'compile from a clean implementation commit');
  const base = read('protocols/e01-registration.v1.json');
  const bindings = Object.fromEntries(base.artifact.bindings.map((b) => [b.key, b.content]));
  const protocolBaseCommit = git('rev-parse', 'HEAD');
  const seedRoot = 'ald-e01-explicit-v2-fresh-qualification';
  const sourcePaths = [...new Set([
    ...git('ls-files', 'packages', 'twins', 'contracts', 'deploy/mode-r').split('\n')
      .filter((path) => !path.includes('/__tests__/') && /\.(ts|js|mjs|json|yml|md)$/u.test(path)),
    'scripts/register-e01-v2.mjs', 'scripts/run-e01-v2.mjs',
    'tools/integrity-auditor/src/main.rs', 'tools/integrity-auditor/Cargo.lock', 'pnpm-lock.yaml',
  ])].sort();
  bindings.analysisVersions = sourcePaths.map((path) => ({ path, sha256: sha256(readFileSync(path)) }));
  bindings.runConfigurations = [{ protocolBaseCommit, experimentId: 'E01', stage: 'software-qualification',
    deploymentMode: 'research-grade', learnerTrack: 'no-learning', topologySlots: 5,
    turnResponseBudgetMs: 1000, maxSymbolsPerMessage: 4, maxConsecutiveRejections: 3,
    gatewayRejectionAttempts: 20, transportSamplesPerCondition: 40, hostProbeRequests: 10,
    deliveryPositiveControls: 1, detectorFixtureRecords: 1, signedRecordsPerSlot: e01AttemptIds().length }];
  bindings.practicalMargins = { prohibitedDeliveries: 0, maximumAbsoluteTimingMeanDifferenceMs: 100,
    envelopeBytes: 8192, malformedResponse: 'adapter-error', retryPauseAt: 3,
    storageReadOutcome: 'denied', peerNetworkOutcome: 'refused', requiredPassingSlotFraction: 1,
    everyRecordSignedAndCheckpointed: true, bothVerifierImplementationsRequired: true };
  bindings.selectedSeedPrefix = { root: seedRoot, stage: 'software-qualification', reserves: 'none',
    primary: Array.from({ length: 5 }, (_, i) => ({ slot: i + 1, scenario: sha256(`${seedRoot}\0${i + 1}`) })) };
  bindings.executionHost = { topology: 'two separate internal learner networks and one Nursery on both',
    nodeImage: 'node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf',
    pnpm: '12.3.4', externalSpend: 0, maximumParallelSlots: 1 };
  bindings.scenarioBundle = { attemptOrder: e01AttemptIds(), storagePaths: E01_STORAGE_PATHS,
    gatewayCorpus: e01GatewayCorpus().map(({ id, proposal }) => ({ id,
      inputJsonBase64: Buffer.from(JSON.stringify(proposal)).toString('base64') })),
    malformedVariants: ['symbols-string', 'symbols-number-array', 'empty-with-extension', 'symbols-null'],
    recreateLearnerContainersBetweenSlots: true, syntheticOnly: true,
    controlScope: 'planted detector fixtures plus a real allowed Gateway delivery; fixtures are not live escape observations' };
  bindings.exclusionRules = ['retain all attempts and failures', 'development observations cannot become registered results',
    'a failed measurement or verifier fails its slot; no replacement seeds'];
  bindings.stoppingRules = { plannedSlots: 5, outcomeDependent: false,
    allSlotsUnlessInfrastructureFailure: true, noSameSeedRerun: true };
  bindings.evidenceAndAnchorPolicy = { anchorClass: 'simulated', publicChainTransaction: false,
    requiredPreRunConfirmations: 3, postRunConfirmations: 1, externalSpend: 0,
    evidenceRoot: 'evidence/qualification/e01-v2', receiptPath: 'reports/research/e01-v2-qualification-receipt.json',
    witnessSignaturePerRecord: true, fullInclusionProofCoverage: true,
    retainedRawFrames: true, privateSigningMaterialExported: false };
  const compiled = compileRegistrationPacket({ experimentId: 'E01', registrationClass: 'qualification', bindings });
  writeNew(packetPath, { artifact: compiled.artifact, preRegistrationHash: compiled.preRegistrationHash,
    protocolBaseCommit, researchFinding: false, claimBoundary: compiled.claimBoundary });
} else {
  const packet = read(packetPath);
  const bindings = Object.fromEntries(packet.artifact.bindings.map((b) => [b.key, b.content]));
  const compiled = compileRegistrationPacket({ experimentId: 'E01', registrationClass: 'qualification', bindings });
  assert.deepEqual(compiled.artifact, packet.artifact);
  assert.equal(compiled.preRegistrationHash, packet.preRegistrationHash);
  const commit = git('log', '-1', '--format=%H', '--', packetPath);
  git('merge-base', '--is-ancestor', commit, 'HEAD');
  assert.equal(git('show', `${commit}:${packetPath}`), readFileSync(packetPath, 'utf8').trim());
  {
    const chain = new FakeChainTransport({ endpointLabel: 'e01-v2-registration-simulation' });
    const tx = await chain.sendAnchorTransaction({ checkpointHash: packet.preRegistrationHash, to: `0x${'42'.repeat(20)}` });
    chain.mineBlock(3);
    const receipt = await chain.getTransactionReceipt(tx.transactionHash);
    assert.equal(receipt.status, 'success');
    const binding = PreRegistrationBindingSchema.parse({ registrationClass: 'qualification', registrationAuthority: 'repository-native',
      preRegistrationHash: packet.preRegistrationHash, repositoryRegistration: { commit, path: packetPath,
        artifactSha256: packet.preRegistrationHash, committedAt: git('show', '-s', '--format=%cI', commit) },
      preRunAnchor: { anchorClass: 'simulated', network: chain.network, chainId: chain.chainId,
        transactionHash: tx.transactionHash, inputData: tx.inputData, blockNumber: receipt.blockNumber, status: 'confirmed' },
      label: 'E01 v2 software qualification; local simulation is not independent public timestamping' });
    if (mode === '--activate') {
      assert.equal(git('status', '--porcelain'), '', 'activate a committed packet');
      writeNew(bindingPath, binding);
    } else assert.deepEqual(read(bindingPath), binding);
  }
}
console.log(`E01 v2 registration ${mode.slice(2)} complete`);
