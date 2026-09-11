import { access, readFile } from 'node:fs/promises';

import {
  buildEvidenceIndex,
  evidencePathsFor,
} from './lib/acceptance-evidence.mjs';

const backlog = await readFile('BACKLOG.md', 'utf8');
const evidenceIndex = await buildEvidenceIndex();

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
  const coverage = evidencePathsFor(id, evidenceIndex);
  if (coverage.length === 0) {
    throw new Error(`${id} is Done but has no consolidated-suite evidence mapping`);
  }
  for (const path of coverage) await access(path);
}

console.log(`Acceptance coverage: ${doneItems} Done items / ${coveredCriteria} criteria mapped to the consolidated suite.`);
