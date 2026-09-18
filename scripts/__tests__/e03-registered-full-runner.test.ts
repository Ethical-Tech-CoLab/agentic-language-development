import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveE03FullAnalysisSeed } from '../e03-full-collector-state.mjs';

const script = fileURLToPath(new URL('../run-e03-registered-full.mjs', import.meta.url));
const directories: string[] = [];
const git = (directory: string, ...args: string[]) => spawnSync('git', args,
  { cwd: directory, encoding: 'utf8' });
const run = (directory: string, mode: '--run' | '--audit') => spawnSync(process.execPath,
  [script, mode], { cwd: directory, encoding: 'utf8' });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-full-runner-'));
  directories.push(directory);
  expect(git(directory, 'init', '-q').status).toBe(0);
  writeFileSync(join(directory, 'baseline.txt'), 'synthetic full runner fixture\n');
  expect(git(directory, 'add', 'baseline.txt').status).toBe(0);
  expect(git(directory, '-c', 'user.name=Fixture', '-c',
    'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline').status).toBe(0);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('E03 registered full-stage runner preconditions', () => {
  it('derives one stable stream from every registered analysis seed', () => {
    const registered = Array.from({ length: 168 }, (_, index) => ({
      config: { seedBindings: { analysis: `analysis-${String(index)}` } },
    }));
    expect(deriveE03FullAnalysisSeed(registered)).toMatch(/^[a-f0-9]{64}$/u);
    expect(deriveE03FullAnalysisSeed(registered)).toBe(deriveE03FullAnalysisSeed(registered));
    expect(() => deriveE03FullAnalysisSeed(registered.slice(1))).toThrow(/168-run/u);
  });

  it('does not create original evidence if admission rejects missing registration', () => {
    const directory = fixture();
    const result = run(directory, '--run');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('e03-full-registration.v1.json');
    expect(existsSync(join(directory, 'evidence/qualification/e03-full-v1'))).toBe(false);
  });

  it('refuses a dirty execution commit before launching containers', () => {
    const directory = fixture();
    writeFileSync(join(directory, 'dirty.txt'), 'uncommitted fixture change\n');
    const result = run(directory, '--run');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 full admission requires a clean execution commit');
    expect(existsSync(join(directory, 'evidence/qualification/e03-full-v1'))).toBe(false);
  });

  it('cannot report a full result from missing original records', () => {
    const directory = fixture();
    const result = run(directory, '--audit');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('e03-full-v1/receipt.json');
  });
});
