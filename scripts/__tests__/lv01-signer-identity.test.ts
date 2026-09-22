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
  });
});
