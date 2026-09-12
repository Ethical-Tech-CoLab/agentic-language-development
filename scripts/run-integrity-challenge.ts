import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { verifyBundle } from '../packages/verifier/src/index.js';

import {
  buildFixtureBundle,
  type BuiltBundle,
} from '../packages/verifier/__tests__/fixtures/build-bundle.js';
import {
  appendSignedLedgerEvent,
  checkpointFile,
  copyBundle,
  foreignSignature,
  mutateJsonFile,
  mutateJsonl,
  readJsonFile,
  readJsonl,
  writeJsonl,
} from '../packages/verifier/__tests__/helpers.js';

const execFileAsync = promisify(execFile);
const AUDITOR =
  process.env['ALD_INTEGRITY_AUDITOR'] ??
  join(process.cwd(), '.artifacts/cargo-target/release/ald-integrity-auditor');
const OPTIONS = {
  verifierVersion: 'integrity-challenge-v2',
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

interface RegisteredSlot {
  slot: number;
  scenario: string;
}

interface RegisteredAnalysisVersion {
  protocolPath: string;
  protocolSha256: string;
}

const REGISTRATION_PATH = 'protocols/e00-registration.v4.json';
const BINDING_PATH = 'protocols/e00-registration-binding.v3.json';
const EVIDENCE_ROOT = 'evidence/qualification/e00-v4';
const DEFAULT_OUTPUT = 'reports/research/e00-integrity-qualification-receipt.json';
const MUTATION_CASES = [
  'event-content',
  'deleted-middle-event',
  'inserted-event',
  'reordered-events',
  'foreign-writer-signature',
  'modified-merkle-proof',
  'wrong-chain',
  'simulated-class-relabel',
  'false-receipt-payload',
  'unanchored-tail',
  'inconsistent-checkpoint-prefix',
] as const;

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists at ${path}; refusing to overwrite a prior attempt`);
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
  const status = await execFileAsync('git', ['status', '--porcelain']);
  if (status.stdout.trim() !== '') {
    throw new Error('E00 qualification requires an exact clean execution commit');
  }
  const registration = JSON.parse(
    await readFile(REGISTRATION_PATH, 'utf8'),
  ) as {
    preRegistrationHash: string;
    artifact: { bindings: Array<{ key: string; content: unknown }> };
  };
  const binding = JSON.parse(
    await readFile(BINDING_PATH, 'utf8'),
  ) as {
    preRegistrationHash: string;
    preRunAnchor?: { anchorClass: string; inputData: string; status: string };
  };
  if (
    binding.preRegistrationHash !== registration.preRegistrationHash ||
    binding.preRunAnchor?.anchorClass !== 'simulated' ||
    binding.preRunAnchor.status !== 'confirmed' ||
    binding.preRunAnchor.inputData !== `0x${registration.preRegistrationHash.slice(7)}`
  ) {
    throw new Error('E00 registration binding is absent, mismatched, or unconfirmed');
  }
  const seedBinding = registration.artifact.bindings.find(
    (entry) => entry.key === 'selectedSeedPrefix',
  )?.content as { primary?: RegisteredSlot[] } | undefined;
  const slots = seedBinding?.primary;
  if (slots?.length !== 5) throw new Error('E00 registration must contain five slots');
  const analysisVersions = registration.artifact.bindings.find(
    (entry) => entry.key === 'analysisVersions',
  )?.content as RegisteredAnalysisVersion[] | undefined;
  if (analysisVersions === undefined || analysisVersions.length !== 2) {
    throw new Error('E00 registration must bind both verifier protocols');
  }
  for (const version of analysisVersions) {
    const protocol = await readFile(version.protocolPath);
    const actual = createHash('sha256').update(protocol).digest('hex');
    if (actual !== version.protocolSha256) {
      throw new Error(`registered protocol changed: ${version.protocolPath}`);
    }
  }
  const policy = registration.artifact.bindings.find(
    (entry) => entry.key === 'evidenceAndAnchorPolicy',
  )?.content as { mutationCases?: string[]; retainedEvidencePath?: string } | undefined;
  if (
    JSON.stringify(policy?.mutationCases) !== JSON.stringify(MUTATION_CASES) ||
    policy?.retainedEvidencePath !== 'evidence/qualification/e00-v4/<runId>'
  ) {
    throw new Error('registered E00 mutation or evidence-retention policy is mismatched');
  }
  const outputPath = process.env['ALD_INTEGRITY_CHALLENGE_OUTPUT'] ?? DEFAULT_OUTPUT;
  await assertAbsent(EVIDENCE_ROOT, 'E00 retained-evidence root');
  await assertAbsent(outputPath, 'E00 qualification receipt');
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const executionCommit = await execFileAsync('git', ['rev-parse', 'HEAD']);
  const slotResults: Array<{
    slot: number;
    scenarioSeed: string;
    runId: string;
    eventCount: number;
    checkpointCount: number;
    babyLedgerEvents: { babyA: number; babyB: number };
    anchored: boolean;
    commitmentPayloadsOnly32ByteHashes: boolean;
    wallMilliseconds: number;
    cases: ChallengeResult[];
    allDispositionsMatched: boolean;
    retainedBundle: string;
  }> = [];
  for (const registeredSlot of slots) {
    const started = performance.now();
    const fixture = await buildFixtureBundle({
      attachment: true,
      turns: 100,
      runId: `run-e00-qualified-${String(registeredSlot.slot).padStart(2, '0')}`,
      randomSeed: registeredSlot.scenario,
    });
    const retainedBundle = join(EVIDENCE_ROOT, fixture.runId);
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
      await mutateCase(fixture, 'deleted-middle-event', async (dir) => {
        await mutateJsonl(join(dir, 'baby-a-ledger.jsonl'), (events) => {
          events.splice(49, 1);
        });
      }),
    );

    results.push(
      await mutateCase(fixture, 'inserted-event', async (dir) => {
        await mutateJsonl(join(dir, 'baby-a-ledger.jsonl'), (events) => {
          const event = events[49];
          if (event === undefined) throw new Error('fixture lacks event 50');
          events.splice(50, 0, { ...event, content: { artifactRef: 'proposal:inserted' } });
        });
      }),
    );

    results.push(
      await mutateCase(fixture, 'reordered-events', async (dir) => {
        await mutateJsonl(join(dir, 'baby-a-ledger.jsonl'), (events) => {
          const left = events[49];
          const right = events[50];
          if (left === undefined || right === undefined) throw new Error('fixture lacks events 50-51');
          events[49] = right;
          events[50] = left;
        });
      }),
    );

    results.push(
      await mutateCase(fixture, 'foreign-writer-signature', async (dir) => {
        const path = join(dir, 'baby-a-ledger.jsonl');
        const ledger = await readJsonl(path);
        const event = ledger[49];
        if (event === undefined) throw new Error('fixture lacks event 50');
        event['writerSignature'] = await foreignSignature(String(event['entryHash']));
        await writeJsonl(path, ledger);
      }),
    );

    results.push(
      await mutateCase(fixture, 'modified-merkle-proof', async (dir) => {
        await mutateJsonFile<{ path: string[] }>(
          join(dir, 'proofs', 'inclusion', 'babyA-1-at-2.json'),
          (proof) => {
            proof.path[0] = `sha256:${'0'.repeat(64)}`;
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
      await mutateCase(fixture, 'simulated-class-relabel', async (dir) => {
        await mutateJsonFile<Record<string, unknown>[]>(
          join(dir, 'anchors/base-receipts.json'),
          (receipts) => {
            const receipt = receipts[0];
            if (receipt === undefined) throw new Error('fixture lacks receipt');
            receipt['anchorClass'] = 'public-chain';
          },
        );
      }),
    );

    results.push(
      await mutateCase(fixture, 'false-receipt-payload', async (dir) => {
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

    results.push(
      await mutateCase(fixture, 'inconsistent-checkpoint-prefix', async (dir) => {
        await mutateJsonFile<Record<string, unknown>>(
          checkpointFile(dir, 1),
          (checkpoint) => {
            const babyA = checkpoint['babyA'] as Record<string, unknown>;
            babyA['merkleRoot'] = `sha256:${'0'.repeat(64)}`;
          },
        );
      }),
    );

      const observedMutationCases = results.slice(1).map((result) => result.case);
      if (JSON.stringify(observedMutationCases) !== JSON.stringify(MUTATION_CASES)) {
        throw new Error('executed mutation cases differ from the registered order');
      }

      const [fixtureAudit, babyAEvents, babyBEvents, receipts] = await Promise.all([
        rustAudit(fixture.bundleDir),
        readJsonl(join(fixture.bundleDir, 'baby-a-ledger.jsonl')),
        readJsonl(join(fixture.bundleDir, 'baby-b-ledger.jsonl')),
        readJsonFile<Array<{ inputData: string }>>(
          join(fixture.bundleDir, 'anchors', 'base-receipts.json'),
        ),
      ]);
      slotResults.push({
        slot: registeredSlot.slot,
        scenarioSeed: registeredSlot.scenario,
        runId: fixture.runId,
        eventCount: fixtureAudit.eventCount,
        checkpointCount: fixture.checkpoints.length,
        babyLedgerEvents: { babyA: babyAEvents.length, babyB: babyBEvents.length },
        anchored: fixtureAudit.anchored,
        commitmentPayloadsOnly32ByteHashes: receipts.every((receipt) =>
          /^0x[a-f0-9]{64}$/u.test(receipt.inputData),
        ),
        wallMilliseconds: performance.now() - started,
        cases: results,
        allDispositionsMatched: results.every(
          (result) =>
            result.verifierPass === result.expectedPass &&
            result.auditorPass === result.expectedPass,
        ),
        retainedBundle,
      });
    } finally {
      try {
        await cp(fixture.bundleDir, retainedBundle, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } finally {
        await fixture.cleanup();
      }
    }
  }
  await execFileAsync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      'packages/ops/__tests__/snapshot.test.ts',
      'packages/evidence/__tests__/recovery.test.ts',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const output = {
      schemaVersion: 2,
      classification: 'prospectively-registered-software-qualification',
      researchFinding: false,
      experimentId: 'E00',
      registrationHash: registration.preRegistrationHash,
      registrationBinding: BINDING_PATH,
      executionCommit: executionCommit.stdout.trim(),
      fixture: {
        slots: slotResults.length,
        turnsPerSlot: 100,
        minimumBabyLedgerEventsPerSlot: 100,
        minimumCheckpointsPerSlot: 3,
      },
      implementations: [
        'typescript-production-verifier',
        'rust-independent-integrity-auditor',
      ],
      slots: slotResults,
      restoreExtensionQualification: {
        passed: true,
        testFiles: [
          'packages/ops/__tests__/snapshot.test.ts',
          'packages/evidence/__tests__/recovery.test.ts',
        ],
        interpretation: 'First-party recovery, prefix, corruption, and post-restore sequence-extension checks passed on the execution commit.',
      },
      allDispositionsMatched: slotResults.every((slot) => slot.allDispositionsMatched),
      claimBoundary: 'E00 integrity qualification only; this is not an agent-language outcome, public-chain result, independent replication, or independent human review.',
    };
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    await writeFile(outputPath, serialized, 'utf8');
    process.stdout.write(serialized);
    if (!output.allDispositionsMatched) {
      throw new Error(`E00 qualification failed; receipt retained at ${outputPath}`);
    }
}

await main();
