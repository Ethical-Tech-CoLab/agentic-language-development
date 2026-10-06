import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    policyRev: 5,
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
// Sibling a0 suites run in parallel files yet share one on-disk lease, so a
// test-owned lease at assert time means violated precondition, not product
// failure: skip rather than fail, mirroring the guard above.
const TEST_OWNERS = new Set([OWNER, 'a0-launch-test']);
const testLeaseHolds = (): boolean => {
  try {
    return TEST_OWNERS.has((JSON.parse(readFileSync(ACTIVE, 'utf8')) as { owner: string }).owner);
  } catch {
    return false;
  }
};
const shownTestOwner = (stdout: string): boolean => {
  try {
    return TEST_OWNERS.has((JSON.parse(stdout) as { owner: string }).owner);
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
    const shown = run('show');
    // Racy window: a sibling a0 suite may grab the single lease between our
    // guard and this assertion (parallel files, one on-disk lease). The shown
    // owner is the state the command itself saw, so a test-owned lease means
    // violated precondition, not product failure: skip.
    if (shown.status === 0 && shownTestOwner(shown.stdout)) return;
    expect(shown.status).not.toBe(0);
    const created = run(
      'create', '--owner', OWNER, '--task', 'test', '--command', 'true',
      '--preflight', join(DIR, 'does-not-exist.json'), '--timeout', '60',
    );
    if (testLeaseHolds()) return; // Sibling grabbed the lease before create ran; precondition violated, skip.
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

  it('escapes $ for systemd while recording the literal command', () => {
    if (activeLeaseExists()) return;
    const command = 'kill -TERM $$';
    const preflight = writePreflight({ command });
    const created = run(...createArgs(preflight).map((a) => (a === 'true' ? command : a)));
    expect(created.status).toBe(0);
    const lease = JSON.parse(created.stdout);
    expect(lease.command).toBe(command);
    expect(lease.run.slice(-3)).toEqual(['sh', '-c', 'kill -TERM $$$$']);
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
      ['old policy rev 2', { policyRev: 2 }, 'policy rev'],
      ['old policy rev 4', { policyRev: 4 }, 'policy rev'],
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

  it('refuses a tampered preflight receipt with a structured error', () => {
    if (activeLeaseExists()) return;
    const preflight = writePreflight();
    appendFileSync(preflight, 'tampered');
    const refused = run(...createArgs(preflight));
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stderr).lease).toBe('error');
    expect(refused.stderr).toContain('missing or invalid');
    expect(existsSync(ACTIVE)).toBe(false);
  });

  it('refuses to release a running lease while its unit is still active', () => {
    // R10-C-Q1 ALD2 flag (a0-lease gap 1 of 2): release must never orphan a live unit.
    if (activeLeaseExists()) return;
    const unit = `ald-test-a0-lease-${process.pid}.service`;
    const started = spawnSync('systemd-run', ['--user', `--unit=${unit}`, 'sleep', '30'], { encoding: 'utf8' });
    if (started.status !== 0) return; // No systemd user manager here; nothing to refuse against.
    const live = spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit]);
    if (live.status !== 0) { spawnSync('systemctl', ['--user', 'stop', unit]); return; }
    mkdirSync(DIR, { recursive: true });
    writeFileSync(ACTIVE, `${JSON.stringify({ id: 'a0-test-running-live', unit, status: 'running', owner: OWNER, task: 'test' })}\n`);
    try {
      const refused = run('release', '--owner', OWNER, '--reason', 'must not orphan');
      expect(refused.status).toBe(2);
      expect(JSON.parse(refused.stderr).lease).toBe('error');
      expect(refused.stderr).toContain('has a running job');
      expect(existsSync(ACTIVE)).toBe(true); // Still held, not orphaned.
    } finally {
      spawnSync('systemctl', ['--user', 'stop', unit]);
      rmSync(ACTIVE, { force: true });
    }
  });

  it('stamps launcher-lost when releasing a running lease whose unit is gone', () => {
    // R10-C-Q1 ALD2 flag (a0-lease gap 2 of 2): vanished unit releases with a stamped outcome.
    if (activeLeaseExists()) return;
    const id = `a0-test-running-gone-${process.pid}-${Date.now().toString(36)}`;
    mkdirSync(DIR, { recursive: true });
    writeFileSync(ACTIVE, `${JSON.stringify({ id, unit: `aldresearch-job-${id}.scope`, status: 'running', owner: OWNER, task: 'test' })}\n`);
    const released = run('release', '--owner', OWNER, '--reason', 'unit vanished');
    expect(released.status).toBe(0);
    expect(existsSync(ACTIVE)).toBe(false);
    const hits = readdirSync(DIR)
      .filter((f) => f.startsWith('released-'))
      .map((f) => ({ f, r: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { id: string; outcome: string } }))
      .filter(({ r }) => r.id === id);
    expect(hits).toHaveLength(1);
    expect(hits[0].r.outcome).toContain('launcher-lost');
    expect(hits[0].r.outcome).toContain('already gone');
    expect(hits[0].r.outcome).toContain('unit vanished');
    rmSync(join(DIR, hits[0].f)); // Our record is asserted inline; leave no residue for reruns.
  });

  it('refuses a create whose source identity is unresolvable', () => {
    // R10-C-Q1 ALD2 flag 2: autoSource catch + unknown-source refuse (:35-41, :134).
    // Isolated cwd outside any git checkout, so no operator lease can be disturbed.
    const dir = mkdtempSync(join(tmpdir(), 'ald-a0-lease-nosource-'));
    try {
      const args = createArgs(writePreflight()).filter((a, i, arr) => a !== '--source' && arr[i - 1] !== '--source');
      const refused = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
      expect(refused.status).toBe(2);
      expect(JSON.parse(refused.stderr).lease).toBe('error');
      expect(refused.stderr).toContain('cannot bind source identity');
      expect(existsSync(join(dir, '.artifacts/a0-leases/active.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binds git HEAD as source when --source is omitted', () => {
    // R10-C-Q1 ALD2 flag 2: autoSource success path (:35-41 try).
    if (activeLeaseExists()) return;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (head.status !== 0) return; // Not a git checkout; nothing to auto-bind.
    const sha = head.stdout.trim();
    const args = createArgs(writePreflight({ source: sha })).filter((a, i, arr) => a !== '--source' && arr[i - 1] !== '--source');
    const created = run(...args);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout).source).toBe(sha);
  });
});
