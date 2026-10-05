import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../a0-preflight.mjs', import.meta.url));
const TDIR = join(root, '.artifacts/a0-leases/test-preflight');
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
  it('rejects invalid inputs with structured errors', () => {
    const cases: string[][] = [
      ['--planned-bytes', 'abc'],
      ['--planned-bytes', '12x'],
      ['--declared-peak-bytes', 'NaN'],
      ['--declared-peak-bytes', '-1'],
      ['--declared-peak-bytes', 'abc'],
      ['--disk-heavy', 'sometimes'],
      ['--window-sec', '3'],
      ['--window-sec', 'abc'],
      ['--interval-sec', '0'],
      ['--window-sec', '60', '--interval-sec', '61'],
      ['--health-max-age-sec', '0'],
    ];
    for (const args of cases) {
      const out = run(...args, ...iso('invalid'));
      expect(out.status, args.join(' ')).toBe(2);
      expect(JSON.parse(out.stderr).admission).toBe('error');
    }
  });

  it('never admits on a diagnostic short window', () => {
    const out = run('--window-sec', '5', '--interval-sec', '5', '--task', 't', '--command', 'c', ...iso('diagnostic'));
    expect(out.status).toBe(1);
    const receipt = JSON.parse(out.stdout);
    expect(receipt.admission).toBe('diagnostic');
    expect(receipt.diagnostic).toBe(true);
    expect(receipt.reasons.join('\n')).toContain('diagnostic-only');
    expect(receipt.policyRev).toBe(5);
    expect(receipt.task).toBe('t');
    expect(receipt.command).toBe('c');
    expect(typeof receipt.source).toBe('string');
    expect(receipt.host.samplesTotal).toBe(1);
    expect(Object.keys(receipt.host.samplesValid).sort()).toEqual(['cpu', 'load', 'mem', 'psi']);
    for (const count of Object.values(receipt.host.samplesValid) as number[]) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  it('establishes the OOM baseline on first run, then requires quiet history', () => {
    const flags = ['--window-sec', '5', '--interval-sec', '5', ...iso('baseline')];
    const first = run(...flags);
    expect(first.status).toBe(1);
    expect(JSON.parse(first.stdout).reasons.join('\n')).toContain('no OOM baseline');
    const second = run(...flags);
    const receipt = JSON.parse(second.stdout);
    expect(receipt.reasons.join('\n')).not.toContain('no OOM baseline');
    expect(receipt.reasons.join('\n')).toContain('insufficient OOM history');
    expect(receipt.oom.baselineCompared).toBe(true);
  });

  it('gates on bound production-health evidence', () => {
    const flags = ['--window-sec', '5', '--interval-sec', '5', ...iso('health')];
    const unbound = run(...flags);
    expect(JSON.parse(unbound.stdout).reasons.join('\n')).toContain('no production-health evidence bound');
    const healthFile = join(TDIR, 'health', 'health.json');
    mkdirSync(join(TDIR, 'health'), { recursive: true });
    writeFileSync(healthFile, `${JSON.stringify({ healthy: true, at: new Date().toISOString(), source: 'test' })}\n`);
    const bound = run(...flags, '--health-file', healthFile);
    expect(JSON.parse(bound.stdout).reasons.join('\n')).not.toContain('health');
    writeFileSync(healthFile, `${JSON.stringify({ healthy: false, at: new Date().toISOString(), source: 'test' })}\n`);
    const failing = run(...flags, '--health-file', healthFile);
    expect(JSON.parse(failing.stdout).reasons.join('\n')).toContain('does not report healthy');
  });

  it('blocks disk-heavy work without delegated I/O controls', () => {
    // Pins the observed host contract (user slice exposes cpu/memory/pids,
    // no io). If io is ever delegated, this failure forces deliberate
    // re-qualification of the disk-heavy path instead of silent admission.
    const out = run('--window-sec', '5', '--interval-sec', '5', '--disk-heavy', 'yes', ...iso('io'));
    const receipt = JSON.parse(out.stdout);
    expect(receipt.io.ioSupported).toBe(false);
    expect(receipt.io.ioReady).toBe(false);
    expect(receipt.reasons.join('\n')).toContain('disk-heavy');
  });

  // NOTE: remaining 5 tests (caps/floor/corrupt/monitor/reconcile) moved to
  // a0-preflight-state.test.ts (R9-F P5 split; own TDIR sandbox per file).
});
