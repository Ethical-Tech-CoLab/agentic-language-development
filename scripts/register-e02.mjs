import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { compileRegistrationPacket } from '@ald/analysis';
import { FakeChainTransport } from '@ald/anchor';
import { PreRegistrationBindingSchema } from '@ald/types';
import { e02RootBuildInputs, validateE02SlotContract } from '../deploy/mode-r/e02-slot-contract.mjs';
import { E02_REGISTERED_ROWS_PER_STAGE, E02_REGISTERED_ANALYSIS_VERSION, E02_PROBES, E02_LABELS } from '../deploy/mode-r/e02-observation-analysis.mjs';

const packetPath = 'protocols/e02-registration.v1.json';
const bindingPath = 'protocols/e02-registration-binding.v1.json';
const resourcePath = 'reports/research/e02-resource-envelope.json';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writeNew = (path, value) => {
  assert.equal(existsSync(path), false, `refusing to overwrite ${path}`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};
const mode = process.argv[2];
assert.ok(process.argv.length === 3 && ['--compile', '--activate', '--check'].includes(mode));

if (mode === '--compile') {
  assert.equal(git('status', '--porcelain'), '', 'compile from a clean implementation commit');
  execFileSync(process.execPath, ['scripts/check-e02-resource-envelope.mjs', '--live-evidence'], { stdio: 'inherit' });
  const resource = read(resourcePath);
  assert.equal(resource.classification, 'development-resource-envelope');
  assert.equal(resource.researchFinding, false);
  assert.equal(resource.smokePassed, true);
  assert.equal(resource.rowsPerRolePerStage, E02_REGISTERED_ROWS_PER_STAGE);
  assert.equal(resource.maximumParallelSlots, 1);
  const cardPath = 'protocols/research-protocol-cards.v1.json';
  const card = read(cardPath).cards.find((entry) => entry.id === 'E02');
  assert.ok(card);
  const sourcePaths = [...new Set([
    ...git('ls-files', 'packages', 'twins', 'contracts', 'deploy/mode-r').split('\n')
      .filter((path) => !path.includes('/__tests__/') && /\.(ts|js|mjs|json|yml|md)$/u.test(path)),
    'deploy/mode-r/Dockerfile', 'scripts/register-e02.mjs', 'scripts/run-e02.mjs', 'scripts/check-e02-resource-envelope.mjs',
    'tools/integrity-auditor/src/main.rs', 'tools/integrity-auditor/Cargo.lock',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json', '.dockerignore', resourcePath,
  ])].sort();
  const protocolBaseCommit = git('rev-parse', 'HEAD');
  const rootBuildInputs = e02RootBuildInputs(read('package.json'));
  const seedRoot = 'ald-e02-observed-v1-prospective-qualification';
  const bindings = {
    protocolCard: { source: cardPath, sourceSha256: sha256(readFileSync(cardPath)), card },
    runConfigurations: [{ protocolBaseCommit, experimentId: 'E02', deploymentMode: 'research-grade',
      learnerTrack: 'scratch-rl', modelRef: 'tabular-reinforce-v1', learningSignal: 'extrinsic-task',
      topologySlots: 5, turnResponseBudgetMs: 1000, rowsPerRolePerStage: E02_REGISTERED_ROWS_PER_STAGE,
      maxTrainingTurns: 2 * E02_REGISTERED_ROWS_PER_STAGE + 1, evaluationTurns: 1,
      totalTurnsPerSlot: 2 * E02_REGISTERED_ROWS_PER_STAGE + 2, checkpointEventInterval: 1024,
      snapshotAtTurn: E02_REGISTERED_ROWS_PER_STAGE, sealingTurnsExcluded: 2 }],
    practicalMargins: { confidence: 0.95, maximumAccuracyAdvantage: 0.1,
      positiveControlMinimumAdvantage: 0.2, minimumTestRows: 501, requiredPassingProbes: 60,
      allSlotsRequired: true, estimator: '400-epoch linear softmax',
      split: 'seeded stratified 75/25 with per-class floor; independent by slot/role/stage/probe',
      baseline: 'untouched-test majority accuracy', permutations: 20, permutationRole: 'diagnostic only',
      amendment: 'Prospectively supersedes the 800-turn provisional allocation; fixes rounding and improves conditional all-60 assurance without changing margins or feature membership.' },
    analysisVersions: sourcePaths.map((path) => ({ path, sha256: sha256(readFileSync(path)) })),
    modelAssets: { learner: 'two independently initialized tabular-reinforce-v1 learners',
      contractPath: 'contracts/learner-contract.scratch-rl.v1.md',
      contractSha256: sha256(readFileSync('contracts/learner-contract.scratch-rl.v1.md')),
      encoder: 'asset-free numeric generator; no encoder', tokenizer: 'no tokenizer',
      pretrainedWeights: 'no pretrained weights', actualProvenance: 'signed learner-initialization event per slot' },
    selectedSeedPrefix: { root: seedRoot, stage: 'software-qualification', reserves: 'none',
      primary: Array.from({ length: 5 }, (_, index) => ({ slot: index + 1, scenario: sha256(`${seedRoot}\0${index + 1}`) })) },
    executionHost: { topology: 'two separate internal learner networks and one Nursery on both',
      nodeImage: 'node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf',
      pnpm: '12.3.4', maximumParallelSlots: 1, externalSpend: 0, rootBuildInputs,
      rustAuditorSha256: sha256(readFileSync('.artifacts/cargo-target/release/ald-integrity-auditor')),
      resourceEnvelope: resource, resourceEnvelopeSha256: sha256(readFileSync(resourcePath)) },
    scenarioBundle: { generator: 'ReferentialScenarioEngine', generatorVersion: 1, attributeCount: 2,
      valuesPerAttribute: 4, candidatesPerEpisode: 4, heldOutTypeCodeCount: 0,
      symbols: 'S01 through S32', interactionMode: 'cooperative-signaling', offlineLabelMapping: E02_LABELS,
      labelSource: 'target type first attribute; never supplied to learner',
      featureSets: E02_PROBES, featureVersion: E02_REGISTERED_ANALYSIS_VERSION,
      timingScope: 'Nursery observe round trip, not learner-side clock trace',
      imageAssets: 0, ocrApplicability: 'No image surface in this baseline; retained offline OCR development diagnostics do not qualify future images.',
      restoreScope: 'Close/reopen real runtime and database with original in-memory signers, restore policies/cursor/prefix; not independent operator or OS restart' },
    exclusionRules: ['exact first 2016 and next 2016 training turns; exclude only final two sealing turns',
      'retain every required role/stage/probe, including failures', 'no development observation may enter registered evidence',
      'missing row, failed delivery, mismatched scenario or provenance, underpowered split or verifier failure invalidates the slot'],
    stoppingRules: { plannedSlots: 5, outcomeDependent: false, allSlotsUnlessInfrastructureFailure: true,
      noSameSeedRerun: true, maximumWallHoursPerSlot: 10, maximumCpuHoursPerContainerProcess: 1,
      wallTimeoutScope: 'Nursery command; independent post-run audit is outside that wall timeout and inside the host controller CPU budget',
      maximumHostControllerCpuHours: 5, maximumPlannedEvidenceGiB: 3,
      failurePolicy: 'Statistical failures do not select replacement seeds; infrastructure failure stops with all partial evidence retained.' },
    evidenceAndAnchorPolicy: { anchorClass: 'simulated', publicChainTransaction: false, externalSpend: 0,
      requiredPreRunConfirmations: 3, postRunConfirmations: 1, privateSigningMaterialExported: false,
      inputsAndResults: 'checkpoint-bound signed attachments', independentBounds: 'R qnorm and direct Wilson formula',
      independentVerifier: 'release Rust auditor plus TypeScript verifier',
      modelReplayBoundary: 'same estimator implementation; no independent human review claim',
      evidenceRoot: 'evidence/qualification/e02-v1', receiptPath: 'reports/research/e02-qualification-receipt.json' },
  };
  const compiled = compileRegistrationPacket({ experimentId: 'E02', registrationClass: 'qualification', bindings });
  writeNew(packetPath, { artifact: compiled.artifact, preRegistrationHash: compiled.preRegistrationHash,
    protocolBaseCommit, researchFinding: false, claimBoundary: compiled.claimBoundary });
} else {
  const packet = read(packetPath);
  const commit = git('log', '-1', '--format=%H', '--', packetPath);
  git('merge-base', '--is-ancestor', commit, 'HEAD');
  assert.equal(git('show', `${commit}:${packetPath}`), readFileSync(packetPath, 'utf8').trim());
  const chain = new FakeChainTransport({ endpointLabel: 'e02-registration-simulation' });
  const tx = await chain.sendAnchorTransaction({ checkpointHash: packet.preRegistrationHash, to: `0x${'42'.repeat(20)}` });
  chain.mineBlock(3);
  const receipt = await chain.getTransactionReceipt(tx.transactionHash);
  assert.equal(receipt.status, 'success');
  const binding = PreRegistrationBindingSchema.parse({ registrationClass: 'qualification', registrationAuthority: 'repository-native',
    preRegistrationHash: packet.preRegistrationHash, repositoryRegistration: { commit, path: packetPath,
      artifactSha256: packet.preRegistrationHash, committedAt: git('show', '-s', '--format=%cI', commit) },
    preRunAnchor: { anchorClass: 'simulated', network: chain.network, chainId: chain.chainId,
      transactionHash: tx.transactionHash, inputData: tx.inputData, blockNumber: receipt.blockNumber, status: 'confirmed' },
    label: 'E02 numeric observation software qualification; simulation is not independent public timestamping' });
  for (const expected of packet.artifact.bindings.find((entry) => entry.key === 'selectedSeedPrefix').content.primary) {
    validateE02SlotContract(packet, binding, expected.slot, expected.scenario);
  }
  if (mode === '--activate') {
    assert.equal(git('status', '--porcelain'), '', 'activate a committed packet');
    writeNew(bindingPath, binding);
  } else assert.deepEqual(read(bindingPath), binding);
}
console.log(`E02 registration ${mode.slice(2)} complete`);
