import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('../run-lv01-malformed-proposal-development.mjs', import.meta.url));

describe('LV01 malformed-proposal fixture runner', () => {
  it('requires a prospective single-use packet before it configures the fixture', () => {
    const result = spawnSync(process.execPath, [runner, '--check', '999'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing protocols/lv01-malformed-proposal-development.v999.json');
  });

  it('binds the selected controller stage to a Gateway rejection with teardown', () => {
    const runnerSource = readFileSync(runner, 'utf8');
    const controllerSource = readFileSync(`${root}deploy/mode-r/application-controller.mjs`, 'utf8');
    expect(runnerSource).toContain("ALD_MODE_R_CONTROLLER_STAGE: 'lv01-malformed-proposal'");
    expect(runnerSource).toContain("'down', '--remove-orphans'");
    expect(runnerSource).toContain('single-use malformed-proposal evidence');
    expect(controllerSource).toContain("'lv01-malformed-proposal'");
    expect(controllerSource).toContain('trusted-metadata-present');
    expect(controllerSource).toContain('senderChannelBoundIntentions');
    expect(controllerSource).toContain('injectLv01MalformedProposal');
  });
});
