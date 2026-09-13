import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Portable summary checks are not a replacement for the retained-evidence audit.
export function validateE01V2Receipt(receipt, packet) {
  const bindings = Object.fromEntries(packet.artifact.bindings.map((entry) => [entry.key, entry.content]));
  const seeds = bindings.selectedSeedPrefix.primary;
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.experimentId, 'E01');
  assert.equal(receipt.classification, 'prospectively-registered-software-qualification');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.registrationHash, packet.preRegistrationHash);
  assert.equal(receipt.executionCommit, '4ba1f27561d2ae20261a2e14a5a91e34fe602d56');
  assert.equal(receipt.externalSpend, 0);
  assert.equal(receipt.publicChainTransaction, false);
  assert.equal(receipt.failure, null);
  assert.equal(receipt.passed, true);
  assert.ok(Number.isFinite(receipt.wallMilliseconds) && receipt.wallMilliseconds > 0);
  assert.equal(receipt.claimBoundary, 'Tested local topology and enumerated corpus only; no behavioral result, public timestamp, independent operator review, or universal side-channel-resistance claim.');
  assert.equal(seeds.length, 5);
  assert.equal(receipt.slots.length, 5);
  const containers = new Set();
  for (const [index, slot] of receipt.slots.entries()) {
    assert.equal(slot.slot, index + 1);
    assert.equal(slot.scenarioSeed, seeds[index].scenario);
    assert.equal(slot.runId, `registered-e01-v2-${index + 1}`);
    assert.equal(slot.passed, true);
    assert.equal(slot.decision.passed, true);
    assert.equal(slot.decision.attempts, 112);
    assert.deepEqual(slot.decision.issues, []);
    assert.ok(Number.isFinite(slot.decision.timingDifferenceMs) && slot.decision.timingDifferenceMs >= 0 && slot.decision.timingDifferenceMs <= 100);
    assert.equal(slot.containerIds.length, 2);
    for (const id of slot.containerIds) {
      assert.equal(typeof id, 'string');
      assert.match(id, /^[a-f0-9]{12,64}$/u);
      assert.equal(containers.has(id), false);
      containers.add(id);
    }
    assert.equal(typeof slot.slotSha256, 'string');
    assert.match(slot.slotSha256, /^[a-f0-9]{64}$/u);
    assert.equal(typeof slot.bundleManifestHash, 'string');
    assert.match(slot.bundleManifestHash, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(slot.rust, {
      schemaVersion: 1, implementation: 'ald-integrity-auditor-rust-v1',
      bundle: `evidence/qualification/e01-v2/${slot.runId}/bundle`,
      integrityPass: true, anchored: true, streamCount: 5, eventCount: 137,
      checkpointCount: 2, attachmentCount: 112, issues: [],
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 2, 'usage: node scripts/check-e01-v2-receipt.mjs');
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const packet = read('protocols/e01-registration.v2.json');
  const receipt = read('reports/research/e01-v2-qualification-receipt.json');
  validateE01V2Receipt(receipt, packet);
  execFileSync(process.execPath, ['scripts/register-e01-v2.mjs', '--check']);
  const binding = read('protocols/e01-registration-binding.v2.json');
  execFileSync('git', ['merge-base', '--is-ancestor', binding.repositoryRegistration.commit, receipt.executionCommit]);
  const sources = packet.artifact.bindings.find((entry) => entry.key === 'analysisVersions').content;
  for (const source of sources) {
    const bytes = execFileSync('git', ['show', `${receipt.executionCommit}:${source.path}`]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  }
  console.log('E01 v2 portable receipt: five slots, 560 signed records, registered execution sources match; raw evidence replay is separate');
}
