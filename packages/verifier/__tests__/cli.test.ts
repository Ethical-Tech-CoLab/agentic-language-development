/**
 * `ald-verify` CLI (BACKLOG ALD-015 criterion 1): runs against an exported
 * bundle with no shared process state with the server, prints a compact human
 * summary or the machine-readable report, and exits with
 * `VerificationReport.exitCode`.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { VerificationReportSchema } from '@ald/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { USAGE, parseArgs, runCli } from '@ald/verifier';

import { buildFixtureBundle, type BuiltBundle } from './fixtures/build-bundle.js';
import { copyBundle, mutateJsonl, readJsonFile } from './helpers.js';

const run = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '..', '..');
const binary = join(packageDir, 'bin', 'ald-verify.js');

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawnCli(args: readonly string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await run('node', [binary, ...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

let fixture: BuiltBundle;

beforeAll(async () => {
  fixture = await buildFixtureBundle();
  try {
    await run('npx', ['tsc', '--build', 'packages/verifier'], { cwd: repoRoot });
  } catch (error) {
    // A concurrently edited dependency must not hide an existing build.
    await access(join(packageDir, 'dist', 'cli.js')).catch(() => {
      throw error;
    });
  }
}, 180_000);

afterAll(async () => {
  await fixture.cleanup();
});

describe('ald-verify', () => {
  it('exits 0 on the unchanged bundle and prints one line per check', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      const result = await spawnCli([copy.dir, '--verifier-version', 'cli-test']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('PASS canonicalJsonValid');
      expect(result.stdout).toContain('PASS merkleRootsRebuilt');
      expect(result.stdout).toContain('none unanchoredTailReported');
      expect(result.stdout).toContain('exit      0');
      // ALD-017: the report is persisted next to the bundle it describes.
      const report = await readJsonFile<unknown>(
        join(copy.dir, 'verification-report.json'),
      );
      expect(VerificationReportSchema.parse(report).verifierVersion).toBe(
        'cli-test',
      );
    } finally {
      await copy.cleanup();
    }
  }, 60_000);

  it('exits 1 and prints the report as JSON for a mutated bundle', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      await mutateJsonl(join(copy.dir, 'channel-transcript.jsonl'), (events) => {
        const event = events[1];
        if (event === undefined) {
          throw new Error('fixture must have a second channel event');
        }
        event['turn'] = 999;
      });

      const result = await spawnCli([copy.dir, '--json']);
      const report = VerificationReportSchema.parse(JSON.parse(result.stdout));

      expect(result.code).toBe(1);
      expect(report.exitCode).toBe(1);
      expect(report.checks.entryHashesRebuilt).toBe(false);
    } finally {
      await copy.cleanup();
    }
  }, 60_000);
});

describe('CLI argument parsing', () => {
  it('parses every documented flag', () => {
    const parsed = parseArgs([
      '/tmp/bundle',
      '--rpc-url',
      'https://example.invalid',
      '--chain-id',
      '84532',
      '--parent-bundle',
      '/tmp/parent-bundle',
      '--allow-unanchored',
      '--json',
      '--verifier-version',
      '9.9.9',
      '--no-report',
    ]);

    expect(parsed).toEqual({
      ok: true,
      options: {
        bundleDir: '/tmp/bundle',
        rpcUrl: 'https://example.invalid',
        chainId: 84_532,
        parentBundleDir: '/tmp/parent-bundle',
        allowUnanchored: true,
        json: true,
        verifierVersion: '9.9.9',
        writeReport: false,
      },
    });
  });

  it('requires a bundle directory and rejects unknown options', () => {
    expect(parseArgs([])).toEqual({
      ok: false,
      message: 'a bundle directory is required',
    });
    expect(parseArgs(['/tmp/bundle', '--nope'])).toEqual({
      ok: false,
      message: 'unknown option --nope',
    });
    expect(parseArgs(['/tmp/bundle', '--chain-id'])).toEqual({
      ok: false,
      message: '--chain-id requires a value',
    });
  });

  it('rejects an empty --verifier-version instead of throwing a ZodError', async () => {
    expect(parseArgs(['/tmp/bundle', '--verifier-version', ''])).toEqual({
      ok: false,
      message: '--verifier-version requires a value',
    });

    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([fixture.bundleDir, '--verifier-version', ''], {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('--verifier-version requires a value');
    expect(err.join('')).toContain(USAGE);
  });

  it('prints usage for --help without verifying anything', async () => {
    const lines: string[] = [];
    const code = await runCli(['--help'], {
      stdout: (text) => lines.push(text),
      stderr: (text) => lines.push(text),
    });

    expect(code).toBe(0);
    expect(lines.join('')).toContain(USAGE);
  });

  it('reports usage on stderr and exits 1 for a bad invocation', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([], {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('a bundle directory is required');
  });
});
