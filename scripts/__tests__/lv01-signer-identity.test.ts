import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('LV01 development signer identity', () => {
  it('admits only versioned LV01 qualification run identifiers alongside existing modes', () => {
    const signer = readFileSync(`${root}deploy/mode-r/domain-signer-host.mjs`, 'utf8');
    expect(signer).toContain('lv01-paired-development-v\\d+-p\\d{4}-(?:normal|disabled|constant|random|shuffled|ledger-consistent|ledger-shuffled)');
    expect(signer).toContain('(?:commitment-window-fault|malformed-proposal)-v\\d+-p\\d{4}-normal');
    expect(signer).toContain('five-rejection-safety');
    expect(signer).toContain('lv01-application-fault-v\\d+-p\\d{4}-(?:baby-peer-death|anchor-service-death)');
    expect(signer).toContain('five-rejection-safety|detector');
  });

  it('admits detector run identities while rejecting malformed ones', () => {
    const signer = readFileSync(`${root}deploy/mode-r/domain-signer-host.mjs`, 'utf8');
    const anchored = signer.match(/!\/(.*)\/u\.test\(runId/)?.[1];
    expect(anchored).toBeDefined();
    const pattern = new RegExp(anchored as string, 'u');
    expect(pattern.test('lv01-detector-v1-p0001')).toBe(true);
    expect(pattern.test('lv01-detector-v12-p1234')).toBe(true);
    for (const malformed of [
      'lv01-detector-v1-p001',
      'lv01-detector-v1-p00001',
      'lv01-detector-v1-p0001-normal',
      'lv01-detector-p0001',
      'lv01-detector-v1-x0001',
    ]) {
      expect(pattern.test(malformed)).toBe(false);
    }
  });
});
