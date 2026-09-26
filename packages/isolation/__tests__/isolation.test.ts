import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RecordingLedgerClient,
  buildConformanceRunConfig,
  loadLearnerContract,
  runLearnerAdapterConformance,
} from '@ald/learners';
import { HASH_DOMAINS, fixedTokenInventory, type LearnerAdapter } from '@ald/types';
import { hashCanonical } from '@ald/hashing';

import {
  FrameAssembler,
  FrameConnection,
  HOST_ERROR_DETAIL_LIMIT,
  MIN_FRAME_SIZE,
  DirectHostTransport,
  IsolationError,
  LearnerHost,
  RemoteLearnerAdapter,
  createBabyProcessAdapterFactory,
  createIsolatedAdapterFactory,
  createLoopbackChannelPair,
  decodeFrameLine,
  encodeFrames,
} from '../src/index.js';

describe('fixed-size canonical framing', () => {
  it('round-trips a chunked payload through equally sized frames', () => {
    const payload = { alpha: 'x'.repeat(2_500), count: 7 };
    const lines = encodeFrames(payload, {
      kind: 'req',
      id: 'r-000000000001',
      frameSize: MIN_FRAME_SIZE,
    });
    const assembler = new FrameAssembler();
    let completed: ReturnType<FrameAssembler['push']>;

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(Buffer.byteLength(line, 'utf8')).toBe(MIN_FRAME_SIZE);
      completed = assembler.push(
        decodeFrameLine(line.slice(0, -1), MIN_FRAME_SIZE),
      );
    }

    expect(completed).toEqual({
      kind: 'req',
      id: 'r-000000000001',
      payload,
    });
  });

  it('rejects live object references instead of silently serializing them', () => {
    expect(() =>
      encodeFrames(
        { sharedState: new Map([['secret', 1]]) },
        { kind: 'req', id: 'r-000000000001' },
      ),
    ).toThrow();
  });

  it('uses the same response envelope size for success and failure', async () => {
    const pair = createLoopbackChannelPair();
    const runtime = new FrameConnection({
      channel: pair.runtime,
      originator: 'r',
    });
    const host = new FrameConnection({
      channel: pair.host,
      originator: 'h',
      handler: async (method) => {
        if (method === 'fail') {
          throw new Error('private adapter detail');
        }
        return { accepted: true };
      },
    });

    await expect(runtime.request('succeed', {})).resolves.toEqual({ accepted: true });
    await expect(runtime.request('fail', {})).rejects.toMatchObject({
      code: 'host-error',
      hostCode: 'internal',
    });

    expect(pair.host.written).toHaveLength(2);
    expect(pair.host.written.map((line) => Buffer.byteLength(line, 'utf8'))).toEqual([
      8192, 8192,
    ]);
    expect(pair.host.written.join('')).not.toContain('private adapter detail');
    runtime.close();
    host.close();
  });

  it('runs a qualification hook only after a request is schema-valid', async () => {
    const pair = createLoopbackChannelPair();
    const observed: string[] = [];
    const runtime = new FrameConnection({ channel: pair.runtime, originator: 'r' });
    const host = new LearnerHost({
      channel: pair.host,
      boundary: 'in-process',
      beforeDispatch: async (method) => { observed.push(method); },
    });

    await expect(runtime.request('describe_isolation', {})).resolves.toMatchObject({
      boundary: 'in-process',
    });
    await expect(runtime.request('describe_isolation', { unexpected: true }))
      .rejects.toMatchObject({ code: 'host-error', hostCode: 'invalid-params' });
    expect(observed).toEqual(['describe_isolation']);

    runtime.close();
    await host.close();
  });
});

describe('separate-process learner host', () => {
  it('runs the ordinary learner contract in two distinct child processes', async () => {
    const factory = createIsolatedAdapterFactory({
      track: 'no-learning',
      timing: 'immediate',
      deadlineMs: 5_000,
      process: { stderr: 'count' },
    });

    try {
      const result = await runLearnerAdapterConformance(factory, {
        episodes: 2,
        seed: 'isolation-conformance',
      });
      const processIds = factory.adapters.map((adapter) => adapter.isolation.processId);

      expect(result.proposals).toBe(4);
      expect(processIds).toHaveLength(2);
      expect(processIds.every((id) => id !== undefined && id !== process.pid)).toBe(true);
      expect(new Set(processIds).size).toBe(2);

      const probe = await factory.adapters[0]?.probeIsolation({
        readPath: new URL('../../../SPECIFICATION.md', import.meta.url).pathname,
      });
      expect(probe?.permissionModel).toBe(true);
      expect(probe?.fsRead).toBe('denied');
      expect(probe?.clipboard).toBe('denied');
      expect(probe?.childProcess).toBe('denied');
      expect(probe?.worker).toBe('denied');
    } finally {
      await factory.dispose();
    }
  }, 20_000);
});

describe('read-only shuffled previews', () => {
  it('preserves a scratch policy and ledger across the remote host boundary', async () => {
    const runId = 'remote-preview';
    const pair = createLoopbackChannelPair();
    const host = new LearnerHost({
      channel: pair.host,
      boundary: 'in-process',
      track: 'scratch-rl',
    });
    const adapter = new RemoteLearnerAdapter({
      track: 'scratch-rl',
      transport: new DirectHostTransport('in-process', pair.runtime),
      timing: 'immediate',
    });
    const config = buildConformanceRunConfig('scratch-rl', {
      runId,
      episodes: 1,
      symbolInventorySize: 8,
    });
    const ledger = new RecordingLedgerClient(runId, 'baby-a');

    try {
      await adapter.init({
        runId,
        role: 'baby-a',
        babyId: 'A',
        config,
        learnerContract: loadLearnerContract('scratch-rl'),
        seed: 'remote-preview-seed',
        symbolInventory: fixedTokenInventory(8),
        ledger,
      });
      const preview = adapter.previewAct;
      expect(preview).toBeDefined();
      const before = hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy());

      await preview?.({
        observation: {
          runId,
          turn: 0,
          recipient: 'baby-a',
          encoding: 'opaque-numeric',
          payload: [[0, 0, 1], [1, 1, 0]],
          scenarioRef: 'scenario:remote-preview',
        },
        budget: {
          turn: 0,
          role: 'sender',
          responseBudgetMs: 1_000,
          availableActions: ['emit_symbols'],
        },
      });

      expect(hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy())).toBe(before);
      expect(ledger.drafts).toHaveLength(0);
    } finally {
      await adapter.dispose();
      await host.close();
    }
  });
});

describe('policy synchronization deadlines', () => {
  it('does not perform policy synchronization after a read-only normalized action', async () => {
    const runId = 'remote-policy-sync-deadline';
    const pair = createLoopbackChannelPair();
    let exportCalls = 0;
    let delayedExportCall = Number.POSITIVE_INFINITY;
    const host = new LearnerHost({
      channel: pair.host,
      boundary: 'in-process',
      track: 'scratch-rl',
      beforeDispatch: async (method) => {
        if (method === 'export_policy' && ++exportCalls === delayedExportCall) {
          await delay(500);
        }
      },
    });
    const adapter = new RemoteLearnerAdapter({
      track: 'scratch-rl',
      transport: new DirectHostTransport('in-process', pair.runtime),
      timing: 'normalized',
      deadlineMs: 200,
    });
    const config = buildConformanceRunConfig('scratch-rl', {
      runId,
      episodes: 1,
      symbolInventorySize: 8,
    });
    const ledger = new RecordingLedgerClient(runId, 'baby-a');

    try {
      await adapter.init({
        runId,
        role: 'baby-a',
        babyId: 'A',
        config,
        learnerContract: loadLearnerContract('scratch-rl'),
        seed: 'remote-policy-sync-deadline-seed',
        symbolInventory: fixedTokenInventory(8),
        ledger,
      });
      await adapter.observe({
        runId,
        turn: 0,
        recipient: 'baby-a',
        encoding: 'opaque-numeric',
        payload: [[0, 0, 1], [1, 1, 0]],
        scenarioRef: 'scenario:remote-policy-sync-deadline',
      });
      delayedExportCall = exportCalls + 1;
      await expect(adapter.act({
        turn: 0,
        role: 'sender',
        responseBudgetMs: 200,
        availableActions: ['emit_symbols'],
      })).resolves.toMatchObject({ proposal: { kind: 'emit_symbols' } });
      expect(adapter.diagnostics).toMatchObject({
        deadlineExceeded: 0,
        lastDeadlineMethod: null,
        policyRefreshes: 1,
      });
      expect(exportCalls).toBe(1);
    } finally {
      await adapter.dispose();
      await host.close();
    }
  });
});

describe('distinct Baby and model-adapter processes', () => {
  it('preserves the learner contract across both process boundaries', async () => {
    const factory = createBabyProcessAdapterFactory({
      track: 'no-learning',
      timing: 'immediate',
      deadlineMs: 5_000,
      process: { stderr: 'count' },
    });

    let observedProcessIds: number[] = [];
    try {
      const result = await runLearnerAdapterConformance(factory, {
        episodes: 1,
        seed: 'baby-model-process-conformance',
      });
      expect(result.proposals).toBe(2);

      const babyIds = factory.adapters.map((adapter) => adapter.isolation.processId);
      expect(babyIds).toHaveLength(2);
      expect(babyIds.every((id) => id !== undefined && id !== process.pid)).toBe(true);
      expect(new Set(babyIds).size).toBe(2);

      if (process.platform === 'linux') {
        const modelIds = await Promise.all(
          babyIds.map(async (babyId) => {
            const children = await readFile(
              `/proc/${String(babyId)}/task/${String(babyId)}/children`,
              'utf8',
            );
            return children.trim().split(/\s+/u).filter(Boolean).map(Number);
          }),
        );
        expect(modelIds.every((ids) => ids.length === 1)).toBe(true);
        const flattened = modelIds.flat();
        expect(new Set([...babyIds, ...flattened]).size).toBe(4);
        observedProcessIds = [...babyIds, ...flattened] as number[];
      }
    } finally {
      await factory.dispose();
    }
    if (process.platform === 'linux') {
      await expectProcessesToExit(observedProcessIds);
    }
  }, 20_000);

  it('refuses a nested normalized timer', () => {
    const pair = createLoopbackChannelPair();
    expect(() =>
      new RemoteLearnerAdapter({
        track: 'no-learning',
        transport: new DirectHostTransport('in-process', pair.runtime),
        timing: 'normalized',
        turnDeadlineAuthority: 'upstream',
      }),
    ).toThrow();
    pair.runtime.close();
  });
});

describe('host-error detail propagation', () => {
  const runId = 'host-error-detail';

  function initParams(): Record<string, unknown> {
    const fullConfig = buildConformanceRunConfig('scratch-rl', {
      runId,
      episodes: 1,
      symbolInventorySize: 8,
    }) as unknown as Record<string, unknown>;
    // Researcher-only seed material must never cross the boundary.
    const { randomSeed: _randomSeed, seedBindings: _seedBindings, ...visibleConfig } =
      fullConfig;
    expect(visibleConfig).not.toHaveProperty('randomSeed');
    expect(visibleConfig).not.toHaveProperty('seedBindings');
    return {
      track: 'scratch-rl',
      runId,
      role: 'baby-a',
      babyId: 'A',
      config: visibleConfig,
      learnerContract: loadLearnerContract('scratch-rl'),
      seed: 'host-error-detail-seed',
      symbolInventory: fixedTokenInventory(8),
    };
  }

  function stubAdapter(overrides: Partial<LearnerAdapter> = {}): LearnerAdapter {
    return {
      track: 'scratch-rl',
      init: async () => {},
      observe: async () => {},
      act: async () => {
        throw new Error('act not stubbed');
      },
      receive: async () => {
        throw new Error('receive not stubbed');
      },
      onOutcome: async () => {},
      exportPolicy: () => ({ marker: 'stub-policy' }),
      ...overrides,
    };
  }

  async function initHosted(adapter: LearnerAdapter): Promise<{
    host: LearnerHost;
    runtime: FrameConnection;
    wire: () => string;
  }> {
    const pair = createLoopbackChannelPair();
    const host = new LearnerHost({
      channel: pair.host,
      boundary: 'in-process',
      createFactory: () => ({ track: 'scratch-rl', create: () => adapter }),
    });
    const runtime = new FrameConnection({
      channel: pair.runtime,
      originator: 'r',
    });
    await runtime.request('init', initParams());
    return { host, runtime, wire: () => pair.host.written.join('') };
  }

  async function updatePolicyFailure(
    runtime: FrameConnection,
  ): Promise<IsolationError> {
    const failure = await runtime
      .request('update_policy', {
        runId,
        turns: [0],
        learningSignal: 'extrinsic-task',
      })
      .then(
        () => {
          throw new Error('update_policy should have failed');
        },
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(IsolationError);
    return failure as IsolationError;
  }

  it('carries the inner error name and message for a throwing update_policy', async () => {
    const { host, runtime } = await initHosted(
      stubAdapter({
        updatePolicy: async () => {
          throw new TypeError('policy store exploded');
        },
      }),
    );
    try {
      const failure = await updatePolicyFailure(runtime);
      expect(failure).toMatchObject({
        code: 'host-error',
        hostCode: 'adapter-error',
      });
      expect(failure.hostDetail).toContain('TypeError');
      expect(failure.hostDetail).toContain('policy store exploded');
    } finally {
      runtime.close();
      await host.close();
    }
  });

  it('truncates a long adapter message instead of putting it on the wire', async () => {
    const longMessage = `${'y'.repeat(600)}\nsecond line\n${'x'.repeat(5_000)}`;
    const { host, runtime, wire } = await initHosted(
      stubAdapter({
        updatePolicy: async () => {
          throw new Error(longMessage);
        },
      }),
    );
    try {
      const failure = await updatePolicyFailure(runtime);
      expect(failure).toMatchObject({
        code: 'host-error',
        hostCode: 'adapter-error',
      });
      expect(failure.hostDetail).toContain('Error');
      expect(failure.hostDetail).not.toContain('second line');
      expect(failure.hostDetail?.length).toBeLessThanOrEqual(
        HOST_ERROR_DETAIL_LIMIT + 1,
      );
      expect(wire()).not.toContain('y'.repeat(600));
    } finally {
      runtime.close();
      await host.close();
    }
  });

  it('leaves typed host refusals detail-free', async () => {
    const { host, runtime } = await initHosted(stubAdapter());
    try {
      const failure = await updatePolicyFailure(runtime);
      expect(failure).toMatchObject({
        code: 'host-error',
        hostCode: 'unsupported-method',
      });
      expect(failure.hostDetail).toBeUndefined();
    } finally {
      runtime.close();
      await host.close();
    }
  });
});

async function expectProcessesToExit(processIds: readonly number[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  let live: number[] = [];
  do {
    live = [];
    for (const processId of processIds) {
      try {
        await access(`/proc/${String(processId)}`);
        live.push(processId);
      } catch {
        // Missing `/proc` entry means the process has exited.
      }
    }
    if (live.length === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  expect(live).toEqual([]);
}
