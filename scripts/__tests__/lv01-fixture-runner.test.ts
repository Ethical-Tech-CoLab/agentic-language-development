import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('../../deploy/mode-r/run-lv01-slot.mjs', import.meta.url));

describe('LV01 selected-topology fixture runner', () => {
  it('refuses an allocation whose source closure predates the runner', () => {
    const result = spawnSync(process.execPath, [runner, '--check', '1'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not bind this runner');
  });
});
