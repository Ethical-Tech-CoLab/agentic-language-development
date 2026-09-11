import { describe, expect, it } from 'vitest';

import { ScriptedModelClient } from '../src/llm-scripted-client.js';
import type { LocalModelClient } from '../src/llm-client.js';
import type { LlamaServerAttestation } from '../src/llama-server-probe.js';
import {
  FROZEN_MODEL_QUALIFICATION_LABEL,
  runFrozenModelQualification,
  type FrozenModelQualificationOptions,
} from '../src/frozen-qualification.js';

const HASH = `sha256:${'2'.repeat(64)}` as const;
const RESPONSE_HASH = `sha256:${'4'.repeat(64)}` as const;

function client(): LocalModelClient {
  const scripted = new ScriptedModelClient();
  return {
    describe: () => ({
      modelId: 'real-provenance-double',
      weightsHash: HASH,
      weightsHashSource: 'weights-file',
      quantization: 'Q4_K_M',
      contextLength: 4_096,
      toolCallingMode: 'json-schema-grammar',
    }),
    complete: (request) => scripted.complete(request),
  };
}

function server(endpoint: string): LlamaServerAttestation {
  return {
    endpoint,
    health: 'ok',
    buildInfo: 'b10809-5266f24da',
    modelAlias: 'real-provenance-double',
    modelFileType: 'Q4_K - Medium',
    modelParameterCount: 4_022_468_096,
    modelSizeBytes: 2_491_323_904,
    configuredContextLength: 4_096,
    trainingContextLength: 40_960,
    totalSlots: 1,
    slotContextLengths: [4_096],
    chatTemplateSha256: `sha256:${'5'.repeat(64)}`,
    supportsTools: true,
    modalities: { vision: false, video: false, audio: false },
  };
}

function options(): FrozenModelQualificationOptions {
  return {
    clients: { 'baby-a': client(), 'baby-b': client() },
    softwareCommit: '1'.repeat(40),
    executedAt: '2026-09-09T00:00:00.000Z',
    runtime: {
      id: 'llama.cpp-0.4.0-b10809-5266f24da',
      artifactHash: `sha256:${'3'.repeat(64)}`,
      installationManager: 'homebrew',
      formula: 'llama.cpp',
      formulaVersion: '0.4.0',
      bottleSha256: `sha256:${'6'.repeat(64)}`,
    },
    launch: {
      host: '127.0.0.1',
      contextLength: 4_096,
      parallelSlots: 1,
      promptCacheEnabled: false,
      temperature: 0,
      maxOutputTokens: 192,
      turnResponseBudgetMs: 120_000,
      thinkingDisabled: true,
      toolChoice: 'required',
    },
    servers: {
      'baby-a': server('http://127.0.0.1:18091'),
      'baby-b': server('http://127.0.0.1:18092'),
    },
    reset: {
      strategy: 'clean-process-restart',
      roles: {
        'baby-a': {
          beforeResponseHash: RESPONSE_HASH,
          afterResponseHash: RESPONSE_HASH,
          matched: true,
        },
        'baby-b': {
          beforeResponseHash: RESPONSE_HASH,
          afterResponseHash: RESPONSE_HASH,
          matched: true,
        },
      },
    },
    episodes: 2,
  };
}

describe('frozen-model qualification report', () => {
  it('measures both roles, isolation, reset, tool use, and freeze semantics', async () => {
    const report = await runFrozenModelQualification(options());
    expect(report.claimBoundary).toBe(FROZEN_MODEL_QUALIFICATION_LABEL);
    expect(report.proposals).toBe(4);
    expect(report.roles['baby-a'].intentions).toBeGreaterThan(0);
    expect(report.roles['baby-a'].interpretations).toBeGreaterThan(0);
    expect(report.roles['baby-b'].intentions).toBeGreaterThan(0);
    expect(report.roles['baby-b'].interpretations).toBeGreaterThan(0);
    expect(report.roles['baby-a'].privateMemoryChanged).toBe(true);
    expect(report.roles['baby-b'].privateMemoryChanged).toBe(true);
    expect(report.toolBoundary).toEqual({
      requiredToolChoice: true,
      liveCalls: 4,
      conformingCalls: 4,
      violations: 0,
    });
    expect(report.freezeSemantics).toMatchObject({
      weightUpdatePath: 'none',
      updatePolicyExposed: false,
      privateMemoryExpectedToChange: true,
    });
    expect(report.isolation.topology).toBe(
      'dedicated-process-per-role-serialized',
    );
    expect(report.model).toMatchObject({
      modelId: 'real-provenance-double',
      weightsHashSource: 'weights-file',
    });

    const json = JSON.stringify(report);
    for (const prohibited of [
      'systemPrompt',
      'observation',
      'privateLedgerDraft',
      'rawOutput',
      'candidateRefs',
      'deliveredSymbols',
    ]) {
      expect(json).not.toContain(prohibited);
    }
  });

  it('requires enough episodes for both roles to send and receive', async () => {
    await expect(
      runFrozenModelQualification({ ...options(), episodes: 1 }),
    ).rejects.toThrow(/at least two episodes/u);
  });

  it('rejects incomplete inference-runtime provenance', async () => {
    const valid = options();
    await expect(
      runFrozenModelQualification({
        ...valid,
        runtime: { ...valid.runtime, artifactHash: 'sha256:not-a-digest' },
      }),
    ).rejects.toThrow(/exact SHA-256/u);
  });

  it('rejects a shared client or endpoint', async () => {
    const valid = options();
    await expect(
      runFrozenModelQualification({
        ...valid,
        clients: {
          'baby-a': valid.clients['baby-a'],
          'baby-b': valid.clients['baby-a'],
        },
      }),
    ).rejects.toThrow(/isolated/u);
  });

  it('rejects a mismatched clean-process replay', async () => {
    const valid = options();
    await expect(
      runFrozenModelQualification({
        ...valid,
        reset: {
          ...valid.reset,
          roles: {
            ...valid.reset.roles,
            'baby-b': {
              beforeResponseHash: RESPONSE_HASH,
              afterResponseHash: `sha256:${'7'.repeat(64)}`,
              matched: true,
            },
          },
        },
      }),
    ).rejects.toThrow(/reset replay did not match/u);
  });
});
