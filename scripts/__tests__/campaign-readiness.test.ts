/* eslint-disable @typescript-eslint/no-explicit-any -- malformed status fixtures intentionally cross the JSON boundary */
import { spawnSync } from 'node:child_process';
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
        : 'reports/research/e02-qualification-receipt.json',
  )]));
  mutate(campaign, receipts);
  const values: Record<string, unknown> = {
    'protocols/campaign-readiness-review.v1.json': campaign,
    'protocols/research-protocol-cards.v1.json': source('protocols/research-protocol-cards.v1.json'),
    'protocols/seed-and-resource-allocation.v1.json': source('protocols/seed-and-resource-allocation.v1.json'),
    'docs/experiment-readiness-gates.json': source('docs/experiment-readiness-gates.json'),
    'reports/research/e00-integrity-qualification-receipt.json': receipts.e00,
    'reports/research/e01-isolation-qualification-receipt.json': receipts.e01,
    'reports/research/e02-qualification-receipt.json': receipts.e02,
    'reports/research/e02-v1-failure-evidence.json': source('reports/research/e02-v1-failure-evidence.json'),
  };
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
      e02.attempt = { status: 'completed', planned: 5, attempted: 5, completed: 5 };
      receipts.e02.passed = true;
      receipts.e02.failure = null;
      receipts.e02.slots = Array.from({ length: 5 }, (_, index) => ({ slot: index + 1 }));
    }));
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a missing terminal disposition instead of inferring a running attempt', () => {
    const result = run(fixture((_campaign, receipts) => {
      receipts.e02.passed = false;
      receipts.e02.failure = null;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E02 progress contradicts its status-authority receipt');
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
