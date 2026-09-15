import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashCanonical } from '@ald/hashing';
import { HASH_DOMAINS } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directories: string[] = [];
const script = join(root, 'scripts/activate-e03-registration.mjs');
const git = (directory: string, ...args: string[]) => spawnSync('git', args, {
  cwd: directory, encoding: 'utf8',
});
const run = (directory: string, mode: '--activate' | '--check',
  version: 'v1' | 'v2' | 'v3' = 'v1') =>
  spawnSync(process.execPath,
    [script, 'pilot', mode, ...(version === 'v1' ? [] : [version])],
    { cwd: directory, encoding: 'utf8' });

function fixture(version: 'v1' | 'v2' | 'v3' = 'v1') {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-activation-'));
  directories.push(directory);
  expect(git(directory, 'init', '-q').status).toBe(0);
  writeFileSync(join(directory, 'baseline.txt'), 'synthetic fixture only\n');
  expect(git(directory, 'add', 'baseline.txt').status).toBe(0);
  expect(git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture baseline').status).toBe(0);
  const baseline = git(directory, 'rev-parse', 'HEAD').stdout.trim();
  const artifact = {
    version: 1, experimentId: 'E03', protocolGitCommit: baseline,
    registrationClass: 'qualification', hypothesis: 'Synthetic activation fixture only.',
    parameters: { stage: 'blinded-pilot' }, seeds: ['synthetic-seed'],
    analysisPlan: 'Synthetic activation fixture only.',
  };
  const packet = {
    artifact, preRegistrationHash: hashCanonical(HASH_DOMAINS.preRegistration, artifact),
  };
  const packetPath = `protocols/e03-pilot-registration.${version}.json`;
  const path = join(directory, packetPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`);
  expect(git(directory, 'add', packetPath).status).toBe(0);
  expect(git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture packet').status).toBe(0);
  return { directory, path, packet };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('E03 repository-native simulated activation', () => {
  it('activates committed bytes and verifies a deterministic zero-spend binding', () => {
    const { directory, packet } = fixture();
    const activation = run(directory, '--activate');
    expect(activation.status, activation.stderr).toBe(0);
    const binding = JSON.parse(readFileSync(join(directory,
      'protocols/e03-pilot-registration-binding.v1.json'), 'utf8'));
    expect(binding.preRegistrationHash).toBe(packet.preRegistrationHash);
    expect(binding.preRunAnchor.anchorClass).toBe('simulated');
    expect(run(directory, '--check').status).toBe(0);
  });

  it('activates a distinct v2 packet without overwriting v1', () => {
    const { directory, packet } = fixture('v2');
    expect(run(directory, '--activate', 'v2').status).toBe(0);
    const binding = JSON.parse(readFileSync(join(directory,
      'protocols/e03-pilot-registration-binding.v2.json'), 'utf8'));
    expect(binding.preRegistrationHash).toBe(packet.preRegistrationHash);
    expect(binding.preRunAnchor.anchorClass).toBe('simulated');
    expect(run(directory, '--check', 'v2').status).toBe(0);
  });

  it('activates a fresh v3 packet without reusing earlier binding paths', () => {
    const { directory, packet } = fixture('v3');
    expect(run(directory, '--activate', 'v3').status).toBe(0);
    const binding = JSON.parse(readFileSync(join(directory,
      'protocols/e03-pilot-registration-binding.v3.json'), 'utf8'));
    expect(binding.preRegistrationHash).toBe(packet.preRegistrationHash);
    expect(binding.preRunAnchor.anchorClass).toBe('simulated');
    expect(run(directory, '--check', 'v3').status).toBe(0);
  });

  it('rejects a working packet that differs from its repository commitment', () => {
    const { directory, path, packet } = fixture();
    writeFileSync(path, `${JSON.stringify({ ...packet, preRegistrationHash: 'sha256:wrong' })}\n`);
    const result = run(directory, '--activate');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('working packet differs from committed registration');
  });
});
