import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { runLearnerAdapterConformance } from '@ald/learners';

import {
  FrameAssembler,
  FrameConnection,
  MIN_FRAME_SIZE,
  DirectHostTransport,
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
