import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, hashCanonical } from '@ald/hashing';
import { verifyBundle } from '@ald/verifier';
import { e01AttemptIds, e01GatewayCorpus, evaluateE01Attempts } from './e01-corpus.mjs';

/** Validate original captures against their signed bundle, not receipt flags. */
export async function auditE01Slot(directory) {
  const read = (path) => JSON.parse(readFileSync(join(directory, path), 'utf8'));
  const slot = read('slot.json');
  const manifest = read('bundle/run-manifest.json');
  const config = read('bundle/configuration/run-config.json');
  const witness = manifest.signers.find((s) => s.domain === 'witness');
  assert.equal(slot.witnessPublicKey, witness.publicKey);
  assert.equal(slot.runId, manifest.runId);
  assert.equal(slot.softwareCommit, manifest.softwareCommit);
  assert.equal(slot.scenarioSeed, config.randomSeed);
  assert.equal(slot.registrationHash, config.preRegistrationHash);
  assert.equal(slot.schemaVersion, 2);
  assert.equal(slot.researchFinding, false);
  assert.equal(slot.topology.boundary, 'separate-container');
  assert.equal(slot.topology.containerIds.length, 2);
  assert.ok(slot.topology.containerIds.every((id) => typeof id === 'string' && id.length > 0));
  assert.notEqual(...slot.topology.containerIds);
  const records = e01AttemptIds().map((id) => read(`bundle/analysis/red-team-observation/${id}.json`));
  assert.equal(canonicalJson(records), canonicalJson(slot.records));
  const attachments = read('bundle/analysis/index.json').attachments;
  assert.equal(attachments.length, records.length);
  const interventions = readFileSync(join(directory, 'bundle/intervention-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const checkpoint = read('bundle/checkpoints/000001.json');
  assert.equal(checkpoint.checkpointHash, slot.checkpointHash);
  assert.equal(checkpoint.reason, 'run-sealed');
  assert.equal(slot.anchor.checkpointHash, slot.checkpointHash);
  assert.equal(slot.anchor.anchorClass, 'simulated');
  assert.equal(slot.anchor.status, 'confirmed');
  const channels = readFileSync(join(directory, 'bundle/channel-transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(channels.length, 21);
  const rejectedHashes = [];
  for (const record of records) {
    assert.equal(record.runId, slot.runId);
    assert.equal(record.scenarioSeed, slot.scenarioSeed);
    assert.equal(record.slot, slot.slot);
    assert.equal(record.writerKeyId, witness.keyId);
    const descriptor = attachments.find((a) => a.path === `analysis/red-team-observation/${record.id}.json`);
    assert.equal(descriptor.boundBy.stream, 'intervention');
    const event = interventions.find((e) => e.entryHash === descriptor.boundBy.entryHash);
    const proof = read(`bundle/proofs/inclusion/intervention-${event.sequence}-at-1.json`);
    assert.equal(proof.entryHash, event.entryHash);
    assert.equal(proof.checkpointSequence, checkpoint.checkpointSequence);
    assert.equal(proof.root, checkpoint.auxiliaryTrees.intervention.merkleRoot);
    if (record.id.startsWith('gateway-') && record.id !== 'gateway-allowed-control') {
      const event = channels.find((e) => e.entryHash === record.channelEventHashes[0]);
      assert.equal(event.gatewayValidationResult, 'rejected');
      assert.equal(event.deliveryReceipt, undefined);
      rejectedHashes.push(event.entryHash);
      const timeout = record.id === 'gateway-silence';
      const proposal = timeout ? null : record.id.startsWith('gateway-retry-')
        ? { kind: 'emit_symbols', publicArtifact: { symbols: ['S99'] } }
        : e01GatewayCorpus().find((c) => `gateway-${c.id}` === record.id).proposal;
      assert.equal(record.inputHash, hashCanonical('dtsf-e01-input-v2', { proposal, timeout }));
    }
  }
  assert.equal(new Set(rejectedHashes).size, 20);
  const control = records.at(-1);
  assert.equal(channels.at(-1).entryHash, control.channelEventHash);
  assert.equal(channels.at(-1).gatewayValidationResult, 'accepted');
  const ledger = readFileSync(join(directory, 'bundle/baby-b-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const interpretation = ledger.find((e) => e.entryHash === control.interpretationEventHash);
  assert.equal(interpretation.eventType, 'interpretation.recorded');
  assert.equal(interpretation.channelEventHash, control.channelEventHash);
  const decision = evaluateE01Attempts(records, witness.publicKey);
  assert.deepEqual(slot.decision, decision);
  const verification = await verifyBundle(join(directory, 'bundle'), { verifierVersion: 'e01-v2-replay',
    now: () => new Date().toISOString(), writeReport: false });
  assert.equal(slot.verificationExitCode, verification.exitCode);
  assert.equal(slot.passed, decision.passed && verification.exitCode === 0 && slot.failure === null);
  return { passed: slot.passed, decision, verification, slot };
}
