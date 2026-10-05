import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

// ALD-001 workspace-bootstrap receipt (R9-AN): executable evidence that the
// monorepo installs, resolves workspaces, and builds. Hermetic by design —
// no network, no reinstall. The literal `pnpm install --frozen-lockfile`
// execution happens in CI setup on every run; here we verify its product
// (modules marker), the workspace pickup mechanism (globs resolve to the
// on-disk set), and a zero-error build.
const failures = [];

// 1. Frozen-install product: pnpm runs and this tree carries a completed
// install marker. A missing/partial node_modules fails here, not later.
try {
  execFileSync('pnpm', ['--version'], { stdio: 'pipe' });
} catch {
  failures.push('pnpm is not runnable');
}
if (!existsSync('node_modules/.modules.yaml')) {
  failures.push('node_modules/.modules.yaml absent: no completed install product');
}

// 2. Workspace auto-pickup: `pnpm -r list` resolves the pnpm-workspace.yaml
// globs; every on-disk package dir must appear (same mechanism that picks
// up a newly added package with no root package.json edit).
let listed = '';
try {
  listed = execFileSync('pnpm', ['-r', 'list', '--depth', '0', '--parseable'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch {
  failures.push('pnpm -r list failed: workspace globs do not resolve');
}
if (listed !== '') {
  const expected = ['deploy/mode-r'];
  for (const dir of ['packages', 'twins/packs']) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(`${dir}/${entry.name}/package.json`)) continue;
      expected.push(`${dir}/${entry.name}`);
    }
  }
  for (const member of expected) {
    if (!listed.includes(member)) {
      failures.push(`workspace member missing from pnpm -r list: ${member}`);
    }
  }
}

// 3. Build: project references compile with zero errors (incremental;
// fast on a green tree, full rebuild cost only when stale).
try {
  execFileSync('npx', ['tsc', '--build'], { stdio: 'pipe' });
} catch {
  failures.push('tsc --build reported errors');
}

if (failures.length > 0) {
  throw new Error(`Workspace bootstrap check failed:\n- ${failures.join('\n- ')}`);
}
process.stdout.write('Workspace bootstrap check passed (install product, workspace pickup, build)\n');
