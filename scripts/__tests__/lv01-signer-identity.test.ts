import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('LV01 development signer identity', () => {
  it('admits only the versioned development run-id form alongside existing modes', () => {
    const signer = readFileSync(`${root}deploy/mode-r/domain-signer-host.mjs`, 'utf8');
    expect(signer).toContain('lv01-(?:development|recurrent-lifecycle|late-callback)-v\\d+-p\\d{4}');
  });
});
