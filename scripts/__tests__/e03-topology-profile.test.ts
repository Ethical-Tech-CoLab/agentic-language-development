import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../run-e03-topology-qualification.mjs', import.meta.url));
const directories: string[] = [];
const git = (directory: string, ...args: string[]) => spawnSync('git', args, {
  cwd: directory, encoding: 'utf8',
});
const run = (directory: string, mode: string) => spawnSync(process.execPath,
  [script, mode], { cwd: directory, encoding: 'utf8' });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-topology-profile-'));
  directories.push(directory);
  expect(git(directory, 'init', '-q').status).toBe(0);
  writeFileSync(join(directory, 'baseline.txt'), 'synthetic development profile fixture\n');
  expect(git(directory, 'add', 'baseline.txt').status).toBe(0);
  expect(git(directory, '-c', 'user.name=Fixture', '-c',
    'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline').status).toBe(0);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('E03 prospective Prototype-Mode development profile', () => {
  it('refuses a dirty execution source before creating evidence', () => {
    const directory = fixture();
    writeFileSync(join(directory, 'dirty.txt'), 'uncommitted fixture change\n');
    const result = run(directory, '--run-prototype-v2');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('development topology execution requires a clean source commit');
    expect(existsSync(join(directory, 'evidence/qualification/e03-topology-prototype-v2'))).toBe(false);
  });

  it('requires an exact release auditor before creating fresh v2 evidence', () => {
    const directory = fixture();
    const result = run(directory, '--run-prototype-v2');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('build the Rust integrity auditor before collection');
    expect(existsSync(join(directory, 'evidence/qualification/e03-topology-prototype-v2'))).toBe(false);
  });

  it('audits the separate v2 root rather than falling through to v1', () => {
    const directory = fixture();
    const result = run(directory, '--audit-prototype-v2');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('e03-topology-prototype-v2/receipt.json');
  });
});
