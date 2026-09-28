import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../a0-lease.mjs', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
const runAsync = (...args: string[]): Promise<{ status: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const DIR = join(root, '.artifacts/a0-leases');
const ACTIVE = join(DIR, 'active.json');
const OWNER = 'a0-lease-test';
const SOURCE = 'a0-lease-test-source';
const DATAPATH = root;
const PEAK = 805306368;

// Never touch a real operator lease: only clean up leases this suite owns.
afterEach(() => {
  try {
    const active = JSON.parse(readFileSync(ACTIVE, 'utf8'));
    if (active.owner === OWNER) {
      const released = run('release', '--owner', OWNER, '--reason', 'test cleanup');
      expect(released.status).toBe(0);
    }
  } catch {
    // No lease file, or not ours: leave it alone.
  }
  rmSync(join(DIR, 'test-preflight.json'), { force: true });
});

const writePreflight = (overrides: Record<string, unknown> = {}): string => {
  const path = join(DIR, 'test-preflight.json');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    admission: 'admit',
    at: new Date().toISOString(),
    policyRev: 2,
    task: 'test',
    command: 'true',
    source: SOURCE,
    declaredPeakBytes: PEAK,
    dataPath: DATAPATH,
    diskHeavy: false,
    healthFile: join(DIR, 'test-health.json'),
    healthMaxAgeSec: 300,
    io: { ioReady: false },
    ...overrides,
  })}\n`);
  return path;
};
const activeLeaseExists = (): boolean => {
  try {
    JSON.parse(readFileSync(ACTIVE, 'utf8'));
    return true;
  } catch {
    return false;
  }
};
const createArgs = (preflight: string, extra: string[] = []): string[] => [
  'create', '--owner', OWNER, '--task', 'test', '--command', 'true',
  '--preflight', preflight, '--timeout', '60',
  '--source', SOURCE, '--data-path', DATAPATH, ...extra,
];

describe('A0 single host-job lease', () => {
  it('refuses show, create, and release with no live state', () => {
    if (activeLeaseExists()) return; // An operator holds the single lease; skip rather than interfere.
    expect(run('show').status).not.toBe(0);
    const created = run(
      'create', '--owner', OWNER, '--task', 'test', '--command', 'true',
      '--preflight', join(DIR, 'does-not-exist.json'), '--timeout', '60',
    );
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain('missing or invalid');
    expect(run('release', '--owner', OWNER).status).not.toBe(0);
  });

  it('creates, excludes a second lease, and releases by owner', () => {
    if (activeLeaseExists()) return;
    const preflight = writePreflight();
    const created = run(...createArgs(preflight));
    expect(created.status).toBe(0);
    const lease = JSON.parse(created.stdout);
    expect(lease.owner).toBe(OWNER);
    expect(lease.source).toBe(SOURCE);
    expect(lease.timeoutSec).toBe(60);
    expect(lease.status).toBe('acquired');
    expect(lease.run).toContain('--slice=aldresearch.slice');
    expect(lease.run).toContain('--property=RuntimeMaxSec=60');
    expect(lease.run.join(' ')).not.toContain('Nice=');
    expect(lease.run.join(' ')).not.toContain('IOSchedulingClass=');
    const shown = run('show');
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).id).toBe(lease.id);
    const second = run(...createArgs(preflight, []));
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('already active');
    expect(run('release', '--owner', 'other').status).not.toBe(0);
    expect(run('release', '--owner', OWNER, '--reason', 'done').status).toBe(0);
    expect(existsSync(ACTIVE)).toBe(false);
  });

  it('grants exactly one owner under concurrent create races', async () => {
    if (activeLeaseExists()) return;
    const preflight = writePreflight();
    const results = await Promise.all(Array.from({ length: 10 }, () => runAsync(...createArgs(preflight))));
    const winners = results.filter((r) => r.status === 0);
    expect(winners.length).toBe(1);
    for (const loser of results.filter((r) => r.status !== 0)) {
      expect(loser.stderr).toContain('already active');
    }
    const active = JSON.parse(readFileSync(ACTIVE, 'utf8'));
    expect(active.owner).toBe(OWNER);
    expect(JSON.parse(winners[0].stdout).id).toBe(active.id);
  });

  it('rejects stray positionals with structured JSON', () => {
    if (activeLeaseExists()) return;
    const created = run('create', 'bogus', '--owner', OWNER);
    expect(created.status).toBe(2);
    expect(JSON.parse(created.stderr).lease).toBe('error');
    expect(created.stderr).toContain('create takes only');
    const released = run('release', 'bogus', '--owner', OWNER);
    expect(released.status).toBe(2);
    expect(JSON.parse(released.stderr).lease).toBe('error');
    expect(released.stderr).toContain('release takes only');
    expect(existsSync(ACTIVE)).toBe(false);
  });

  it('rejects stale and non-admitting preflight receipts', () => {
    if (activeLeaseExists()) return;
    const blocked = writePreflight({ admission: 'block' });
    const refused = run(...createArgs(blocked));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('does not admit');
    const stale = writePreflight({ at: new Date(Date.now() - 3600_000).toISOString() });
    const expired = run(...createArgs(stale));
    expect(expired.status).not.toBe(0);
    expect(expired.stderr).toContain('stale');
    expect(existsSync(ACTIVE)).toBe(false);
  });

  it('rejects receipts that do not bind this exact job', () => {
    if (activeLeaseExists()) return;
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['wrong policy', { policyRev: 1 }, 'policy rev'],
      ['wrong task', { task: 'other' }, 'task'],
      ['wrong command', { command: 'rm -rf /' }, 'command'],
      ['wrong source', { source: 'other-source' }, 'source'],
      ['wrong peak', { declaredPeakBytes: 1 }, 'declaredPeakBytes'],
      ['wrong path', { dataPath: '/tmp' }, 'dataPath'],
      ['wrong io class', { diskHeavy: true }, 'diskHeavy'],
      ['no health binding', { healthFile: null }, 'health'],
      ['diagnostic receipt', { admission: 'diagnostic' }, 'does not admit'],
    ];
    for (const [name, overrides, needle] of cases) {
      const receipt = writePreflight(overrides);
      const refused = run(...createArgs(receipt));
      expect(refused.status, name).not.toBe(0);
      expect(refused.stderr, name).toContain(needle);
      expect(existsSync(ACTIVE), name).toBe(false);
    }
  });

  it('rejects invalid timeout, peak, and io-class inputs', () => {
    if (activeLeaseExists()) return;
    const preflight = writePreflight();
    for (const timeout of ['0', '-3', 'abc', '1.5']) {
      const refused = run(...createArgs(preflight).map((a) => (a === '60' ? timeout : a)));
      expect(refused.status, `timeout ${timeout}`).toBe(2);
      expect(refused.stderr).toContain('timeout');
    }
    for (const peak of ['-1', 'NaN', 'abc']) {
      const refused = run(...createArgs(preflight, ['--declared-peak-bytes', peak]));
      expect(refused.status, `peak ${peak}`).toBe(2);
    }
    const refused = run(...createArgs(preflight, ['--disk-heavy', 'sometimes']));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('disk-heavy');
    expect(existsSync(ACTIVE)).toBe(false);
  });

  it('admits disk-heavy only with ioReady bound in the receipt', () => {
    if (activeLeaseExists()) return;
    const noIo = writePreflight({ diskHeavy: true, io: { ioReady: false } });
    const refused = run(...createArgs(noIo, ['--disk-heavy', 'yes']));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('ioReady');
    const withIo = writePreflight({ diskHeavy: true, io: { ioReady: true } });
    const created = run(...createArgs(withIo, ['--disk-heavy', 'yes']));
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout).diskHeavy).toBe(true);
  });

  it('reports corrupt lease state as structured errors, never a stack', () => {
    if (activeLeaseExists()) return;
    mkdirSync(DIR, { recursive: true });
    writeFileSync(ACTIVE, 'not-json{{{');
    try {
      for (const args of [['show'], ['release', '--owner', OWNER]] as string[][]) {
        const out = run(...args);
        expect(out.status, args.join(' ')).toBe(2);
        expect(JSON.parse(out.stderr).lease).toBe('error');
        expect(out.stderr).toContain('corrupt');
      }
      const created = run(...createArgs(writePreflight()));
      expect(created.status).toBe(2);
      expect(created.stderr).toContain('corrupt');
    } finally {
      rmSync(ACTIVE, { force: true });
    }
  });
});
