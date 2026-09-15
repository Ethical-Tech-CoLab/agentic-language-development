import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { reduceE03Pilot } from '@ald/analysis';

const mode = process.argv[2];
const attemptVersion = process.argv[3] === '--v2' ? 'v2' : 'v1';
assert.deepEqual(process.argv.slice(2), attemptVersion === 'v2' ? [mode, '--v2'] : [mode]);
assert.ok(['--write', '--audit'].includes(mode),
  'usage: node scripts/reduce-e03-registered-pilot.mjs --write|--audit');

const root = `evidence/pilots/e03-blinded-${attemptVersion}`;
const receiptPath = `${root}/receipt.json`;
const packetPath = `${root}/registration.json`;
const outputPath = `${root}/sample-size-input.json`;
const sha256 = (path) => `sha256:${createHash('sha256')
  .update(readFileSync(path)).digest('hex')}`;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal'];

if (mode === '--write') assert.equal(existsSync(outputPath), false,
  'original pilot reduction is single-use');
else assert.equal(existsSync(outputPath), true,
  'original pilot reduction is absent');

const audit = spawnSync(process.execPath,
  [fileURLToPath(new URL('./run-e03-registered-pilot.mjs', import.meta.url)), '--audit',
    ...(attemptVersion === 'v2' ? ['--v2'] : [])],
  { encoding: 'utf8', timeout: 2 * 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
assert.equal(audit.status, 0, audit.error?.message ?? audit.stderr);
assert.match(audit.stdout, /120-run original blinded-pilot audit passed/u);

const receipt = read(receiptPath);
const packet = read(packetPath);
assert.equal(receipt.passed, true);
assert.equal(receipt.validRuns, 120);
assert.equal(receipt.sampleSizeEligible, true);
assert.equal(receipt.registrationHash, packet.preRegistrationHash);
assert.equal(receipt.packetSha256, sha256(packetPath));
assert.equal(receipt.slots.length, 120);
assert.equal(packet.runs.length, 120);
const registered = new Map(packet.runs.map((run) => [run.config.runId, run]));
assert.equal(registered.size, 120);
const inputs = conditions.map((condition) => ({
  condition,
  tallies: receipt.slots.filter((slot) => slot.condition === condition)
    .sort((left, right) => left.slot - right.slot).map((slot) => {
      const run = registered.get(slot.runId);
      assert.ok(run);
      assert.equal(run.condition, condition);
      assert.equal(run.slot, slot.slot);
      assert.equal(run.config.evaluationTurns, 200);
      assert.ok(Number.isInteger(slot.agreements) &&
        slot.agreements >= 0 && slot.agreements <= 200);
      return { slot: slot.slot, seed: run.config.randomSeed,
        probes: 200, agreements: slot.agreements };
    }),
}));
const reduction = reduceE03Pilot(inputs);
const value = {
  schemaVersion: 1, experimentId: 'E03', stage: 'blinded-pilot',
  ...reduction,
  pilotRegistrationHash: receipt.registrationHash,
  pilotReceipt: { path: receiptPath, sha256: sha256(receiptPath) },
  pilotPacket: { path: packetPath, sha256: sha256(packetPath) },
  originalSlotsAudited: 120,
  originalSlotManifestHashes: receipt.slots.map((slot) => ({
    runId: slot.runId, bundleManifestHash: slot.bundleManifestHash,
  })),
  externalSpend: 0, publicChainTransaction: false,
};
if (mode === '--write') {
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  console.log(`Wrote ${outputPath}; selected seeds=${String(value.selectedPrimarySeeds)}; no behavioral finding`);
  if (value.requiresProspectiveAmendment) process.exitCode = 1;
} else {
  assert.deepEqual(read(outputPath), value,
    'retained pilot reduction differs from recomputed original evidence');
  console.log(`E03 outcome-blind 120-run pilot reduction audit passed; selected seeds=${String(value.selectedPrimarySeeds)}`);
}
