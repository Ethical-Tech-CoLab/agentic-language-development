import { describe, expect, it } from 'vitest';

import { loadRuntimeEnvironment } from '../src/index.js';

describe('loadRuntimeEnvironment', () => {
  it('loads behavior-safe prototype defaults', () => {
    expect(loadRuntimeEnvironment({})).toEqual({
      dtsfPort: 8080,
      twinPacksDir: './twins/packs',
      deploymentMode: 'prototype',
      evidenceDir: './evidence',
      databasePath: './evidence/ald.sqlite',
      keyDir: './evidence/keys',
      logLevel: 'info',
      baseNetwork: 'base-sepolia',
      baseRpcUrl: undefined,
      anchorKeyFile: undefined,
    });
  });

  it('fails fast when research-grade key isolation is not configured', () => {
    expect(() =>
      loadRuntimeEnvironment({
        ALD_DEPLOYMENT_MODE: 'research-grade',
      }),
    ).toThrow('ALD_KEY_DIR is required in research-grade mode');
  });

  it('rejects invalid integer values', () => {
    expect(() => loadRuntimeEnvironment({ DTSF_PORT: 'not-a-port' })).toThrow(
      'DTSF_PORT must be a positive integer',
    );
  });
});
