#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const protocolPath = 'protocols/causal-prediction-runtime-qualification.v1.json';
const receiptPath = 'reports/research/causal-prediction-runtime-qualification-receipt.json';
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

interface Protocol {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  candidate: { commit: string; version: string };
  sourceHashes: Record<string, string>;
  expected: {
    eligibleTurnRule: string;
    committedEvaluationTurns: number;
    scoredAttachments: number;
    runConfigBindings: string[];
    failClosedCases: string[];
  };
  exactValidation: Record<string, unknown> & {
    focusedTestFiles: number;
    focusedTests: number;
    testFiles: number;
    tests: number;
    rustTests: number;
    secretFilesScanned: number;
    consolidatedWallSeconds: number;
    consolidatedMaximumResidentSetKiB: number;
  };
  rawEvidence: Record<string, unknown> & {
    directory: string;
    installLogSha256: string;
    focusedLogSha256: string;
    checkLogSha256: string;
    cleanStatusSha256: string;
  };
  boundary: string;
}

const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes.toString('utf8')) as Protocol;
for (const [path, expected] of Object.entries(protocol.sourceHashes)) {
  const candidateBytes = execFileSync(
    'git',
    ['show', `${protocol.candidate.commit}:${path}`],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  if (sha256(candidateBytes) !== expected) {
    throw new Error(`${path} differs from the source at the exact qualified candidate`);
  }
}
if (protocol.expected.eligibleTurnRule !== 'accepted-evaluation-deliveries') {
  throw new Error('unexpected causal prediction eligibility rule');
}
if (protocol.expected.committedEvaluationTurns !== 3 || protocol.expected.scoredAttachments !== 3) {
  throw new Error('unexpected exact causal prediction evidence counts');
}
if (protocol.expected.runConfigBindings.join('|') !== 'selectionCommitmentHash|predictionFunctionVersion|eligibleTurns') {
  throw new Error('RunConfig causal prediction bindings are incomplete');
}
if (protocol.expected.failClosedCases.length !== 7) {
  throw new Error('fail-closed causal prediction cases are incomplete');
}

if (process.argv.includes('--live-evidence')) {
  const raw = protocol.rawEvidence;
  const files = {
    install: `${raw.directory}/install.log`,
    focused: `${raw.directory}/focused.log`,
    check: `${raw.directory}/full-check.log`,
    clean: `${raw.directory}/worktree-status.txt`,
  };
  for (const [kind, path] of Object.entries(files)) {
    const expected = kind === 'install'
      ? raw.installLogSha256
      : kind === 'focused'
        ? raw.focusedLogSha256
        : kind === 'check'
          ? raw.checkLogSha256
          : raw.cleanStatusSha256;
    if (sha256(readFileSync(path)) !== expected) throw new Error(`${kind} evidence hash mismatch`);
  }
  const install = readFileSync(files.install, 'utf8');
  const focused = readFileSync(files.focused, 'utf8');
  const check = readFileSync(files.check, 'utf8');
  const clean = readFileSync(files.clean, 'utf8');
  for (const required of ['Done in', 'using pnpm v12.3.4', 'Exit status: 0']) {
    if (!install.includes(required)) throw new Error(`install evidence lacks ${required}`);
  }
  for (const required of [
    `Test Files  ${String(protocol.exactValidation.focusedTestFiles)} passed`,
    `Tests  ${String(protocol.exactValidation.focusedTests)} passed`,
    'Exit status: 0',
  ]) {
    if (!focused.includes(required)) throw new Error(`focused evidence lacks ${required}`);
  }
  for (const required of [
    `Test Files  ${String(protocol.exactValidation.testFiles)} passed`,
    `Tests  ${String(protocol.exactValidation.tests)} passed`,
    `running ${String(protocol.exactValidation.rustTests)} tests`,
    `Secret scan passed for ${String(protocol.exactValidation.secretFilesScanned)} files.`,
    'No known vulnerabilities found',
    `Elapsed (wall clock) time (h:mm:ss or m:ss): 3:03.69`,
    `Maximum resident set size (kbytes): ${String(protocol.exactValidation.consolidatedMaximumResidentSetKiB)}`,
    'Exit status: 0',
  ]) {
    if (!check.includes(required)) throw new Error(`full-check evidence lacks ${required}`);
  }
  if (clean.length !== 0) throw new Error('exact validation worktree was not clean');
}

const receipt = {
  schemaVersion: protocol.schemaVersion,
  classification: protocol.classification,
  researchFinding: protocol.researchFinding,
  capturedAt: '2026-09-11',
  protocolSha256: sha256(protocolBytes),
  candidate: protocol.candidate,
  sourceHashes: protocol.sourceHashes,
  qualifiedBehavior: protocol.expected,
  exactValidation: {
    ...protocol.exactValidation,
    detachedWorktree: true,
    worktreeCleanAfterValidation: true,
    frozenInstallExitCode: 0,
    focusedExitCode: 0,
    consolidatedExitCode: 0
  },
  rawEvidence: protocol.rawEvidence,
  blockerDisposition: {
    blocker: 'B10',
    status: 'open',
    completed: 'exact production chronology, immutable provider-identity and eligibility binding, fail-closed creation/recovery, and source-bound per-turn scores',
    remains: 'repository registration of the exact validation corpus and eligible E16 configuration, prospective study execution, untouched aggregate scoring, and independent review'
  },
  boundary: protocol.boundary
};
const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(receiptPath, rendered);
  console.log(`wrote ${receiptPath}`);
} else if (readFileSync(receiptPath, 'utf8') !== rendered) {
  throw new Error('causal prediction runtime qualification receipt is stale; run pnpm run qualify:causal-prediction-runtime');
}
console.log(`causal prediction runtime qualification valid: ${String(protocol.expected.committedEvaluationTurns)} commitments, ${String(protocol.expected.scoredAttachments)} scores, ${String(protocol.expected.failClosedCases.length)} fail-closed cases`);
