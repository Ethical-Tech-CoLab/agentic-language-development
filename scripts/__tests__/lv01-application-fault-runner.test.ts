import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('LV01 selected application fault runner', () => {
  it('keeps recurrent faults in a fresh explicitly-networked namespace', () => {
    const runner = readFileSync(`${root}scripts/run-mode-r-application-fault-development.mjs`, 'utf8');
    expect(runner).toContain("mode === '--run-lv01-v1'");
    expect(runner).toContain('protocols/lv01-application-fault-development');
    expect(runner).toContain('docker-compose.lv01-isolated-networks.v1.yml');
    expect(runner).toContain('RECURRENT_ARCHITECTURE');
    expect(runner).toContain('protocol.networkAllocation[fault.id]');
  });
});
