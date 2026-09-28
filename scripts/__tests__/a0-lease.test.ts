import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../a0-lease.mjs', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
const ACTIVE = join(root, '.artifacts/a0-leases/active.json');
const OWNER = 'a0-lease-test';

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
  rmSync(join(root, '.artifacts/a0-leases/test-preflight.json'), { force: true });
});

const writePreflight = (overrides: Record<string, unknown> = {}): string => {
  const path = join(root, '.artifacts/a0-leases/test-preflight.json');
  mkdirSync(join(root, '.artifacts/a0-leases'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ admission: 'admit', at: new Date().toISOString(), ...overrides })}\n`);
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

describe('A0 single host-job lease', () => {
  it('refuses show, create, and release with no live state', () => {
    if (activeLeaseExists()) return; // An operator holds the single lease; skip rather than interfere.
    expect(run('show').status).not.toBe(0);
    const created = run(
      'create', '--owner', OWNER, '--task', 'test', '--command', 'true',
      '--preflight', join(root, '.artifacts/a0-leases/does-not-exist.json'), '--timeout', '60',
    );
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain('missing or invalid');
    expect(run('release', '--owner', OWNER).status).not.toBe(0);
  });

  it('creates, excludes a second lease, and releases by owner', () => {
    if (activeLeaseExists()) return;
    const preflight = writePreflight();
    const created = run(
      'create', '--owner', OWNER, '--task', 'test', '--command', 'true',
      '--preflight', preflight, '--timeout', '60',
    );
    expect(created.status).toBe(0);
    const lease = JSON.parse(created.stdout);
    expect(lease.owner).toBe(OWNER);
    expect(lease.run).toContain('--slice=aldresearch.slice');
    expect(lease.run).toContain('--property=Nice=15');
    const shown = run('show');
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).id).toBe(lease.id);
    const second = run(
      'create', '--owner', 'other', '--task', 'test', '--command', 'true',
      '--preflight', preflight, '--timeout', '60',
    );
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('already active');
    expect(run('release', '--owner', 'other').status).not.toBe(0);
    expect(run('release', '--owner', OWNER, '--reason', 'done').status).toBe(0);
    expect(existsSync(ACTIVE)).toBe(false);
  });

  it('rejects stale and non-admitting preflight receipts', () => {
    if (activeLeaseExists()) return;
    const blocked = writePreflight({ admission: 'block' });
    const refused = run(
      'create', '--owner', OWNER, '--task', 'test', '--command', 'true',
      '--preflight', blocked, '--timeout', '60',
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('does not admit');
    const stale = writePreflight({ at: new Date(Date.now() - 3600_000).toISOString() });
    const expired = run(
      'create', '--owner', OWNER, '--task', 'test', '--command', 'true',
      '--preflight', stale, '--timeout', '60',
    );
    expect(expired.status).not.toBe(0);
    expect(expired.stderr).toContain('stale');
    expect(existsSync(ACTIVE)).toBe(false);
  });
});
