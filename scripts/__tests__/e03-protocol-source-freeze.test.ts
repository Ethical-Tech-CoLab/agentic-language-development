import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const moduleUrl = new URL('../check-e03-pilot-admission.mjs', import.meta.url).href;
const directories: string[] = [];
const git = (directory: string, ...args: string[]) => spawnSync('git', args, {
  cwd: directory, encoding: 'utf8',
});

function commit(directory: string, message: string) {
  expect(git(directory, 'add', '-A').status).toBe(0);
  expect(git(directory, '-c', 'user.name=Fixture', '-c',
    'user.email=fixture@example.invalid', 'commit', '-qm', message).status).toBe(0);
  return git(directory, 'rev-parse', 'HEAD').stdout.trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-source-freeze-'));
  directories.push(directory);
  expect(git(directory, 'init', '-q').status).toBe(0);
  mkdirSync(join(directory, 'scripts'));
  writeFileSync(join(directory, 'scripts/frozen.mjs'), 'export const frozen = true;\n');
  const base = commit(directory, 'frozen source');
  mkdirSync(join(directory, 'protocols'));
  writeFileSync(join(directory, 'protocols/packet.json'), '{"draft":true}\n');
  const packet = commit(directory, 'prospective packet');
  return { directory, base, packet };
}

const run = (directory: string, base: string, execution: string) =>
  spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { assertFrozenE03Sources } from ${JSON.stringify(moduleUrl)}; ` +
    `assertFrozenE03Sources(${JSON.stringify(base)}, ${JSON.stringify(execution)});`],
  { cwd: directory, encoding: 'utf8' });

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('E03 protocol-base source freeze', () => {
  it('permits a committed prospective packet without source changes', () => {
    const { directory, base, packet } = fixture();
    expect(run(directory, base, packet).status).toBe(0);
  });

  it('rejects source edits after the base even if later packet hashes could match', () => {
    const { directory, base } = fixture();
    writeFileSync(join(directory, 'scripts/frozen.mjs'), 'export const frozen = false;\n');
    const execution = commit(directory, 'changed code after packet');
    const result = run(directory, base, execution);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('execution sources changed after the protocol base commit');
  });
});
