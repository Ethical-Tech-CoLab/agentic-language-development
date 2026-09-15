import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../check-e03-pilot-admission.mjs', import.meta.url));
const directories: string[] = [];
const git = (directory: string, ...args: string[]) => spawnSync('git', args, {
  cwd: directory, encoding: 'utf8',
});
const run = (directory: string) => spawnSync(process.execPath,
  [script, '--live'], { cwd: directory, encoding: 'utf8' });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-pilot-admission-'));
  directories.push(directory);
  expect(git(directory, 'init', '-q').status).toBe(0);
  writeFileSync(join(directory, 'baseline.txt'), 'synthetic admission fixture\n');
  expect(git(directory, 'add', 'baseline.txt').status).toBe(0);
  expect(git(directory, '-c', 'user.name=Fixture', '-c',
    'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline').status).toBe(0);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('registered E03 pilot live admission', () => {
  it('rejects an uncommitted execution source before inspecting outcomes', () => {
    const directory = fixture();
    writeFileSync(join(directory, 'dirty.txt'), 'uncommitted fixture change\n');
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pilot admission requires a clean execution commit');
  });

  it('rejects reuse of the exact pilot evidence allocation', () => {
    const directory = fixture();
    mkdirSync(join(directory, 'evidence/pilots/e03-blinded-v1'), { recursive: true });
    expect(git(directory, 'status', '--porcelain').stdout).toBe('');
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pilot evidence allocation is single-use');
  });

  it('does not admit a pilot without the prospective packet', () => {
    const directory = fixture();
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('e03-pilot-registration.v1.json');
  });

  it('requires the separately committed v2 packet before its own pilot', () => {
    const directory = fixture();
    const result = spawnSync(process.execPath, [script, '--live', '--v2'],
      { cwd: directory, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('e03-pilot-registration.v2.json');
  });
});
