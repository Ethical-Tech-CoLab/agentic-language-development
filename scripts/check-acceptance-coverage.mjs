import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const explicitCoverage = {
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
  'ALD-080': ['scripts/check-readiness-gates.mjs'],
  'ALD-081': ['.github/workflows/book-integrity.yml'],
  'ALD-082': ['packages/analysis/__tests__/e03-design.test.ts'],
  'ALD-083': ['packages/analysis/__tests__/e03-registration.test.ts'],
  'ALD-084': ['packages/ops/__tests__/research-preflight.test.ts'],
  'ALD-085': ['packages/learners/__tests__/frozen-qualification.test.ts'],
  'ALD-086': ['scripts/check-project-status.mjs'],
};

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'dist') paths.push(...await walk(path));
    } else if (path.endsWith('.test.ts') || path.startsWith('scripts/')) {
      paths.push(path);
    }
  }
  return paths;
}

const backlog = await readFile('BACKLOG.md', 'utf8');
const evidencePaths = [
  ...await walk('packages'),
  ...await walk('twins'),
  ...await walk('scripts'),
];
const evidenceText = new Map(
  await Promise.all(evidencePaths.map(async (path) => [path, await readFile(path, 'utf8')])),
);

let doneItems = 0;
let coveredCriteria = 0;
for (const match of backlog.matchAll(/^#### (ALD-\d+) — /gmu)) {
  const id = match[1];
  const start = match.index;
  const next = backlog.indexOf('\n#### ALD-', start + 1);
  const section = backlog.slice(start, next < 0 ? backlog.length : next);
  const criteria = [...section.matchAll(/^  - \[(x| )\]/gmu)];
  if (criteria.length === 0 || criteria.some((criterion) => criterion[1] !== 'x')) {
    continue;
  }
  doneItems += 1;
  coveredCriteria += criteria.length;
  const direct = evidencePaths.filter((path) => evidenceText.get(path)?.includes(id));
  const mapped = explicitCoverage[id] ?? [];
  const coverage = [...new Set([...direct, ...mapped])];
  if (coverage.length === 0) {
    throw new Error(`${id} is Done but has no consolidated-suite evidence mapping`);
  }
  for (const path of coverage) await access(path);
}

console.log(`Acceptance coverage: ${doneItems} Done items / ${coveredCriteria} criteria mapped to the consolidated suite.`);
