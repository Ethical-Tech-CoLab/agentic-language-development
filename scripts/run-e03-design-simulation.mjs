#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  buildE03SeedManifest,
  simulateE03DesignPower,
} from '@ald/analysis';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'docs/e03-design-simulation.json' },
    'seed-manifest': {
      type: 'string',
      default: 'docs/e03-seed-manifest.json',
    },
    'primary-seeds': { type: 'string', default: '75' },
  },
});

const primarySeeds = Number(values['primary-seeds']);
if (!Number.isInteger(primarySeeds) || primarySeeds < 1) {
  throw new Error('--primary-seeds must be a positive integer');
}

const designPath = resolve(values.out);
const manifestPath = resolve(values['seed-manifest']);
const design = simulateE03DesignPower();
if (!design.passes) {
  throw new Error('E03 design does not meet the registered minimum power');
}
const manifest = buildE03SeedManifest(primarySeeds);

await Promise.all([
  mkdir(dirname(designPath), { recursive: true }),
  mkdir(dirname(manifestPath), { recursive: true }),
]);
await Promise.all([
  writeFile(designPath, `${JSON.stringify(design, null, 2)}\n`, 'utf8'),
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
]);
console.log(`Wrote ${designPath}`);
console.log(`Wrote ${manifestPath}`);
