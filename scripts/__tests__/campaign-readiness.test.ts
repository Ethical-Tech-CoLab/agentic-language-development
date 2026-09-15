/* eslint-disable @typescript-eslint/no-explicit-any -- malformed status fixtures intentionally cross the JSON boundary */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryDirectories: string[] = [];
const source = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

function fixture(mutate: (campaign: any, receipts: Record<string, any>) => void = () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'ald-campaign-readiness-'));
  temporaryDirectories.push(directory);
  const campaign = source('protocols/campaign-readiness-review.v1.json');
  const receipts = Object.fromEntries(['e00', 'e01', 'e02'].map((id) => [id, source(
    id === 'e00' ? 'reports/research/e00-integrity-qualification-receipt.json'
      : id === 'e01' ? 'reports/research/e01-isolation-qualification-receipt.json'
        : 'reports/research/e02-v2-qualification-receipt.json',
  )]));
  mutate(campaign, receipts);
  const values: Record<string, unknown> = {
    'protocols/campaign-readiness-review.v1.json': campaign,
    'protocols/research-protocol-cards.v1.json': source('protocols/research-protocol-cards.v1.json'),
    'protocols/seed-and-resource-allocation.v1.json': source('protocols/seed-and-resource-allocation.v1.json'),
    'docs/experiment-readiness-gates.json': source('docs/experiment-readiness-gates.json'),
    'reports/research/e00-integrity-qualification-receipt.json': receipts.e00,
    'reports/research/e01-isolation-qualification-receipt.json': receipts.e01,
    'reports/research/e02-qualification-receipt.json': source('reports/research/e02-qualification-receipt.json'),
    'reports/research/e02-v2-qualification-receipt.json': receipts.e02,
    'reports/research/e02-v1-failure-evidence.json': source('reports/research/e02-v1-failure-evidence.json'),
    'reports/research/e02-v2-failure-evidence.json': source('reports/research/e02-v2-failure-evidence.json'),
    'protocols/e02-registration.v2.json': source('protocols/e02-registration.v2.json'),
    'protocols/e02-registration-binding.v2.json': source('protocols/e02-registration-binding.v2.json'),
    'protocols/e02-registration.v3.json': source('protocols/e02-registration.v3.json'),
    'protocols/e02-registration-binding.v3.json': source('protocols/e02-registration-binding.v3.json'),
    'reports/research/e02-v3-execution-gate-receipt.json': source('reports/research/e02-v3-execution-gate-receipt.json'),
    'reports/research/e02-v3-execution-start.json': source('reports/research/e02-v3-execution-start.json'),
  };
  if (receipts.e02v3) {
    values['reports/research/e02-v3-qualification-receipt.json'] = receipts.e02v3;
    values['reports/research/e02-v3-full-audit-receipt.json'] = {
      experimentId: 'E02', classification: 'original-raw-evidence-recomputed-audit',
      terminalReceiptSha256: `sha256:${createHash('sha256').update(`${JSON.stringify(receipts.e02v3, null, 2)}\n`).digest('hex')}`,
      passed: true, slotsRecomputed: 5, probeReportsRecomputed: 60,
    };
  }
  for (const [path, value] of Object.entries(values)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [
    '--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'),
    join(root, 'scripts/check-campaign-readiness.ts'),
  ], { cwd: directory, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('stage-specific campaign progress', () => {
  it('accepts the current evidence-backed progress record', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
  });

  it('allows a gate to advance from its receipt instead of a hard-coded experiment list', () => {
    const result = run(fixture((campaign, receipts) => {
      const e02 = campaign.experiments.find((entry: any) => entry.id === 'E02');
      e02.executionReadiness = { stage: 'qualification', decision: 'complete', reasonCodes: [] };
      e02.attempt = { version: 'v3', status: 'completed', planned: 5, attempted: 5, completed: 5 };
      e02.evidence.find((entry: any) => entry.path === 'reports/research/e02-v3-execution-start.json').statusAuthority = false;
      e02.evidence.push({ kind: 'post-run-full-raw-audit', path: 'reports/research/e02-v3-full-audit-receipt.json', statusAuthority: false });
      e02.evidence.push({ kind: 'terminal-receipt', path: 'reports/research/e02-v3-qualification-receipt.json', statusAuthority: true });
      campaign.resolvedFindings.push({ id: 'B16', owner: 'D08',
        resolution: 'The complete E02 v3 five-slot terminal and full raw-evidence audit passed.',
        boundary: 'Software qualification only; no behavioral finding or independent review is claimed.' });
      campaign.blockingFindings = campaign.blockingFindings.filter((finding: any) => finding.id !== 'B16');
      receipts.e02v3 = { experimentId: 'E02', registrationHash: source('protocols/e02-registration.v3.json').preRegistrationHash,
        classification: 'prospectively-registered-software-qualification', passed: true, failure: null,
        slots: Array.from({ length: 5 }, (_, index) => ({ slot: index + 1, passed: true, probesRecomputed: 12 })) };
    }));
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects closing B16 without completed E02 qualification', () => {
    const result = run(fixture((campaign) => {
      campaign.resolvedFindings.push({ id: 'B16', owner: 'D08',
        resolution: 'A reported terminal receipt is available, but no complete qualification was audited.',
        boundary: 'No software qualification or behavioral finding is established by this report.' });
      campaign.blockingFindings = campaign.blockingFindings.filter((finding: any) => finding.id !== 'B16');
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('B16 disposition contradicts the terminal E02 qualification gate');
  });

  it('rejects a missing terminal disposition instead of inferring a running attempt', () => {
    const result = run(fixture((campaign, receipts) => {
      const e02 = campaign.experiments.find((entry: any) => entry.id === 'E02');
      e02.executionReadiness = { stage: 'qualification', decision: 'blocked', reasonCodes: ['B16'] };
      e02.attempt = { status: 'failed', planned: 5, attempted: 1, completed: 0 };
      e02.evidence.find((entry: any) => entry.path === 'reports/research/e02-v3-execution-start.json').statusAuthority = false;
      e02.evidence.find((entry: any) => entry.path === 'reports/research/e02-v2-qualification-receipt.json').statusAuthority = true;
      receipts.e02.passed = false;
      receipts.e02.failure = null;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E02 progress contradicts its status-authority receipt');
  });

  it('rejects a stale running account when the registered terminal receipt exists', () => {
    const directory = fixture();
    const packet = source('protocols/e02-registration.v3.json');
    const terminalPath = join(directory, 'reports/research/e02-v3-qualification-receipt.json');
    writeFileSync(terminalPath, JSON.stringify({
      experimentId: 'E02', registrationHash: packet.preRegistrationHash,
      passed: true, failure: null, slots: Array.from({ length: 5 }, (_, index) => ({ slot: index + 1 })),
    }));
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E02 terminal receipt exists but is not the status authority');
  });

  it('rejects a terminal receipt bound to another registration', () => {
    const directory = fixture();
    const terminalPath = join(directory, 'reports/research/e02-v3-qualification-receipt.json');
    writeFileSync(terminalPath, JSON.stringify({ experimentId: 'E02', registrationHash: 'sha256:wrong' }));
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E02 terminal receipt contradicts its prospective registration');
  });

  it('rejects attempted/completed counts that disagree with the receipt', () => {
    const result = run(fixture((campaign) => {
      const e01 = campaign.experiments.find((entry: any) => entry.id === 'E01');
      e01.attempt.completed = 4;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E01 progress contradicts its status-authority receipt');
  });
});
