import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../lv01.mjs', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

describe('LV01 execution CLI', () => {
  it('reports the evidenced not-ready state without writing a receipt', () => {
    const result = run('status', '--live-evidence');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"executionReadiness": "blocked"');
    expect(result.stdout).toContain('"scientificDisposition": "not-tested"');
  });

  it('rejects a pilot collection that has no prospective packet', () => {
    const result = run('collect', '--stage', 'pilot', '--version', '1', '--run');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing passed topology qualification');
  });

  it('rejects unknown options and immutable receipt rewrites', () => {
    expect(run('check-design', '--write').status).not.toBe(0);
    const result = run('qualify-numerics', '--write');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('immutable');
  });
});
