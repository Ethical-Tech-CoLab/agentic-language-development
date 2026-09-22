import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('../../deploy/mode-r/run-lv01-slot.mjs', import.meta.url));
const pairedRunner = fileURLToPath(new URL('../../deploy/mode-r/run-lv01-paired-case.mjs', import.meta.url));

describe('LV01 selected-topology fixture runner', () => {
  it('audits the version requested by a development allocation', () => {
    const audit = fileURLToPath(new URL('../check-lv01-development-allocation.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [audit, '--version', '1'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('allocation v1 valid');

    const historicalMismatch = spawnSync(process.execPath, [audit, '--version', '9'], {
      cwd: root, encoding: 'utf8',
    });
    expect(historicalMismatch.status).not.toBe(0);
    expect(historicalMismatch.stderr).toContain('scenario seed derivation');

    const prospective = spawnSync(process.execPath, [audit, '--version', '12'], {
      cwd: root, encoding: 'utf8',
    });
    expect(prospective.status).toBe(0);
    expect(prospective.stdout).toContain('allocation v12 valid');
  });

  it('requires a prospective allocation before it configures a fixture', () => {
    const result = spawnSync(process.execPath, [runner, '--check', '999'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing protocols/lv01-development-resource-allocation.v999.json');
  });

  it('keeps sampler inspection outside the active Compose operation', () => {
    const source = readFileSync(runner, 'utf8');
    expect(source).toContain('label=com.docker.compose.project=${project}');
    expect(source).not.toContain("[...compose, 'ps'");
    expect(source).toContain("'compose-output.log'");
    expect(source).toContain("'lv01-authority-failure.json'");
  });

  it('requires a prospective single-use packet before starting paired branches', () => {
    const result = spawnSync(process.execPath, [pairedRunner, '--check', '999'], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing protocols/lv01-paired-development-allocation.v999.json');
    const source = readFileSync(pairedRunner, 'utf8');
    expect(source).toContain("'lv01-paired-branch'");
    expect(source).toContain('lv01-paired-pre-receiver-action-prediction-committed');
    expect(source).toContain('verifyLv01PairedCase(branches)');
    expect(source).toContain("'down', '--remove-orphans'");
    expect(source).toContain('docker-compose.lv01-isolated-networks.v1.yml');
    expect(source).toContain("'paired-case-failure.json'");
    expect(source).toContain('ALD_MODE_R_PARENT_BUNDLE: `/output/bundles/runs/${parentRunId}`');
    expect(readFileSync(`${root}deploy/mode-r/application-offline-verifier.mjs`, 'utf8'))
      .toContain('parentBundleDir');
  });

  it('does not treat a missing paired receipt as qualified evidence', () => {
    const audit = fileURLToPath(new URL('../check-lv01-paired-case-receipt.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [audit, '--version', '999'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing retained paired-case receipt');
    expect(readFileSync(audit, 'utf8')).toContain('packet.branchOrder');
  });
});
