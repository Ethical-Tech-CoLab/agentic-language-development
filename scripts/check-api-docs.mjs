import { readFile } from 'node:fs/promises';

const docs = await readFile('docs/api-reference.md', 'utf8');
const nursery = [
  'POST /runs', 'POST /runs/:id/step', 'GET /runs', 'GET /runs/:id',
  'GET /runs/:id/transcript', 'GET /runs/:id/ledgers', 'GET /runs/:id/audit',
  'GET /runs/:id/checkpoints', 'GET /runs/:id/anchors',
  'GET /runs/:id/telemetry', 'GET /runs/:id/replay',
  'GET /runs/:id/observations', 'POST /runs/:id/pause',
  'POST /runs/:id/resume', 'POST /runs/:id/abort',
  'POST /runs/:id/annotate', 'GET /runs/:id/verification-report',
  'POST /runs/:id/verify', 'POST /session/snapshot',
  'POST /session/restore', 'GET /session/delta',
];
const baby = [
  'POST /observe', 'POST /act', 'POST /deliver', 'POST /outcome',
  'GET /ledger', 'POST /reset',
];
for (const route of [...nursery, ...baby]) {
  if (!docs.includes(`\`${route}`)) {
    throw new Error(`API reference is missing ${route}`);
  }
}

const nurserySource = await readFile('twins/packs/nursery/behavior/pack.ts', 'utf8');
const babyASource = await readFile('twins/packs/baby-a/behavior/pack.ts', 'utf8');
const babyBSource = await readFile('twins/packs/baby-b/behavior/pack.ts', 'utf8');
for (const route of nursery) {
  const [method, path] = route.split(' ');
  if (!nurserySource.includes(`method: '${method}'`) || !nurserySource.includes(`pattern: '${path}'`)) {
    throw new Error(`documented nursery route is absent from source: ${route}`);
  }
}
for (const route of baby) {
  const [method, path] = route.split(' ');
  for (const [name, source] of [['baby-a', babyASource], ['baby-b', babyBSource]]) {
    if (!source.includes(`method: '${method}'`) || !source.includes(`pattern: '${path}'`)) {
      throw new Error(`documented ${name} route is absent from source: ${route}`);
    }
  }
}

console.log(`API reference covers ${nursery.length + baby.length * 2} concrete twin routes.`);
