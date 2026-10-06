/**
 * R10-C-M10: direct unit pins for the pending sidecar (packages/anchor/src/pending.ts).
 * Landed post-M9-ship (was held to avoid pack mixing).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  randomUUID: () => 'deadbeef-dead-beef-dead-beefdeadbeef',
}));

import {
  PENDING_FILE_MODE,
  PendingFileInvalidError,
  addPendingSubmission,
  readPendingSubmissions,
  writePendingSubmissions,
  type PendingAnchorSubmission,
} from '../src/index.js';

const DIRS: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ald-pending-m10-'));
  DIRS.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function submission(overrides: Partial<PendingAnchorSubmission> = {}): PendingAnchorSubmission {
  return {
    version: 1,
    runId: 'run-1',
    checkpointSequence: 7,
    checkpointHash: `sha256:${'ab'.repeat(32)}`,
    anchorClass: 'simulated',
    network: 'base-sepolia',
    chainId: 84532,
    transactionHash: `0x${'cd'.repeat(32)}`,
    from: `0x${'11'.repeat(20)}`,
    to: `0x${'22'.repeat(20)}`,
    inputData: `0x${'ef'.repeat(32)}`,
    finalityPolicy: '1-confirmation',
    rpcEndpointLabel: 'test',
    submittedAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('pending sidecar M10 pins', () => {
  it('R10-C-M10 K1: addPendingSubmission dedups hash case-insensitively', () => {
    const path = join(makeDir(), 'pending.json');
    const lower = submission();
    const upper = submission({ transactionHash: lower.transactionHash.toUpperCase() });
    addPendingSubmission(path, lower);
    addPendingSubmission(path, upper);
    expect(readPendingSubmissions(path)).toHaveLength(1);
  });

  it('R10-C-M10 K3: write refuses a planted temp path (O_EXCL)', () => {
    const dir = makeDir();
    const path = join(dir, 'pending.json');
    const canary = join(dir, 'canary.txt');
    writeFileSync(canary, 'untouched');
    const tempName = `${path}.${process.pid}.deadbeef-dead-beef-dead-beefdeadbeef.tmp`;
    symlinkSync(canary, tempName);
    expect(() => writePendingSubmissions(path, [submission()])).toThrowError(PendingFileInvalidError);
    expect(readFileSync(canary, 'utf8')).toBe('untouched');
  });

  it('R10-C-M10 K4: sidecar mode is enforced 0600 regardless of umask', () => {
    const path = join(makeDir(), 'pending.json');
    // 0600 creation masked by 0777 yields 0000, so only the explicit chmod saves the mode.
    const previous = process.umask(0o777);
    try {
      writePendingSubmissions(path, [submission()]);
    } finally {
      process.umask(previous);
    }
    expect(statSync(path).mode & 0o777).toBe(PENDING_FILE_MODE);
  });

  it('R10-C-M10 K8: negative checkpointSequence is rejected', () => {
    const path = join(makeDir(), 'pending.json');
    writeFileSync(path, JSON.stringify({ version: 1, submissions: [submission({ checkpointSequence: -1 })] }));
    expect(() => readPendingSubmissions(path)).toThrowError(PendingFileInvalidError);
  });

  it('R10-C-M17 V2: zero chainId is rejected', () => {
    const path = join(makeDir(), 'pending.json');
    writeFileSync(path, JSON.stringify({ version: 1, submissions: [submission({ chainId: 0 })] }));
    expect(() => readPendingSubmissions(path)).toThrowError(PendingFileInvalidError);
  });
});
