import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('../../deploy/mode-r/run-lv01-slot.mjs', import.meta.url));

describe('LV01 selected-topology fixture runner', () => {
  it('refuses a retained fixture attempt instead of reusing its identity', () => {
    const result = spawnSync(process.execPath, [runner, '--check', '3'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('configured but unexecuted');
  });
});
