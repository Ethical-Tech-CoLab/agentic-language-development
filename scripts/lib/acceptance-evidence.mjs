import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const explicitCoverage = Object.freeze({
  'ALD-001': ['packages/types/__tests__/schema-manifest.test.ts'],
  'ALD-002': ['packages/types/__tests__/schema-manifest.test.ts'],
  'ALD-003': ['packages/config/__tests__/environment.test.ts', 'scripts/scan-secrets.mjs'],
  'ALD-004': ['twins/packs/__tests__/routes.test.ts'],
  'ALD-005': ['packages/evidence/__tests__/database.test.ts'],
  'ALD-006': ['packages/evidence/__tests__/canonical.test.ts'],
  'ALD-007': ['packages/evidence/__tests__/event-types.test.ts'],
  'ALD-013': ['packages/checkpoint/__tests__/checkpoint-service.test.ts'],
  'ALD-016': ['packages/evidence/__tests__/export.test.ts'],
  'ALD-024': ['packages/lifecycle/__tests__/state-machine.test.ts'],
  'ALD-030': ['packages/gateway/__tests__/conformance.test.ts'],
  'ALD-053': ['packages/orchestrator/__tests__/sealing-and-guards.test.ts'],
  'ALD-055': ['scripts/run-mode-r-smoke.mjs'],
  'ALD-056': ['scripts/run-mode-r-smoke.mjs'],
  'ALD-065': ['scripts/check-research-console.mjs'],
  'ALD-066': ['twins/packs/__tests__/routes.test.ts', 'packages/orchestrator/__tests__/run-lifecycle.test.ts'],
  'ALD-069': ['packages/crypto-research/__tests__/harness.test.ts'],
  'ALD-073': ['scripts/check-readiness-gates.mjs'],
  'ALD-074': ['scripts/check-readiness-gates.mjs'],
  'ALD-076': ['scripts/check-readiness-gates.mjs'],
  'ALD-078': ['.github/workflows/book-integrity.yml'],
  'ALD-079': ['scripts/check-api-docs.mjs', 'scripts/run-mode-r-smoke.mjs'],
  'ALD-080': ['scripts/check-readiness-gates.mjs'],
  'ALD-081': ['.github/workflows/book-integrity.yml'],
  'ALD-082': ['packages/analysis/__tests__/e03-design.test.ts'],
  'ALD-083': ['packages/analysis/__tests__/e03-registration.test.ts'],
  'ALD-084': ['packages/ops/__tests__/research-preflight.test.ts'],
  'ALD-085': ['packages/learners/__tests__/frozen-qualification.test.ts'],
  'ALD-086': ['scripts/check-project-status.mjs'],
});

const excludedScripts = new Set([
  'scripts/build-conformance-matrix.mjs',
  'scripts/check-acceptance-coverage.mjs',
  'scripts/lib/acceptance-evidence.mjs',
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'dist') paths.push(...await walk(path));
    } else if (
      path.endsWith('.test.ts') ||
      (path.startsWith('scripts/') && path.endsWith('.mjs'))
    ) {
      paths.push(path);
    }
  }
  return paths;
}

export async function buildEvidenceIndex() {
  const paths = [
    ...await walk('packages'),
    ...await walk('twins'),
    ...await walk('scripts'),
    '.github/workflows/book-integrity.yml',
  ].filter((path) => !excludedScripts.has(path));
  const text = new Map(
    await Promise.all(paths.map(async (path) => [path, await readFile(path, 'utf8')])),
  );
  return { paths, text };
}

export function evidencePathsFor(itemId, evidenceIndex) {
  const direct = evidenceIndex.paths.filter(
    (path) => evidenceIndex.text.get(path)?.includes(itemId),
  );
  return [...new Set([...direct, ...(explicitCoverage[itemId] ?? [])])].sort();
}
