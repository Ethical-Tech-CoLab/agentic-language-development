import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { verifyBundle } from '../packages/verifier/src/index.js';

import {
  buildFixtureBundle,
  type BuiltBundle,
} from '../packages/verifier/__tests__/fixtures/build-bundle.js';
import {
  appendSignedLedgerEvent,
  copyBundle,
  mutateJsonFile,
  mutateJsonl,
  writeJsonFile,
} from '../packages/verifier/__tests__/helpers.js';

const execFileAsync = promisify(execFile);
const AUDITOR =
  process.env['ALD_INTEGRITY_AUDITOR'] ??
  join(process.cwd(), '.artifacts/cargo-target/release/ald-integrity-auditor');
const OPTIONS = {
  verifierVersion: 'integrity-challenge-v1',
  now: () => '2026-09-11T15:00:00.000Z',
  writeReport: false as const,
};

interface RustReport {
  integrityPass: boolean;
  issues: string[];
  eventCount: number;
  checkpointCount: number;
  anchored: boolean;
}

interface ChallengeResult {
  case: string;
  expectedPass: boolean;
  verifierPass: boolean;
  auditorPass: boolean;
  verifierGapCount: number;
  auditorIssueCount: number;
}

async function rustAudit(bundleDir: string): Promise<RustReport> {
  try {
    const { stdout } = await execFileAsync(AUDITOR, [bundleDir], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout) as RustReport;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof error.stdout === 'string'
    ) {
      return JSON.parse(error.stdout) as RustReport;
    }
    throw error;
  }
}

async function inspectCase(
  name: string,
  bundleDir: string,
  expectedPass: boolean,
): Promise<ChallengeResult> {
  const [verifier, auditor] = await Promise.all([
    verifyBundle(bundleDir, OPTIONS),
    rustAudit(bundleDir),
  ]);
  const result = {
    case: name,
    expectedPass,
    verifierPass: verifier.exitCode === 0,
    auditorPass: auditor.integrityPass,
    verifierGapCount: verifier.gaps.length,
    auditorIssueCount: auditor.issues.length,
  };
  if (
    result.verifierPass !== expectedPass ||
    result.auditorPass !== expectedPass
  ) {
    throw new Error(
      `unexpected challenge disposition: ${JSON.stringify({ result, auditorIssues: auditor.issues, verifierGaps: verifier.gaps })}`,
    );
  }
  return result;
}

async function mutateCase(
  fixture: BuiltBundle,
  name: string,
  mutate: (bundleDir: string) => Promise<void>,
): Promise<ChallengeResult> {
  const copy = await copyBundle(fixture.bundleDir);
  try {
    await mutate(copy.dir);
    return await inspectCase(name, copy.dir, false);
  } finally {
    await copy.cleanup();
  }
}

async function main(): Promise<void> {
  const fixture = await buildFixtureBundle({ attachment: true });
  try {
    const results: ChallengeResult[] = [];
    results.push(await inspectCase('unchanged-export', fixture.bundleDir, true));

    results.push(
      await mutateCase(fixture, 'event-content', async (dir) => {
        await mutateJsonl(join(dir, 'baby-a-ledger.jsonl'), (events) => {
          const event = events[2];
          if (event === undefined) throw new Error('fixture lacks event 3');
          event['content'] = { artifactRef: 'proposal:tampered' };
        });
      }),
    );

    results.push(
      await mutateCase(fixture, 'attachment-bytes', async (dir) => {
        await writeJsonFile(
          join(dir, 'analysis/red-team-observation/readiness.json'),
          { status: 'software-readiness', passed: false },
        );
      }),
    );

    results.push(
      await mutateCase(fixture, 'lineage-injection', async (dir) => {
        await mutateJsonFile<Record<string, unknown>>(
          join(dir, 'configuration/run-config.json'),
          (config) => {
            config['parentRunId'] = 'substituted-parent';
          },
        );
      }),
    );

    results.push(
      await mutateCase(fixture, 'wrong-chain', async (dir) => {
        await mutateJsonFile<Record<string, unknown>[]>(
          join(dir, 'anchors/base-receipts.json'),
          (receipts) => {
            const receipt = receipts[0];
            if (receipt === undefined) throw new Error('fixture lacks receipt');
            receipt['chainId'] = 1;
          },
        );
      }),
    );

    results.push(
      await mutateCase(fixture, 'false-receipt', async (dir) => {
        await mutateJsonFile<Record<string, unknown>[]>(
          join(dir, 'anchors/base-receipts.json'),
          (receipts) => {
            const receipt = receipts[0];
            if (receipt === undefined) throw new Error('fixture lacks receipt');
            receipt['inputData'] = `0x${'00'.repeat(32)}`;
          },
        );
      }),
    );

    results.push(
      await mutateCase(fixture, 'unanchored-tail', async (dir) => {
        await appendSignedLedgerEvent(
          dir,
          'baby-a-ledger.jsonl',
          'baby-a-ledger',
          fixture.runId,
          fixture.signerSeeds,
          (previous) => {
            const next = { ...previous };
            delete next['entryHash'];
            delete next['writerSignature'];
            delete next['channelEventHash'];
            next['sequence'] = Number(previous['sequence']) + 1;
            next['turn'] = Number(previous['turn']) + 1;
            next['eventType'] = 'intention.recorded';
            next['content'] = { artifactRef: 'proposal:tail' };
            next['blindingNonce'] = 'nonce-tail';
            next['previousEntryHash'] = previous['entryHash'];
            next['recordedAt'] = '2026-09-11T15:00:00.000Z';
            return next;
          },
        );
      }),
    );

    const output = {
      schemaVersion: 1,
      classification: 'software-qualification',
      researchFinding: false,
      fixture: {
        runId: fixture.runId,
        eventCount: (await rustAudit(fixture.bundleDir)).eventCount,
        checkpointCount: fixture.checkpoints.length,
        anchored: true,
      },
      implementations: [
        'typescript-production-verifier',
        'rust-independent-integrity-auditor',
      ],
      cases: results,
      allDispositionsMatched: results.every(
        (result) =>
          result.verifierPass === result.expectedPass &&
          result.auditorPass === result.expectedPass,
      ),
    };
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    const outputPath = process.env['ALD_INTEGRITY_CHALLENGE_OUTPUT'];
    if (outputPath !== undefined) {
      await writeFile(outputPath, serialized, 'utf8');
    }
    process.stdout.write(serialized);
  } finally {
    await fixture.cleanup();
  }
}

await main();
