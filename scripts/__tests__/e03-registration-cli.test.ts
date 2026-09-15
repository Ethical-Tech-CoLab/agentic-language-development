import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directories: string[] = [];

function fixture() {
  mkdirSync(join(root, 'evidence'), { recursive: true });
  const directory = mkdtempSync(join(root, 'evidence/test-e03-registration-cli-'));
  directories.push(directory);
  const receiptPath = join(directory, 'synthetic-e02-receipt.json');
  writeFileSync(receiptPath, JSON.stringify({
    experimentId: 'E02', passed: true, researchFinding: false, externalSpend: 0,
    publicChainTransaction: false, registrationHash: `sha256:${'a'.repeat(64)}`,
  }));
  return { directory, receiptPath };
}

function run(receiptPath: string, directory: string, resourcePath?: string) {
  return spawnSync(process.execPath, [
    join(root, 'scripts/build-e03-registration.mjs'), '--stage', 'pilot',
    '--primary-seeds', '20', '--e02-receipt', relative(root, receiptPath),
    '--out', join(directory, 'draft.json'),
    ...(resourcePath ? ['--resource-allocation', relative(root, resourcePath)] : []),
  ], { cwd: root, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('E03 draft CLI resource policy binding', () => {
  it('accepts the actual zero-spend local-ceiling shape for a synthetic pilot fixture', () => {
    const { directory, receiptPath } = fixture();
    const result = run(receiptPath, directory);
    expect(result.status, result.stderr).toBe(0);
    const packet = JSON.parse(readFileSync(join(directory, 'draft.json'), 'utf8'));
    expect(packet.artifact.parameters.stage).toBe('blinded-pilot');
    expect(packet.runs).toHaveLength(120);
    expect(packet.claimBoundary).toContain('Draft E03 qualification artifact only');
  });

  it('rejects a resource policy that permits external spending', () => {
    const { directory, receiptPath } = fixture();
    const resourcePath = join(directory, 'invalid-resource-policy.json');
    const resource = JSON.parse(readFileSync(join(root,
      'protocols/seed-and-resource-allocation.v1.json'), 'utf8'));
    resource.localCeiling.externalSpend = 1;
    writeFileSync(resourcePath, JSON.stringify(resource));
    const result = run(receiptPath, directory, resourcePath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('zero-spend resource allocation policy');
  });
});
