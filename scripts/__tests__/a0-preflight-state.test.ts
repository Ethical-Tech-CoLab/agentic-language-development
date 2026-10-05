import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../a0-preflight.mjs', import.meta.url));
// Own sandbox dir: this file runs in parallel with a0-preflight.test.ts and
// each file's afterEach wipes its own TDIR, so the dirs must not be shared.
const TDIR = join(root, '.artifacts/a0-leases/test-preflight-state');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
// Isolated operator state: temp baseline/history/incident/lease/monitor files
// so these tests never touch or depend on live A0 state.
const iso = (tag: string) => {
  const dir = join(TDIR, tag);
  mkdirSync(dir, { recursive: true });
  return [
    '--baseline-file', join(dir, 'baseline.json'),
    '--history-file', join(dir, 'history.jsonl'),
    '--incident-file', join(dir, 'incident.json'),
    '--monitor-block-file', join(dir, 'monitor-block.json'),
    '--lease-file', join(dir, 'lease.json'),
  ];
};

afterEach(() => {
  rmSync(TDIR, { recursive: true, force: true });
});

describe('A0 admission preflight', () => {
  it('never gates leads on retired agent caps, and records the advisory profile', () => {
    // Pins the rev-5 contract on this host (caps cleared): no fixed-limit
    // mismatch reasons may appear, and the receipt must state explicitly
    // that no agent caps were enforced.
    const out = run('--window-sec', '5', '--interval-sec', '5', '--task', 't', '--command', 'c', ...iso('nocaps'));
    const receipt = JSON.parse(out.stdout);
    expect(receipt.policyRev).toBe(5);
    expect(receipt.enforcement.agentCapsEnforced).toBe(false);
    expect(receipt.reasons.join('\n')).not.toContain('!= policy');
  });

  it('refuses a declared workload that cannot fit host reserve without a cap', () => {
    // Deterministic on any host: 1.5x a 1-TiB declared peak always exceeds
    // the reserve floor, exercising the cap-free headroom branch.
    const out = run('--window-sec', '5', '--interval-sec', '5', '--declared-peak-bytes', '1099511627776', ...iso('floor'));
    expect(out.status).toBe(1);
    expect(JSON.parse(out.stdout).reasons.join('\n')).toContain('headroom');
  });

  it('treats corrupt lease state as an error, never a measurement', () => {
    const flags = iso('corrupt');
    const leaseFile = flags[flags.indexOf('--lease-file') + 1];
    writeFileSync(leaseFile, 'not-json{{{');
    const out = run('--window-sec', '5', '--interval-sec', '5', ...flags);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('corrupt');
  });

  it('honors the monitor-block marker until the operator clears it', () => {
    const flags = iso('monitor');
    const marker = flags[flags.indexOf('--monitor-block-file') + 1];
    writeFileSync(marker, `${JSON.stringify({ at: new Date().toISOString(), reason: 'test' })}\n`);
    const blocked = run('--window-sec', '5', '--interval-sec', '5', ...flags);
    expect(JSON.parse(blocked.stdout).reasons.join('\n')).toContain('monitor-block marker');
    rmSync(marker);
    const cleared = run('--window-sec', '5', '--interval-sec', '5', ...flags);
    expect(JSON.parse(cleared.stdout).reasons.join('\n')).not.toContain('monitor-block marker');
  });

  it('reconciles only a matching incident with no new OOM kills', () => {
    const flags = iso('reconcile');
    const incidentFile = flags[flags.indexOf('--incident-file') + 1];
    // Seed live counters from a real probe run.
    const probe = run('--window-sec', '5', '--interval-sec', '5', ...flags);
    const counters = JSON.parse(probe.stdout).oom.counters;
    expect(counters.global).toEqual(expect.any(Number));
    writeFileSync(incidentFile, `${JSON.stringify({ id: 'test-inc', firstSeen: new Date().toISOString(), counters, reconciled: null })}\n`);
    const wrong = run('--reconcile-oom', 'other-id', '--reason', 'test', ...flags);
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('mismatch');
    const noReason = run('--reconcile-oom', 'test-inc', ...flags);
    expect(noReason.status).not.toBe(0);
    const ok = run('--reconcile-oom', 'test-inc', '--reason', 'test ack', ...flags);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).reconciled).toBe('test-inc');
    expect(JSON.parse(readFileSync(incidentFile, 'utf8')).reconciled.reason).toBe('test ack');
    const again = run('--reconcile-oom', 'test-inc', '--reason', 'twice', ...flags);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('already reconciled');
    // Stale incident counters vs live host must refuse.
    const lower = { ...counters, global: (counters.global as number) - 1 };
    writeFileSync(incidentFile, `${JSON.stringify({ id: 'test-inc2', firstSeen: new Date().toISOString(), counters: lower, reconciled: null })}\n`);
    const refused = run('--reconcile-oom', 'test-inc2', '--reason', 'test', ...flags);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('cannot reconcile');
  });
});
