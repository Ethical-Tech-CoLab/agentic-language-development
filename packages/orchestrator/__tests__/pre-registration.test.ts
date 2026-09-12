import { afterEach, describe, expect, it } from 'vitest';

import type { PreRegistrationBinding, Sha256Hash } from '@ald/types';

import {
  bundleDir,
  createHarness,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

describe('confirmatory pre-registration binding (ALD-071)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('refuses incomplete bindings and exports the exact confirmed receipt', async () => {
    harness = await createHarness();
    const config = testConfig(
      noLearningOverrides({
        runId: 'confirmatory-binding',
        experimentId: 'E03',
        randomSeed: 'confirmatory-binding-seed',
        registrationClass: 'confirmatory',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
      }),
    );
    const inputData = `0x${config.preRegistrationHash.replace(/^sha256:/u, '')}`;
    const binding: PreRegistrationBinding = {
      registrationClass: 'confirmatory',
      preRegistrationHash: config.preRegistrationHash as Sha256Hash,
      externalRegistrationUrl: 'https://osf.io/ald03',
      externalRegistrationId: 'osf:ald03-v1',
      registeredAt: '2026-09-01T00:00:00.000Z',
      preRunAnchor: {
        anchorClass: 'simulated',
        network: 'base-sepolia',
        chainId: 84532,
        transactionHash: `0x${'2'.repeat(64)}`,
        inputData,
        blockNumber: 31_337,
        status: 'confirmed',
      },
      label: 'confirmatory: externally registered before run start',
    };

    await expect(harness.runtime.createRun(config)).rejects.toThrow(
      /require a bound external pre-registration/u,
    );
    await expect(
      harness.runtime.createRun(config, {
        preRegistration: { ...binding, externalRegistrationUrl: undefined },
      }),
    ).rejects.toThrow(/external registration URL/u);
    await expect(
      harness.runtime.createRun(config, {
        preRegistration: {
          ...binding,
          preRunAnchor: { ...binding.preRunAnchor, inputData: `0x${'3'.repeat(64)}` },
        },
      }),
    ).rejects.toThrow(/matching pre-run anchor receipt/u);

    await harness.runtime.createRun(config, { preRegistration: binding });
    const manifest = await harness.runtime.exportBundle(
      config.runId,
      bundleDir(harness, config.runId),
    );
    expect(manifest).toMatchObject({
      experimentId: 'E03',
      protocolGitCommit: 'git:test-protocol',
      preRegistrationHash: config.preRegistrationHash,
      preRegistration: binding,
    });
  });
});
