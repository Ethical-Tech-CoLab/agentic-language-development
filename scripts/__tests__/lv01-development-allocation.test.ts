import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const checker = fileURLToPath(new URL('../check-lv01-development-allocation.mjs', import.meta.url));

describe('LV01 development allocation', () => {
  it('binds only fresh development identities to the tested source closure', () => {
    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no execution or research result');
  });
});
