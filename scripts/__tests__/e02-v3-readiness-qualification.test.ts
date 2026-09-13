/* eslint-disable @typescript-eslint/no-explicit-any -- mutation fixtures intentionally cross the JSON boundary */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateE02V3ReadinessReceipt } from '../check-e02-v3-readiness-qualification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readReceipt = () => JSON.parse(readFileSync(
  join(root, 'reports/research/e02-v3-readiness-qualification-receipt.json'),
  'utf8',
));

describe('E02 v3 readiness qualification', () => {
  it('preserves the pre-registration software-only boundary', () => {
    expect(() => validateE02V3ReadinessReceipt(readReceipt())).not.toThrow();
  });

  it('rejects promotion to a research finding', () => {
    const receipt: any = readReceipt();
    receipt.researchFinding = true;
    receipt.scientificDisposition = 'supported';
    expect(() => validateE02V3ReadinessReceipt(receipt)).toThrow();
  });

  it('rejects omission of a turn-path deadline case', () => {
    const receipt: any = readReceipt();
    receipt.deadlineQualification.turnPaths.pop();
    expect(() => validateE02V3ReadinessReceipt(receipt)).toThrow();
  });

  it('rejects hiding the nested build advisory', () => {
    const receipt: any = readReceipt();
    receipt.limitations.nestedRendererBuildAdvisory.reportedHighSeverity = 0;
    expect(() => validateE02V3ReadinessReceipt(receipt)).toThrow();
  });
});
