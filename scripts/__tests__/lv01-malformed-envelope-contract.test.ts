import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FIXED_TOKEN_VECTORS, isGatewayReasonCode } from '@ald/gateway';

const root = fileURLToPath(new URL('../../', import.meta.url));
const controller = readFileSync(`${root}deploy/mode-r/application-controller.mjs`, 'utf8');
const auditor = readFileSync(`${root}scripts/check-lv01-malformed-envelope-v1-receipt.mjs`, 'utf8');

describe('LV01 malformed-envelope fixture contract', () => {
  it('binds the selected controller stage to an invalid-envelope rejection', () => {
    expect(controller).toContain("'lv01-malformed-envelope'");
    expect(controller).toContain('injectLv01MalformedEnvelopeProposal');
    expect(controller).toContain('runLv01MalformedEnvelope');
    expect(controller).toContain('lv01-malformed-envelope-result.json');
    expect(controller).toContain("assert.equal(channel.reasonCode, 'invalid-envelope')");
    expect(controller).toContain('delete frame.privateLedgerDraft');
    expect(controller).toContain('senderChannelBoundIntentions');
  });

  it('keeps the existing trusted-metadata path intact', () => {
    expect(controller).toContain("'lv01-malformed-proposal'");
    expect(controller).toContain('injectLv01MalformedProposal');
    expect(controller).toContain('lv01-malformed-proposal-result.json');
    expect(controller).toContain("assert.equal(channel.reasonCode, 'trusted-metadata-present')");
  });

  it('audits a sealed single-rejection invalid-envelope receipt', () => {
    expect(auditor).toContain('reports/research/lv01-malformed-envelope-v1-receipt.json');
    expect(auditor).toContain("assert.equal(result.rejectionReasonCode, 'invalid-envelope')");
    expect(auditor).toContain('remainingContainers');
    expect(auditor).toContain('senderChannelBoundIntentions');
  });

  it('targets a real Gateway envelope-frame path distinct from trusted metadata', () => {
    expect(isGatewayReasonCode('invalid-envelope')).toBe(true);
    expect(isGatewayReasonCode('trusted-metadata-present')).toBe(true);
    const frameVector = FIXED_TOKEN_VECTORS.find(
      (vector) => vector.name === 'rejects an envelope with no private ledger draft',
    );
    expect(frameVector?.expect).toBe('invalid-envelope');
    const metadataVector = FIXED_TOKEN_VECTORS.find(
      (vector) => vector.name === 'rejects Baby-supplied trusted metadata at the top level',
    );
    expect(metadataVector?.expect).toBe('trusted-metadata-present');
  });
});
