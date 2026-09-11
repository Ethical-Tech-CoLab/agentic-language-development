import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SIGNER_DOMAINS } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FORBIDDEN_SIGNER_SEEDS_VALUE_ENV,
  FORT_SIGNER_SEEDS_FILE_ENV,
  signerProviderFromFortEnvironment,
  signerProviderFromFortFile,
} from '../src/fort-signers.js';

function fixture(runId = 'mode-r-fort-fixture'): string {
  return `${JSON.stringify({
    version: 1,
    runs: {
      [runId]: Object.fromEntries(
        SIGNER_DOMAINS.map((domain, index) => [
          domain,
          (index + 1).toString(16).repeat(64),
        ]),
      ),
    },
  })}\n`;
}

describe('Fort signer provider boundary', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  async function seedFile(mode = 0o600): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'ald-fort-signers-'));
    const path = join(root, 'ALD_RUN_SIGNER_SEEDS_JSON');
    await writeFile(path, fixture(), { mode });
    await chmod(path, mode);
    return path;
  }

  it('loads an exact run from a mode-0600 Fort materialization', async () => {
    const path = await seedFile();
    const provider = signerProviderFromFortFile(path);
    const registry = provider('mode-r-fort-fixture');

    expect(registry.runId).toBe('mode-r-fort-fixture');
    expect(registry.domains().sort()).toEqual([...SIGNER_DOMAINS].sort());
    expect(() => provider('another-run')).toThrow(/does not authorize/u);
  });

  it('consumes the file-path variable and refuses a direct secret value', async () => {
    const path = await seedFile();
    const environment: NodeJS.ProcessEnv = {
      [FORT_SIGNER_SEEDS_FILE_ENV]: path,
    };
    const provider = signerProviderFromFortEnvironment(environment);

    expect(environment[FORT_SIGNER_SEEDS_FILE_ENV]).toBeUndefined();
    expect(provider('mode-r-fort-fixture').runId).toBe('mode-r-fort-fixture');
    expect(() =>
      signerProviderFromFortEnvironment({
        [FORBIDDEN_SIGNER_SEEDS_VALUE_ENV]: fixture(),
      }),
    ).toThrow(/direct signer seed environment values are forbidden/u);
  });

  it('rejects permissive files and symbolic links', async () => {
    const path = await seedFile(0o644);
    expect(() => signerProviderFromFortFile(path)).toThrow(/group or other/u);

    await chmod(path, 0o600);
    const link = join(root ?? '', 'seed-link');
    await symlink(path, link);
    expect(() => signerProviderFromFortFile(link)).toThrow(/non-symlink/u);
  });
});
