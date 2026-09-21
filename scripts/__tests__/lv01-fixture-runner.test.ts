import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('../../deploy/mode-r/run-lv01-slot.mjs', import.meta.url));

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
  });

  it('requires a prospective allocation before it configures a fixture', () => {
    const result = spawnSync(process.execPath, [runner, '--check', '999'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing protocols/lv01-development-resource-allocation.v999.json');
  });
});
