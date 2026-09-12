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
      signerSeedsFile: undefined,
      logLevel: 'info',
      anchorClass: 'simulated',
      baseNetwork: 'base-sepolia',
      baseRpcUrlFile: undefined,
      anchorKeyFile: undefined,
    });
  });

  it('fails fast when research-grade Fort signer material is not configured', () => {
    expect(() =>
      loadRuntimeEnvironment({
        ALD_DEPLOYMENT_MODE: 'research-grade',
      }),
    ).toThrow(
      'ALD_RUN_SIGNER_SEEDS_JSON_FILE is required in research-grade mode',
    );
  });

  it('accepts only Fort file paths for secret-bearing values', () => {
    expect(
      loadRuntimeEnvironment({
        ALD_DEPLOYMENT_MODE: 'research-grade',
        ALD_RUN_SIGNER_SEEDS_JSON_FILE: '/run/secrets/signers',
        ALD_BASE_RPC_URL_FILE: '/run/secrets/rpc-url',
        ALD_ANCHOR_KEY_FILE: '/run/secrets/anchor-key',
      }),
    ).toMatchObject({
      signerSeedsFile: '/run/secrets/signers',
      baseRpcUrlFile: '/run/secrets/rpc-url',
      anchorKeyFile: '/run/secrets/anchor-key',
    });

    expect(() =>
      loadRuntimeEnvironment({ ALD_RUN_SIGNER_SEEDS_JSON: 'secret' }),
    ).toThrow(/direct secret value/u);
  });

  it('rejects invalid integer values', () => {
    expect(() => loadRuntimeEnvironment({ DTSF_PORT: 'not-a-port' })).toThrow(
      'DTSF_PORT must be a positive integer',
    );
  });
});
