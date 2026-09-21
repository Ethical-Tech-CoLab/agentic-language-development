import { describe, expect, it } from 'vitest';
import type { LedgerEventDraft } from '@ald/types';

import {
  RuntimePrivateLedgerClient,
  type PrivateLedgerEvidencePort,
} from '../src/private-ledger.js';

const DRAFT: LedgerEventDraft = {
  eventType: 'hypothesis.created',
  contentSchema: 'agent-native-ledger',
  subjectId: 'symbol:S01',
  content: { hypothesisRef: 'hyp:one' },
  blindingNonce: 'nonce:one',
  evidenceRefs: [],
};

describe('RuntimePrivateLedgerClient capability', () => {
  it('binds every append to its configured run, role, and current turn', async () => {
    const requests: Parameters<PrivateLedgerEvidencePort['appendLedgerEvent']>[0][] = [];
    const evidence: PrivateLedgerEvidencePort = {
      appendLedgerEvent: async (request) => {
        requests.push(request);
        throw new Error('capture-only port');
      },
    };
    let turn = 4;
    const client = new RuntimePrivateLedgerClient(
      evidence,
      'private-ledger-run',
      'A',
      () => turn,
    );

    await expect(client.append(DRAFT)).rejects.toThrow('capture-only port');
    turn = 7;
    await expect(client.append(DRAFT, {
      channelEventHash: `sha256:${'1'.repeat(64)}`,
    })).rejects.toThrow('capture-only port');

    expect(requests).toEqual([
      {
        runId: 'private-ledger-run',
        babyId: 'A',
        turn: 4,
        draft: DRAFT,
      },
      {
        runId: 'private-ledger-run',
        babyId: 'A',
        turn: 7,
        draft: DRAFT,
        channelEventHash: `sha256:${'1'.repeat(64)}`,
      },
    ]);
    expect(Object.keys(evidence)).toEqual(['appendLedgerEvent']);
  });
});
