import { describe, expect, it } from 'vitest';

import {
  buildConformanceRunConfig,
  RecordingLedgerClient,
  runLearnerAdapterConformance,
} from '@ald/learners';
import {
  DirectHostTransport,
  FrameConnection,
  LearnerHost,
  RemoteLearnerAdapter,
  createLoopbackChannelPair,
} from '@ald/isolation';
import type {
  BabyRole,
  LearnerAdapterFactory,
  LedgerAppendRequest,
} from '@ald/types';

import { GatewayLearnerRelay } from '../src/index.js';

describe('Gateway learner relay', () => {
  it('terminates Baby ledger callbacks at the Gateway writer', async () => {
    const runId = 'gateway-relay-conformance';
    const roles: BabyRole[] = ['baby-a', 'baby-b'];
    const requests: LedgerAppendRequest[] = [];
    const adapters: RemoteLearnerAdapter[] = [];
    const relays: GatewayLearnerRelay[] = [];
    const hosts: LearnerHost[] = [];
    let created = 0;

    const factory: LearnerAdapterFactory = {
      track: 'no-learning',
      create: () => {
        const role = roles[created];
        if (role === undefined) throw new Error('unexpected third adapter');
        created += 1;
        const babyId = role === 'baby-a' ? 'A' : 'B';
        const controllerPair = createLoopbackChannelPair();
        const babyPair = createLoopbackChannelPair();
        const writerLedger = new RecordingLedgerClient(runId, role);
        const host = new LearnerHost({
          channel: babyPair.host,
          boundary: 'in-process',
          track: 'no-learning',
        });
        const relay = new GatewayLearnerRelay({
          controllerChannel: controllerPair.host,
          babyChannel: babyPair.runtime,
          runId,
          role,
          babyId,
          writer: {
            appendLedgerEvent: async (request) => {
              requests.push(request);
              writerLedger.turn = request.turn;
              return writerLedger.append(
                request.draft,
                request.channelEventHash === undefined
                  ? undefined
                  : { channelEventHash: request.channelEventHash },
              );
            },
          },
        });
        const adapter = new RemoteLearnerAdapter({
          track: 'no-learning',
          transport: new DirectHostTransport('in-process', controllerPair.runtime),
          timing: 'immediate',
        });
        hosts.push(host);
        relays.push(relay);
        adapters.push(adapter);
        return adapter;
      },
    };

    try {
      const result = await runLearnerAdapterConformance(factory, {
        runId,
        episodes: 1,
        seed: 'gateway-relay-seed',
      });

      // The harness itself writes exactly three proposal/interpretation drafts
      // to the Controller ledgers. Baby-internal first-use events are additional
      // writes and must appear only at the Gateway writer.
      expect(
        result.ledgers['baby-a'].drafts.length +
          result.ledgers['baby-b'].drafts.length,
      ).toBe(3);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.runId === runId)).toBe(true);
      expect(requests.every((request) => request.turn === 1)).toBe(true);
      expect(requests.every((request) =>
        (request.babyId === 'A' || request.babyId === 'B'))).toBe(true);
      expect(relays.map((relay) => relay.diagnostics.ledgerAppends))
        .toEqual(requests.reduce(
          (counts, request) => {
            counts[request.babyId === 'A' ? 0 : 1] += 1;
            return counts;
          },
          [0, 0],
        ));
      expect(relays.every((relay) => !relay.diagnostics.quarantined)).toBe(true);
    } finally {
      await Promise.all(adapters.map((adapter) => adapter.dispose()));
      relays.forEach((relay) => relay.close());
      await Promise.all(hosts.map((host) => host.close()));
    }
  });

  it('refuses wrong run and role identities before contacting the Baby', async () => {
    const controllerPair = createLoopbackChannelPair();
    const babyPair = createLoopbackChannelPair();
    const relay = new GatewayLearnerRelay({
      controllerChannel: controllerPair.host,
      babyChannel: babyPair.runtime,
      writer: { appendLedgerEvent: () => Promise.reject(new Error('unused')) },
      runId: 'expected-run',
      role: 'baby-a',
      babyId: 'A',
    });
    const controller = new FrameConnection({
      channel: controllerPair.runtime,
      originator: 'r',
    });
    const config = buildConformanceRunConfig('no-learning', {
      runId: 'wrong-run',
      episodes: 1,
    });

    try {
      await expect(controller.request('init', {
        track: 'no-learning',
        runId: 'wrong-run',
        role: 'baby-b',
        babyId: 'B',
        config,
        learnerContract: { version: '1', text: 'opaque test contract' },
        seed: 'seed',
        symbolInventory: ['s00'],
      })).rejects.toMatchObject({
        code: 'host-error',
        hostCode: 'invalid-params',
      });
      expect(babyPair.runtime.written).toHaveLength(0);
      expect(relay.diagnostics.rejectedRequests).toBe(1);
      expect(relay.diagnostics.quarantined).toBe(false);
    } finally {
      controller.close();
      relay.close();
    }
  });

  it('quarantines an out-of-turn reverse ledger request', async () => {
    const controllerPair = createLoopbackChannelPair();
    const babyPair = createLoopbackChannelPair();
    let writes = 0;
    const relay = new GatewayLearnerRelay({
      controllerChannel: controllerPair.host,
      babyChannel: babyPair.runtime,
      writer: {
        appendLedgerEvent: () => {
          writes += 1;
          return Promise.reject(new Error('must not be called'));
        },
      },
      runId: 'bound-run',
      role: 'baby-a',
      babyId: 'A',
    });
    const baby = new FrameConnection({
      channel: babyPair.host,
      originator: 'h',
    });

    await expect(baby.request('ledger_append', {
      draft: {
        eventType: 'term.first_emitted',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:s00',
        content: { symbolRef: 's00' },
        blindingNonce: 'nonce',
        evidenceRefs: [],
      },
    })).rejects.toMatchObject({ code: 'host-error', hostCode: 'internal' });
    await immediateTurns(2);

    expect(writes).toBe(0);
    expect(relay.diagnostics.quarantined).toBe(true);
    expect(relay.isClosed).toBe(true);
    baby.close();
  });

  it('does not retry an uncertain Gateway writer call', async () => {
    const controllerPair = createLoopbackChannelPair();
    const babyPair = createLoopbackChannelPair();
    let writerCalls = 0;
    const relay = new GatewayLearnerRelay({
      controllerChannel: controllerPair.host,
      babyChannel: babyPair.runtime,
      writer: {
        appendLedgerEvent: async () => {
          writerCalls += 1;
          throw new Error('response lost after possible commit');
        },
      },
      runId: 'uncertain-run',
      role: 'baby-a',
      babyId: 'A',
    });
    const controller = new FrameConnection({
      channel: controllerPair.runtime,
      originator: 'r',
    });
    const baby = new FrameConnection({
      channel: babyPair.host,
      originator: 'h',
      handler: async (method) => {
        if (method === 'init') {
          return {
            capabilities: [],
            isolation: { boundary: 'separate-container' },
            policyDigest: hash(1),
            protocolVersion: 1,
          };
        }
        if (method === 'act') {
          await baby.request('ledger_append', {
            draft: {
              eventType: 'term.first_emitted',
              contentSchema: 'agent-native-ledger',
              subjectId: 'symbol:s00',
              content: { symbolRef: 's00' },
              blindingNonce: 'nonce',
              evidenceRefs: [],
            },
          });
        }
        return {};
      },
    });
    const fullConfig = buildConformanceRunConfig('no-learning', {
      runId: 'uncertain-run',
      episodes: 1,
    });
    const config = Object.fromEntries(Object.entries(fullConfig).filter(
      ([key]) => key !== 'randomSeed' && key !== 'seedBindings',
    ));

    await expect(controller.request('init', {
      track: 'no-learning',
      runId: 'uncertain-run',
      role: 'baby-a',
      babyId: 'A',
      config,
      learnerContract: { version: '1', text: 'opaque test contract' },
      seed: 'seed',
      symbolInventory: ['s00'],
    })).resolves.toMatchObject({ protocolVersion: 1 });
    await expect(controller.request('act', {
      turn: 7,
      role: 'sender',
      responseBudgetMs: 1_000,
      availableActions: ['emit_symbols'],
    })).rejects.toMatchObject({ code: 'host-unavailable' });
    await immediateTurns(3);

    expect(writerCalls).toBe(1);
    expect(relay.writerFailure).toBeInstanceOf(Error);
    expect(relay.diagnostics.quarantined).toBe(true);
    expect(relay.isClosed).toBe(true);
    controller.close();
    baby.close();
  });
});

function hash(byte: number): `sha256:${string}` {
  return `sha256:${byte.toString(16).padStart(2, '0').repeat(32)}`;
}

async function immediateTurns(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
