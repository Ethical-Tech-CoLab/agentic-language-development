import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deriveSeedHex } from '@ald/hashing';
import { RECURRENT_ARCHITECTURE } from '@ald/learners';
import { buildRunConfig, validateRunConfig } from '@ald/lifecycle';

import {
  LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE,
  validateLv01DetectorConfig,
  validateLv01DetectorObservation,
} from '../../deploy/mode-r/lv01-detector-contract.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('../run-lv01-detector-development.mjs', import.meta.url));
const runnerSource = readFileSync(runner, 'utf8');

function detectorConfig() {
  return buildRunConfig({
    runId: 'lv01-detector-development-v1-p0001',
    experimentId: 'LV01',
    randomSeed: deriveSeedHex('ald-lv01-detector-test', 'scenario'),
    deploymentMode: 'research-grade',
    babyA: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE },
    babyB: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE },
    maxTurnsPerRun: LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE,
    evaluationTurns: 0,
    turnResponseBudgetMs: 1_000,
    ledgerValuePlan: {
      version: 1,
      designCommitmentHash: `sha256:${'a'.repeat(64)}`,
      analysisCommitmentHash: `sha256:${'b'.repeat(64)}`,
      seedResourceCommitmentHash: `sha256:${'c'.repeat(64)}`,
      predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
      partitionContractVersion: 'lv01-within-support/v1',
    },
  });
}

describe('LV01 detector outer collector', () => {
  it('requires a prospective single-use packet before it configures collection', () => {
    const result = spawnSync(process.execPath, [runner, '--check', '999'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing protocols/lv01-detector-development.v999.json');
  });

  it('drives the detector-observation controller stage with its own Compose path', () => {
    expect(runnerSource).toContain("ALD_MODE_R_CONTROLLER_STAGE: 'lv01-detector-observation'");
    expect(runnerSource).toContain('docker-compose.application.v1.yml');
    expect(runnerSource).toContain('docker-compose.lv01.v1.yml');
    expect(runnerSource).toContain('docker-compose.lv01-isolated-networks.v1.yml');
    expect(runnerSource).toContain("'down', '--remove-orphans'");
    expect(runnerSource).not.toContain('run-lv01-slot.mjs');
    const controllerSource = readFileSync(`${root}deploy/mode-r/application-controller.mjs`, 'utf8');
    expect(controllerSource).toContain("'lv01-detector-observation'");
  });

  it('binds the source-bound 2016-turn zero-evaluation workload', () => {
    expect(LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE).toBe(2_016);
    expect(runnerSource).toContain('LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE');
    expect(runnerSource).toContain('validateLv01DetectorConfig(runConfig)');
    expect(runnerSource).toContain('evaluationTurns: 0');
    expect(runnerSource).toContain("modelRef: RECURRENT_ARCHITECTURE");
    expect(runnerSource).toContain('sealedTurns, LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE');
    expect(runnerSource).toContain('evaluationTurns, 0');
    // Zero evaluation turns must not reach probe scheduling, which requires a
    // positive evaluation range: the config carries training-only interventions.
    expect(runnerSource).toContain('heldOutTypeCodes');
    expect(runnerSource).not.toContain('evaluationSuite');
  });

  it('verifies captured rows equal twice the sealed turn count', () => {
    expect(runnerSource).toContain("observation.state, 'sealed'");
    expect(runnerSource).toContain('observation.captured.length, observation.turnCount * 2');
    expect(runnerSource).toContain('validateLv01DetectorObservation(observation)');
    expect(runnerSource).toContain("output', 'lv01-detector-observations.json'");
  });

  it('retains controller/Gateway/model replacement evidence', () => {
    expect(runnerSource).toContain('REPLACEMENT_SERVICES');
    expect(runnerSource).toContain("'controller-scenario', 'gateway'");
    expect(runnerSource).toContain("'model-adapter-a', 'model-adapter-b'");
    expect(runnerSource).toContain('replacementEvidence');
    expect(runnerSource).toContain('stageProcessIds');
    expect(runnerSource).toContain('imageDigest');
  });

  it('writes a development receipt on success or failure', () => {
    expect(runnerSource).toContain("classification, 'lv01-detector-development'");
    expect(runnerSource).toContain('receipt.json');
    expect(runnerSource).toContain('failure');
    expect(runnerSource).toContain('scientificDisposition');
    expect(runnerSource).toContain('single-use detector evidence');
    expect(runnerSource).toContain('clean committed source tree');
  });
});

describe('LV01 detector 2016/0 config contract', () => {
  it('builds a run config that passes both the runtime schema and the detector contract', () => {
    const config = detectorConfig();
    expect(config.maxTurnsPerRun).toBe(2_016);
    expect(config.evaluationTurns).toBe(0);
    expect(() => validateLv01DetectorConfig(config)).not.toThrow();
  });

  it('accepts the sealed two-role capture shape for the full workload', () => {
    const observation = {
      classification: 'lv01-selected-detector-observation-stage',
      researchFinding: false,
      learnerArchitecture: RECURRENT_ARCHITECTURE,
      state: 'sealed',
      turnCount: LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE,
      captured: Array.from(
        { length: LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE * 2 },
        () => ({ delivered: true }),
      ),
    };
    expect(observation.captured.length).toBe(observation.turnCount * 2);
    expect(() => validateLv01DetectorObservation(observation)).not.toThrow();
  });

  it('still rejects negative or non-integer evaluation turns', () => {
    for (const evaluationTurns of [-1, 1.5]) {
      const parsed = validateRunConfig({ ...detectorConfig(), evaluationTurns });
      expect(parsed.ok).toBe(false);
    }
    expect(validateRunConfig({ ...detectorConfig(), evaluationTurns: undefined }).ok).toBe(true);
  });
});
