import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import { EvidenceCheckpointService } from '@ald/checkpoint';
import { SqliteEvidenceWriter, exportRunBundle, openEvidenceDatabase } from '@ald/evidence';
import { SymbolGatewayImpl } from '@ald/gateway';
import { hashCanonical, InMemorySignerRegistry } from '@ald/hashing';
import { ContainerHostTransport, RemoteLearnerAdapter, decodeFrameLine, FrameAssembler, LineReader } from '@ald/isolation';
import { loadLearnerContract } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { CLAIM_BOUNDARY_STATEMENTS, GENESIS_HASH, HASH_DOMAINS, fixedTokenInventory } from '@ald/types';
import { verifyBundle } from '@ald/verifier';

import { E01_ATTEMPT_DOMAIN, E01_STORAGE_PATHS, E01_TRANSPORT_SAMPLES, e01GatewayCorpus, evaluateE01Attempts, runE01DetectorControls } from './e01-corpus.mjs';

const [slotText, seed, outputRoot, softwareCommit, registrationFile] = process.argv.slice(2);
const slot = Number(slotText);
assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 5);
assert.match(seed, /^[a-f0-9]{64}$/u);
assert.match(softwareCommit, /^[a-f0-9]{40}$/u);
assert.equal(outputRoot, '/evidence');
const development = registrationFile === 'development';
const binding = development ? undefined : JSON.parse(await readFile(registrationFile, 'utf8'));
const runId = `${development ? 'development' : 'registered'}-e01-v2-${slot}`;
const runRoot = join(outputRoot, runId);
await mkdir(runRoot); // Deliberately refuses to overwrite any earlier attempt.
const clock = { now: () => new Date().toISOString() };
const signers = InMemorySignerRegistry.generate(runId);
const witness = signers.signer('witness');
const database = openEvidenceDatabase(join(runRoot, 'evidence.sqlite'));
const writer = new SqliteEvidenceWriter({ database, signers, clock, softwareCommit });
const contract = loadLearnerContract('no-learning');
const config = buildRunConfig({
  runId, experimentId: 'E01', randomSeed: seed, deploymentMode: 'research-grade',
  babyA: { track: 'no-learning' }, babyB: { track: 'no-learning' }, learningSignal: 'none',
  maxSymbolsPerMessage: 4, maxConsecutiveRejections: 3, turnResponseBudgetMs: 1000,
  protocolGitCommit: softwareCommit, preRegistrationHash: binding?.preRegistrationHash ?? GENESIS_HASH,
  promptBundleHash: hashCanonical(HASH_DOMAINS.promptBundle, { 'no-learning': contract.text }),
});
const { configurationHash } = writer.registerRun(config);
const checkpoints = new EvidenceCheckpointService({ evidence: writer, signers, clock, softwareCommit });
const gateway = new SymbolGatewayImpl({ runId, config, seed, symbolInventory: fixedTokenInventory(32) }, writer);
const records = [];
const adapters = [];
let failure = null;
let topology = null;

async function record(observation) {
  const unsigned = { ...observation, runId, slot, scenarioSeed: seed, recordedAt: clock.now(), writerKeyId: witness.keyId };
  const entryHash = hashCanonical(E01_ATTEMPT_DOMAIN, unsigned);
  const signed = { ...unsigned, entryHash, writerSignature: await witness.sign(entryHash) };
  await writer.appendAnalysisAttachment({
    runId, path: `analysis/red-team-observation/${observation.id}.json`, kind: 'red-team-observation',
    analysisVersion: 'e01-explicit-v2', value: signed, actorId: 'nursery:e01', reasonCode: 'measured-isolation-attempt',
  });
  records.push(signed);
}

async function connect(role) {
  const transport = new ContainerHostTransport({ host: role, port: 4318, attempts: 40, retryDelayMs: 250, timeoutMs: 500, hostLabel: role });
  const observed = { frames: [], responses: [], errors: [] };
  const assembler = new FrameAssembler();
  const lines = new LineReader(8192, (line) => {
    observed.frames.push(line);
    try {
      const message = assembler.push(decodeFrameLine(line, 8192));
      if (message?.kind === 'res') observed.responses.push(message.payload);
    } catch (error) { observed.errors.push(error.message); }
  }, (error) => observed.errors.push(error.message));
  const monitoredTransport = {
    boundary: transport.boundary, hostLabel: role, current: () => undefined,
    terminate: () => transport.terminate(),
    open: async () => {
      const channel = await transport.open();
      return {
        kind: channel.kind, write: (lines) => channel.write(lines), close: () => channel.close(),
        closeCode: () => channel.closeCode?.(), onClose: (handler) => channel.onClose(handler),
        onLine: (handler) => channel.onLine((chunk) => {
          lines.push(chunk);
          handler(chunk);
        }),
      };
    },
  };
  const adapter = new RemoteLearnerAdapter({ track: 'no-learning', transport: monitoredTransport, timing: 'normalized', deadlineMs: 1000 });
  adapters.push(adapter);
  const ledger = { turn: 0, append: (draft, options) => writer.appendLedgerEvent({ runId,
    babyId: role === 'baby-a' ? 'A' : 'B', turn: ledger.turn, draft, ...options }) };
  await adapter.init({ runId, role, babyId: role === 'baby-a' ? 'A' : 'B', config,
    learnerContract: contract, seed: `${seed}:${role}`, symbolInventory: fixedTokenInventory(32), ledger });
  return { adapter, observed, ledger };
}

function draft(turn) {
  return { eventType: 'intention.recorded', contentSchema: 'agent-native-ledger', subjectId: 'symbol:S01',
    content: { artifactRef: `proposal:${turn}` }, blindingNonce: `nonce:${turn}`, evidenceRefs: [] };
}

try {
  await checkpoints.createCheckpoint(runId, 'run-initialized');
  await record(await runE01DetectorControls());
  const a = await connect('baby-a');
  const b = await connect('baby-b');
  topology = { containerIds: [a.adapter.isolation.containerId, b.adapter.isolation.containerId], boundary: 'separate-container' };
  assert.ok(topology.containerIds.every(Boolean));
  assert.notEqual(...topology.containerIds);
  let turn = 0;
  async function attack(id, proposal, timeout = false, reset = true) {
    turn += 1;
    if (reset) gateway.resetRejectionCounter();
    const before = writer.readEvents(runId, 'channel').length;
    const result = timeout ? await gateway.rejectForTimeout({ turn, sender: 'baby-a', recipient: 'baby-b' }, 'baby-a')
      : await gateway.submitProposal({ turn, sender: 'baby-a', recipient: 'baby-b' }, { proposal, privateLedgerDraft: draft(turn) });
    const events = writer.readEvents(runId, 'channel').slice(before);
    const delivery = gateway.deliveryFor(turn, 'baby-b');
    await record({ id, inputHash: hashCanonical('dtsf-e01-input-v2', { proposal: proposal ?? null, timeout }),
      rejected: result.kind === 'rejected', delivered: delivery !== undefined,
      recipientObservation: { delivery: delivery ?? null }, channelEventHashes: events.map((e) => e.entryHash),
      pauseRequested: result.kind === 'rejected' && result.pauseRequested,
      passed: result.kind === 'rejected' && delivery === undefined && events.length === 1 });
  }
  for (const { id, proposal } of e01GatewayCorpus()) await attack(`gateway-${id}`, proposal);
  await attack('gateway-silence', undefined, true);
  for (let retry = 1; retry <= 3; retry += 1) {
    await attack(`gateway-retry-${retry}`, { kind: 'emit_symbols', publicArtifact: { symbols: ['S99'] } }, false, retry === 1);
  }
  for (const [role, peer, connected] of [['baby-a', 'baby-b', a], ['baby-b', 'baby-a', b]]) {
    for (const [id, readPath] of E01_STORAGE_PATHS) {
      const probe = await connected.adapter.probeIsolation({ readPath, connect: { host: peer, port: 4318, timeoutMs: 300 } });
      await record({ id: `host-${role}-${id}`, readPath, probe,
        passed: probe.permissionModel && probe.fsRead === 'denied' && probe.clipboard === 'denied' &&
          probe.childProcess === 'denied' && probe.worker === 'denied' && probe.network === 'refused' && probe.envKeys.length === 0 });
    }
  }
  for (let sample = 1; sample <= E01_TRANSPORT_SAMPLES; sample += 1) {
    for (const label of ['accepted', 'rejected']) {
      const frameStart = a.observed.frames.length;
      const responseStart = a.observed.responses.length;
      const started = performance.now();
      let outcome = 'returned';
      if (label === 'accepted') {
        await a.adapter.observe({ runId, turn: 100 + sample, recipient: 'baby-a', encoding: 'opaque-numeric', payload: [[0, 1, 1]], scenarioRef: `scenario:e01:${seed}` });
      } else {
        const variants = [ { symbols: 'invalid' }, { symbols: [17] }, { symbols: [], tool: 'extra' }, { symbols: null } ];
        try {
          await a.adapter.receive({ runId, turn: 100 + sample, logicalSender: 'baby-b', carrier: 'fixed-token',
            publicArtifact: variants[(sample - 1) % variants.length], channelEventHash: GENESIS_HASH });
        } catch (error) { outcome = error.code; }
      }
      const durationMs = performance.now() - started;
      const frames = a.observed.frames.slice(frameStart);
      const responses = a.observed.responses.slice(responseStart);
      await record({ id: `transport-${label}-${sample}`, label, durationMs,
        sizeBytes: frames.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0),
        frames, frameHashes: frames.map((line) => hashCanonical('dtsf-e01-frame-v2', line)), responses,
        outcome, passed: label === 'accepted' ? outcome === 'returned' : outcome === 'host-error' });
    }
  }
  assert.deepEqual(a.observed.errors, []);
  assert.deepEqual(b.observed.errors, []);
  gateway.resetRejectionCounter();
  turn += 1;
  const accepted = await gateway.submitProposal({ turn, sender: 'baby-a', recipient: 'baby-b' },
    { proposal: { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } }, privateLedgerDraft: draft(turn) });
  const delivery = accepted.kind === 'accepted' ? accepted.delivery : undefined;
  let receiverResponded = false;
  let interpretationEventHash = null;
  if (delivery) {
    b.ledger.turn = turn;
    const interpretation = await b.adapter.receive(delivery);
    receiverResponded = interpretation.channelEventHash === delivery.channelEventHash;
    if (receiverResponded) interpretationEventHash = (await gateway.submitInterpretation(
      { turn, sender: 'baby-a', recipient: 'baby-b' }, 'baby-b', interpretation)).entryHash;
  }
  await record({ id: 'gateway-allowed-control', delivered: delivery !== undefined, receiverResponded,
    channelEventHash: delivery?.channelEventHash ?? null, interpretationEventHash,
    passed: accepted.kind === 'accepted' && receiverResponded });
} catch (error) { failure = `${error.name}: ${error.message}`; }

await writeFile(join(runRoot, 'attempt-status.json'), `${JSON.stringify({ failure, recordedAttempts: records.length })}\n`);
try {
  const decision = evaluateE01Attempts(records, witness.publicKey);
  if (failure !== null) decision.passed = false;
  const checkpoint = await checkpoints.createCheckpoint(runId, 'run-sealed');
  const chain = new FakeChainTransport({ endpointLabel: 'e01-v2-local-simulation' });
  const publisher = new BaseAnchorPublisher({ transport: chain, anchorClass: 'simulated', clock,
    evidence: { listRuns: () => [runId], insertAnchorReceipt: (r) => writer.insertAnchorReceipt(r),
      readCheckpoints: (id) => writer.readCheckpoints(id), readAnchorReceipts: (id) => writer.readAnchorReceipts(id) },
    anchorAddress: `0x${'42'.repeat(20)}`, finalityPolicy: '1-confirmation',
    retry: { attempts: 2, initialBackoffMs: 0, maxBackoffMs: 0, sleep: async () => chain.mineBlock() },
    confirmationPoll: { attempts: 2, intervalMs: 0 },
  });
  const anchor = await publisher.anchorAndConfirm(checkpoint);
  writer.appendExperimentRecord({ version: 1, recordVersion: 1, runId, experimentId: 'E01', deploymentMode: 'research-grade',
    learnerContractVersion: '1', runConfigRef: configurationHash, protocolGitCommit: softwareCommit,
    preRegistrationHash: config.preRegistrationHash, checkpointManifestRef: checkpoint.checkpointHash,
    anchorTxRef: anchor.transactionHash, verifierReportRef: 'verification-report.json',
    disposition: decision.passed ? 'valid' : 'invalid', claimBoundaryStatement: CLAIM_BOUNDARY_STATEMENTS['research-grade'], deviations: [],
    analysisAttachmentRefs: writer.readAnalysisAttachments(runId).map((a) => a.descriptor.sha256) });
  const bundleDir = join(runRoot, 'bundle');
  await exportRunBundle(writer, runId, bundleDir, { softwareCommit, learnerContracts: [{ track: 'no-learning', version: '1', text: contract.text }],
    ...(binding ? { preRegistration: binding } : {}) });
  await checkpoints.writeProofFiles(runId, bundleDir, { maxInclusionPerTree: 512 });
  const verification = await verifyBundle(bundleDir, { verifierVersion: 'e01-v2', now: clock.now, writeReport: true });
  const result = { schemaVersion: 2, classification: development ? 'development-only' : 'prospectively-registered-software-qualification',
    researchFinding: false, slot, scenarioSeed: seed, runId, softwareCommit, topology, witnessPublicKey: witness.publicKey,
    registrationHash: config.preRegistrationHash, records, decision, failure, verificationExitCode: verification.exitCode,
    checkpointHash: checkpoint.checkpointHash, anchor, passed: decision.passed && verification.exitCode === 0 };
  await writeFile(join(runRoot, 'slot.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ runId, slot, passed: result.passed, decision, failure, verificationExitCode: verification.exitCode })}\n`);
  if (!result.passed) process.exitCode = 1;
} finally {
  await Promise.all(adapters.map((a) => a.dispose()));
  database.close();
}
