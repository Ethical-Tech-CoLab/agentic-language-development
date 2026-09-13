/* eslint-disable @typescript-eslint/no-explicit-any -- mutation fixtures intentionally cross the JSON boundary */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateE02V2FailureRecord } from '../check-e02-v2-failure-evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

describe('E02 v2 supplemental failure evidence', () => {
  it('preserves failure and scientific-disposition semantics', () => {
    expect(() => validateE02V2FailureRecord(
      read('reports/research/e02-v2-failure-evidence.json'),
      read('reports/research/e02-v2-qualification-receipt.json'),
    )).not.toThrow();
  });

  it('rejects promotion of the failed attempt to a scientific result', () => {
    const record: any = read('reports/research/e02-v2-failure-evidence.json');
    record.scientificDisposition = 'not-supported';
    expect(() => validateE02V2FailureRecord(
      record,
      read('reports/research/e02-v2-qualification-receipt.json'),
    )).toThrow();
  });

  it('rejects manufactured restore or probe completion', () => {
    const record: any = read('reports/research/e02-v2-failure-evidence.json');
    record.progress.restoreCompleted = true;
    record.progress.completedProbeReports = 1;
    expect(() => validateE02V2FailureRecord(
      record,
      read('reports/research/e02-v2-qualification-receipt.json'),
    )).toThrow();
  });
});
