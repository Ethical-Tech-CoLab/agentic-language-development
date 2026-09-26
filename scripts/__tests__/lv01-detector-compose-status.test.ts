import { describe, expect, it } from 'vitest';

import { composeFailureDetail } from '../lv01-detector-compose-status.mjs';

// Normal (plain-progress) Compose layout, modeled on
// evidence/lv01/detector-v1/lv01-detector-v1-p0001/output/compose-output.log.
const NORMAL_PROGRESS = [
  'Attaching to baby-a-1, controller-scenario-1, offline-verifier-1',
  ' Network ald-lv01-detector-v1_baby-a-gateway  Creating',
  ' Network ald-lv01-detector-v1_baby-a-gateway  Created',
  ' Container ald-lv01-detector-v1-controller-scenario-1  Creating',
  ' Container ald-lv01-detector-v1-controller-scenario-1  Created',
].join('\n');

const FAILED_RUN = [
  NORMAL_PROGRESS,
  'signer-baby-a-ledger-1  | Error: invalid qualification signer identity',
  'Aborting on container exit...',
  'service "controller-scenario" didn\'t complete successfully: exit 137',
].join('\n');

describe('LV01 detector Compose failure detail', () => {
  it('judges success by exit code even when output holds error-looking lines', () => {
    expect(composeFailureDetail({ status: 0, stdout: '', stderr: FAILED_RUN })).toBeNull();
  });

  it('names the exit code and the real cause instead of a progress status line', () => {
    const detail = composeFailureDetail({ status: 1, stdout: '', stderr: FAILED_RUN });
    expect(detail).toContain('compose exited 1');
    expect(detail).toContain('service "controller-scenario" didn\'t complete successfully: exit 137');
    expect(detail).not.toContain('Creating');
  });

  it('reproduces the retained receipt without quoting its Creating line', () => {
    // evidence/lv01/detector-v1/lv01-detector-v1-p0001/receipt.json recorded
    // "detector Compose failed:  Network …  Creating" for this stderr shape.
    const detail = composeFailureDetail({
      status: 1,
      stdout: '',
      stderr: ' Network ald-lv01-detector-v1_baby-a-gateway  Creating\n'
        + 'service "controller-scenario" didn\'t complete successfully: exit 137',
    });
    expect(detail).not.toContain('Network ald-lv01-detector-v1_baby-a-gateway  Creating');
    expect(detail).toContain('exit 137');
  });

  it('keeps the failure cause when trailing progress lines follow it', () => {
    const detail = composeFailureDetail({
      status: 1,
      stdout: '',
      stderr: `${FAILED_RUN}\n Container ald-lv01-detector-v1-offline-verifier-1  Stopping`,
    });
    expect(detail).toContain('didn\'t complete successfully: exit 137');
  });

  it('strips carriage returns and ANSI sequences from the cause line', () => {
    const detail = composeFailureDetail({
      status: 1,
      stdout: '',
      stderr: `${NORMAL_PROGRESS}\n\rsigner-baby-a-ledger-1 exited with code 1`,
    });
    expect(detail).toContain('signer-baby-a-ledger-1 exited with code 1');
  });

  it('reports signal termination instead of scanning output', () => {
    const detail = composeFailureDetail({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' });
    expect(detail).toContain('SIGTERM');
  });

  it('falls back to the exit code when there is no usable output', () => {
    expect(composeFailureDetail({ status: 2, stdout: '', stderr: ' \n' }))
      .toBe('compose exited 2 with no output');
  });
});
