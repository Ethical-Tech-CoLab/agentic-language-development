/* eslint-disable @typescript-eslint/no-explicit-any -- malformed JSON fixtures test CLI validation */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryDirectories: string[] = [];
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const paths = {
  packet: 'protocols/e03-pilot-registration.v3.json',
  pilot: 'evidence/pilots/e03-blinded-v3/receipt.json',
  reduction: 'evidence/pilots/e03-blinded-v3/sample-size-input.json',
  power: 'evidence/pilots/e03-blinded-v3/power-selection.json',
  out: 'protocols/e03-sample-size-decision.v1.json',
};

function fixture(mutate: (records: Record<string, any>) => void = () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-selection-'));
  temporaryDirectories.push(directory);
  const write = (path: string, value: unknown) => {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    return readFileSync(target);
  };
  const packet = { artifact: { experimentId: 'E03', parameters: { stage: 'blinded-pilot' } },
    preRegistrationHash: `sha256:${'a'.repeat(64)}` };
  const packetBytes = write(paths.packet, packet);
  const pilot = {
    experimentId: 'E03', stage: 'blinded-pilot', registrationHash: packet.preRegistrationHash,
    packetSha256: sha256(packetBytes), plannedRuns: 120, attemptedRuns: 120,
    completedRuns: 120, validRuns: 120, invalidRuns: 0, abortedRuns: 0,
    passed: true, failure: null, sampleSizeEligible: true, researchFinding: false,
    scientificDisposition: 'not-tested', externalSpend: 0, publicChainTransaction: false,
    slots: Array.from({ length: 120 }, (_, index) => ({ runId: `run-${index}` })),
  };
  const pilotBytes = write(paths.pilot, pilot);
  const reduction = {
    classification: 'outcome-blind-pilot-sample-size-input', experimentId: 'E03',
    pilotSlots: 20, originalSlotsAudited: 120, episodesPerSlot: 200,
    pilotRegistrationHash: packet.preRegistrationHash,
    pilotReceipt: { path: paths.pilot, sha256: sha256(pilotBytes) },
    largestLatentPilotSd: 0.012, selectedPrimarySeeds: 25,
    requiresProspectiveAmendment: false, researchFinding: false,
    scientificDisposition: 'not-tested',
  };
  const reductionBytes = write(paths.reduction, reduction);
  const power = {
    classification: 'outcome-blind-power-simulation', experimentId: 'E03',
    decisionRule: 'e03-bounded-complete-numeric-rule-v1',
    pilotRegistrationHash: packet.preRegistrationHash,
    pilotReceipt: { path: paths.pilot, sha256: sha256(pilotBytes) },
    pilotReduction: { path: paths.reduction, sha256: sha256(reductionBytes) },
    largestLatentPilotSd: 0.012, selectedPrimarySeeds: 25,
    monteCarloRepetitions: 30_000, monteCarloLower95: 0.95,
    numericRule: { lower95: 0.95 }, passed: true,
    invalidAsFailureSensitivity: { forcedFailuresPerCondition: 2,
      successes: 0, lower95: 0, upper95: 0.00013 },
    researchFinding: false, scientificDisposition: 'not-tested',
    externalSpend: 0, publicChainTransaction: false,
  };
  const records = { packet, pilot, reduction, power };
  mutate(records);
  for (const key of ['packet', 'pilot', 'reduction', 'power'] as const) {
    write(paths[key], records[key]);
  }
  return directory;
}

function run(directory: string, audit = false) {
  return spawnSync(process.execPath, [join(root, 'scripts/build-e03-sample-size-decision.mjs'),
    '--pilot-packet', paths.packet, '--pilot-receipt', paths.pilot,
    '--pilot-reduction', paths.reduction, '--power-receipt', paths.power,
    '--out', paths.out, ...(audit ? ['--audit'] : [])],
  { cwd: directory, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe('E03 outcome-blind sample-size decision', () => {
  it('writes once, reproduces exact bytes, and carries the invalid-run sensitivity', () => {
    const directory = fixture();
    const written = run(directory);
    expect(written.status, written.stderr).toBe(0);
    const decision = JSON.parse(readFileSync(join(directory, paths.out), 'utf8'));
    expect(decision.selectedPrimarySeeds).toBe(25);
    expect(decision.invalidAsFailureSensitivity.successes).toBe(0);
    expect(run(directory, true).status).toBe(0);
    expect(run(directory).status).not.toBe(0);
  });

  it('rejects an incomplete original pilot', () => {
    const result = run(fixture(({ pilot }) => { pilot.completedRuns = 119; }));
    expect(result.status).not.toBe(0);
  });

  it('rejects an underpowered nominal rule', () => {
    const result = run(fixture(({ power }) => {
      power.monteCarloLower95 = 0.89;
      power.numericRule.lower95 = 0.89;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nominal complete-rule lower power bound');
  });

  it('rejects malformed invalid-run sensitivity', () => {
    const result = run(fixture(({ power }) => {
      power.invalidAsFailureSensitivity.forcedFailuresPerCondition = 1;
    }));
    expect(result.status).not.toBe(0);
  });

  it('rejects a decision edited after being frozen', () => {
    const directory = fixture();
    expect(run(directory).status).toBe(0);
    const target = join(directory, paths.out);
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n`);
    const result = run(directory, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not reproduce from original input bytes');
  });
});
