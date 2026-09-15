import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../reduce-e03-registered-pilot.mjs', import.meta.url));
const directories: string[] = [];
const run = (directory: string, mode: '--write' | '--audit') => spawnSync(process.execPath,
  [script, mode], { cwd: directory, encoding: 'utf8' });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-pilot-reduction-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('original E03 pilot reduction', () => {
  it('cannot reduce an incomplete pilot into a sample-size input', () => {
    const result = run(fixture(), '--write');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('e03-blinded-v1/receipt.json');
  });

  it('cannot reduce the v2 pilot without its separate original evidence', () => {
    const result = spawnSync(process.execPath, [script, '--write', '--v2'],
      { cwd: fixture(), encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('e03-blinded-v2/receipt.json');
  });

  it('refuses to overwrite an existing pilot reduction', () => {
    const directory = fixture();
    const root = join(directory, 'evidence/pilots/e03-blinded-v1');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'sample-size-input.json'), 'retained fixture\n');
    const result = run(directory, '--write');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('original pilot reduction is single-use');
  });

  it('cannot audit a missing reduction as if it were complete', () => {
    const result = run(fixture(), '--audit');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('original pilot reduction is absent');
  });
});
