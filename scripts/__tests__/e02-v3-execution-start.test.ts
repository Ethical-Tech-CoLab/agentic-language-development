/* eslint-disable @typescript-eslint/no-explicit-any -- mutation fixtures intentionally cross the JSON boundary */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateE02V3ExecutionStart } from '../check-e02-v3-execution-start.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const record = () => JSON.parse(readFileSync(
  join(root, 'reports/research/e02-v3-execution-start.json'), 'utf8',
));

describe('E02 v3 execution start', () => {
  it('accepts the running, non-result status', () => {
    expect(() => validateE02V3ExecutionStart(record())).not.toThrow();
  });

  it('rejects promotion to completion or a finding', () => {
    const value: any = record();
    value.attemptStatus = 'completed';
    value.researchFinding = true;
    expect(() => validateE02V3ExecutionStart(value)).toThrow();
  });

  it('rejects replacement or completed seed accounting', () => {
    const value: any = record();
    value.noSameSeedRerun = false;
    value.completedSlots = 1;
    expect(() => validateE02V3ExecutionStart(value)).toThrow();
  });
});
