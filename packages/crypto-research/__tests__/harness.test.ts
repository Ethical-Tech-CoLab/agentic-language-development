import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@ald/hashing';

import {
  CRYPTOGRAPHIC_SECURITY_STATUS,
  ENCODING_ROLES,
  EphemeralEncodingHarness,
  RESEARCH_ONLY_NOTICE,
} from '../src/index.js';

class StepClock {
  private tick = 0;

  now(): string {
    const value = new Date(Date.UTC(2026, 8, 2, 0, 0, this.tick)).toISOString();
    this.tick += 1;
    return value;
  }
}

function harness(priorArtifactHashes: string[] = []): EphemeralEncodingHarness {
  return new EphemeralEncodingHarness({
    runId: 'e40-harness-test',
    carrierMode: 'generative-canvas',
    cipherThreatModel: 'novelty-only',
    syntheticMessagesOnly: true,
    clock: new StepClock(),
    priorArtifactHashes,
  });
}

describe('E40 ephemeral encoding harness', () => {
  it('refuses a non-synthetic run even if an untyped caller bypasses TypeScript', () => {
    expect(
      () =>
        new EphemeralEncodingHarness({
          runId: 'unsafe-e40-run',
          carrierMode: 'generative-canvas',
          cipherThreatModel: 'novelty-only',
          syntheticMessagesOnly: false,
          clock: new StepClock(),
        } as unknown as ConstructorParameters<typeof EphemeralEncodingHarness>[0]),
    ).toThrow(/synthetic messages only/u);
  });

  it('requires both independent nonce commitments and logs every scheme change', () => {
    const run = harness();
    expect(run.participants).toEqual(ENCODING_ROLES);
    run.commitNonce('baby-a', 'nonce-a');
    expect(() =>
      run.registerScheme({
        proposedBy: 'baby-a',
        canonicalProtocolArtifact: { strokes: [1, 2] },
        publicSalt: 'salt-1',
      }),
    ).toThrow(/both Baby nonce commitments/u);
    run.commitNonce('baby-b', 'nonce-b');
    const first = run.registerScheme({
      proposedBy: 'baby-a',
      canonicalProtocolArtifact: { strokes: [1, 2] },
      publicSalt: 'salt-1',
    });
    const second = run.registerScheme({
      proposedBy: 'baby-b',
      canonicalProtocolArtifact: { strokes: [2, 1] },
      publicSalt: 'salt-2',
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousEventHash).toBe(first.eventHash);
    expect(second.changedAt).not.toBe(first.changedAt);
    expect(() =>
      run.registerScheme({
        proposedBy: 'baby-b',
        canonicalProtocolArtifact: { strokes: [2, 1] },
        publicSalt: 'salt-2',
      }),
    ).toThrow(/already registered/u);
  });

  it('records eavesdropper recovery without retaining raw synthetic messages', () => {
    const run = harness();
    run.commitNonce('baby-a', 'nonce-a');
    run.commitNonce('baby-b', 'nonce-b');
    const scheme = run.registerScheme({
      proposedBy: 'baby-a',
      canonicalProtocolArtifact: { transform: [3, 1, 2] },
      publicSalt: 'public-salt',
    });
    const failed = run.recordEavesdropperAttempt({
      schemeId: scheme.schemeId,
      adversaryId: 'eve-unseen-1',
      architectureClass: 'unseen',
      messageId: 'synthetic-message-1',
      guess: [0, 1],
      actual: [1, 0],
    });
    const recovered = run.recordEavesdropperAttempt({
      schemeId: scheme.schemeId,
      adversaryId: 'eve-history-1',
      architectureClass: 'history-trained',
      messageId: 'synthetic-message-2',
      guess: [1, 0],
      actual: [1, 0],
    });
    const serialized = canonicalJson(run.report());

    expect(failed).toMatchObject({ role: 'eavesdropper', recovered: false });
    expect(recovered.recovered).toBe(true);
    expect(serialized).not.toContain('synthetic-message-1');
    expect(serialized).not.toContain('synthetic-message-2');
    expect(run.report().eavesdropperAttempts).toHaveLength(2);
  });

  it('reports novelty separately and can never report cryptographic security', () => {
    const firstRun = harness();
    firstRun.commitNonce('baby-a', 'nonce-a');
    firstRun.commitNonce('baby-b', 'nonce-b');
    const scheme = firstRun.registerScheme({
      proposedBy: 'baby-a',
      canonicalProtocolArtifact: { transform: [1, 2, 3] },
      publicSalt: 'public-salt',
    });

    const compared = harness([scheme.artifactHash]);
    compared.commitNonce('baby-a', 'nonce-a');
    compared.commitNonce('baby-b', 'nonce-b');
    compared.registerScheme({
      proposedBy: 'baby-a',
      canonicalProtocolArtifact: { transform: [1, 2, 3] },
      publicSalt: 'public-salt',
    });
    const report = compared.report();

    expect(report.uniqueArtifactCount).toBe(0);
    expect(report.priorRegistryCollisions).toEqual([scheme.artifactHash]);
    expect(report.cryptographicSecurity).toBe(CRYPTOGRAPHIC_SECURITY_STATUS);
    expect(report.researchOnlyNotice).toBe(RESEARCH_ONLY_NOTICE);
    expect(JSON.stringify(report)).not.toMatch(/production-ready/iu);
  });
});
