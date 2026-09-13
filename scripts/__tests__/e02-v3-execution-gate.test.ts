/* eslint-disable @typescript-eslint/no-explicit-any -- mutation fixtures intentionally cross the JSON boundary */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateE02V3ExecutionGateReceipt } from '../check-e02-v3-execution-gate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const receipt = () => JSON.parse(readFileSync(
  join(root, 'reports/research/e02-v3-execution-gate-receipt.json'), 'utf8',
));

describe('E02 v3 execution admission gate', () => {
  it('accepts the bounded ready decision', () => {
    expect(() => validateE02V3ExecutionGateReceipt(receipt())).not.toThrow();
  });

  it('rejects a started or scientific-result claim', () => {
    const value: any = receipt();
    value.registeredExecutionStarted = true;
    value.researchFinding = true;
    expect(() => validateE02V3ExecutionGateReceipt(value)).toThrow();
  });

  it('rejects external spending or a public-chain claim', () => {
    const value: any = receipt();
    value.registration.externalSpend = 1;
    value.registration.publicChainTransaction = true;
    expect(() => validateE02V3ExecutionGateReceipt(value)).toThrow();
  });

  it('rejects insufficient admission storage', () => {
    const value: any = receipt();
    value.resources.availableFilesystemBytesAtGate = 1;
    expect(() => validateE02V3ExecutionGateReceipt(value)).toThrow();
  });
});
