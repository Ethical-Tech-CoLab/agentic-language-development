import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../build-e03-pilot-resource-allocation.mjs', import.meta.url));
const directories: string[] = [];
const topology = 'reports/research/e03-prototype-topology-audit-receipt.json';
const allocation = 'protocols/e03-pilot-resource-allocation.v1.json';
const rawReceipt = 'evidence/qualification/e03-topology-prototype-v2/receipt.json';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-allocation-'));
  directories.push(directory);
  return directory;
}

function write(directory: string, path: string, value: unknown) {
  const full = join(directory, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
}

const run = (directory: string) => spawnSync(process.execPath, [script, '--write'], {
  cwd: directory, encoding: 'utf8',
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('E03 measured prospective pilot allocation', () => {
  it('refuses to overwrite a prior topology summary', () => {
    const directory = fixture();
    write(directory, topology, { classification: 'existing synthetic summary' });
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('topology audit summary is single-use');
    expect(existsSync(join(directory, allocation))).toBe(false);
  });

  it('does not invent an allocation when original evidence is absent', () => {
    const directory = fixture();
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('e03-topology-prototype-v2/receipt.json');
    expect(existsSync(join(directory, topology))).toBe(false);
    expect(existsSync(join(directory, allocation))).toBe(false);
  });

  it('rejects a partial or spending-marked development receipt before writing', () => {
    for (const mutation of [{ slots: [] }, { slots: Array(6).fill({}), externalSpend: 1 }]) {
      const directory = fixture();
      write(directory, rawReceipt, {
        experimentId: 'E03', profile: 'prototype-v2',
        classification: 'development-only-topology-qualification',
        passed: true, failure: null, researchFinding: false,
        externalSpend: 0, publicChainTransaction: false,
        slots: Array(6).fill({}), ...mutation,
      });
      const result = run(directory);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(directory, topology))).toBe(false);
      expect(existsSync(join(directory, allocation))).toBe(false);
    }
  });
});
