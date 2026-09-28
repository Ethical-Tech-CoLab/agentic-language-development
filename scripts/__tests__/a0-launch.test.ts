import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const launchCli = fileURLToPath(new URL('../a0-launch.mjs', import.meta.url));
const leaseCli = fileURLToPath(new URL('../a0-lease.mjs', import.meta.url));
const DIR = join(root, '.artifacts/a0-leases');
const ACTIVE = join(DIR, 'active.json');
const OWNER = 'a0-launch-test';
const SOURCE = 'a0-launch-test-source';

// Every test launches a real transient scope with a trivial payload and
// skips rather than disturb an operator-held lease.
// Known gap: receipt-stale-between-acquire-and-launch is not covered here
// (it would need a 10-minute wait); the launcher rechecks freshness with the
// same code path the lease uses at acquire time.
afterEach(() => {
  try {
    const active = JSON.parse(readFileSync(ACTIVE, 'utf8'));
    if (active.owner === OWNER) {
      spawnSync(process.execPath, [leaseCli, 'release', '--owner', OWNER, '--reason', 'test cleanup'], { cwd: root, encoding: 'utf8' });
    }
  } catch {
    // No lease file, or not ours: leave it alone.
  }
  rmSync(join(DIR, 'test-launch-receipt.json'), { force: true });
  rmSync(join(DIR, 'test-launch-health.json'), { force: true });
});

const activeLeaseExists = (): boolean => {
  try {
    JSON.parse(readFileSync(ACTIVE, 'utf8'));
    return true;
  } catch {
    return false;
  }
};
const writeHealth = (): string => {
  const path = join(DIR, 'test-launch-health.json');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ healthy: true, at: new Date().toISOString(), source: 'launch-test' })}\n`);
  return path;
};
// A synthetic admitting receipt bound to this exact job. The launcher checks
// binding/hash/freshness; measurement quality is the preflight's own job.
const writeReceipt = (command: string, healthFile: string): string => {
  const path = join(DIR, 'test-launch-receipt.json');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    admission: 'admit',
    at: new Date().toISOString(),
    policyRev: 2,
    task: 'launch-test',
    command,
    source: SOURCE,
    declaredPeakBytes: 805306368,
    dataPath: root,
    diskHeavy: false,
    healthFile,
    healthMaxAgeSec: 300,
    io: { ioReady: false },
  })}\n`);
  return path;
};
const acquire = (command: string, timeout: string): Record<string, unknown> => {
  const receipt = writeReceipt(command, writeHealth());
  const created = spawnSync(
    process.execPath,
    [leaseCli, 'create', '--owner', OWNER, '--task', 'launch-test', '--command', command,
      '--preflight', receipt, '--timeout', timeout, '--source', SOURCE, '--data-path', root],
    { cwd: root, encoding: 'utf8' },
  );
  expect(created.status).toBe(0);
  return JSON.parse(created.stdout);
};
const unitGone = (unit: string): boolean => {
  try {
    execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
};
const releasedRecordFor = (id: string): Record<string, unknown> => {
  const files = readdirSync(DIR).filter((f) => f.startsWith('released-'));
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    if (record.id === id) return record;
  }
  throw new Error(`no released record for ${id}`);
};

describe('A0 job launcher', () => {
  it('runs a trivial job to completion and cleans up the unit', () => {
    if (activeLeaseExists()) return;
    const lease = acquire('true', '60');
    const launched = spawnSync(process.execPath, [launchCli, '--owner', OWNER, '--sample-sec', '1'], { cwd: root, encoding: 'utf8' });
    expect(launched.status).toBe(0);
    expect(JSON.parse(launched.stdout).outcome).toBe('completed');
    expect(existsSync(ACTIVE)).toBe(false);
    expect(unitGone(lease.unit as string)).toBe(true);
    const record = releasedRecordFor(lease.id as string);
    expect(record.outcome).toBe('completed');
    expect(record.exitCode).toBe(0);
  });

  it('enforces the deadline and verifies launch readbacks on a live job', () => {
    if (activeLeaseExists()) return;
    const lease = acquire('sleep 30', '3');
    const launched = spawnSync(process.execPath, [launchCli, '--owner', OWNER, '--sample-sec', '1'], { cwd: root, encoding: 'utf8' });
    expect(launched.status).toBe(124);
    expect(JSON.parse(launched.stdout).outcome).toBe('timeout');
    expect(existsSync(ACTIVE)).toBe(false);
    expect(unitGone(lease.unit as string)).toBe(true);
    const record = releasedRecordFor(lease.id as string);
    expect(record.outcome).toBe('timeout');
    expect(record.membersVerified).toBe(true);
    expect(record.readbackVerified).toBe(true);
    const roles = ((record.members ?? []) as Array<{ role: string }>).map((m) => m.role).sort();
    expect(roles).toEqual(['launcher', 'payload']);
  });

  it('propagates a failing payload exit code without supervisor error', () => {
    if (activeLeaseExists()) return;
    const lease = acquire('false', '60');
    const launched = spawnSync(process.execPath, [launchCli, '--owner', OWNER, '--sample-sec', '1'], { cwd: root, encoding: 'utf8' });
    expect(launched.status).toBe(1);
    const done = JSON.parse(launched.stdout);
    expect(done.outcome).toBe('completed');
    expect(done.exitCode).toBe(1);
    expect(existsSync(ACTIVE)).toBe(false);
    expect(unitGone(lease.unit as string)).toBe(true);
  });

  it('refuses a non-owner without touching the lease', () => {
    if (activeLeaseExists()) return;
    acquire('true', '60');
    const before = readFileSync(ACTIVE, 'utf8');
    const launched = spawnSync(process.execPath, [launchCli, '--owner', 'intruder'], { cwd: root, encoding: 'utf8' });
    expect(launched.status).toBe(2);
    expect(launched.stderr).toContain('owning');
    expect(readFileSync(ACTIVE, 'utf8')).toBe(before);
  });

  it('refuses to launch when the bound receipt changed after acquisition', () => {
    if (activeLeaseExists()) return;
    acquire('true', '60');
    writeFileSync(join(DIR, 'test-launch-receipt.json'), 'tampered', { flag: 'a' });
    const launched = spawnSync(process.execPath, [launchCli, '--owner', OWNER], { cwd: root, encoding: 'utf8' });
    expect(launched.status).toBe(2);
    expect(launched.stderr).toContain('hash mismatch');
    expect(JSON.parse(readFileSync(ACTIVE, 'utf8')).status).toBe('acquired');
  });
});
