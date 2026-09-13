import { access, readFile } from 'node:fs/promises';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function requireText(text, expected, surface) {
  if (!text.includes(expected)) {
    throw new Error(`${surface} is missing the canonical status: ${expected}`);
  }
}

const [pkg, backlog, readme, research, notebook, campaign, e02Receipt] = await Promise.all([
  readJson('package.json'),
  readFile('BACKLOG.md', 'utf8'),
  readFile('README.md', 'utf8'),
  readFile('RESEARCH.md', 'utf8'),
  readFile('EXPERIMENT-NOTEBOOK.md', 'utf8'),
  readJson('protocols/campaign-readiness-review.v1.json'),
  readJson('reports/research/e02-qualification-receipt.json'),
]);

if (pkg.engines?.pnpm !== '12.3.4') {
  throw new Error(`unexpected pnpm version policy: ${String(pkg.engines?.pnpm)}`);
}
await access('pnpm-lock.yaml');
try {
  await access('package-lock.json');
  throw new Error('package-lock.json is forbidden; pnpm-lock.yaml is canonical');
} catch (error) {
  if (error instanceof Error && error.message.includes('forbidden')) {
    throw error;
  }
}

const criteria = [...backlog.matchAll(/^  - \[(x| )\]/gmu)];
const checked = criteria.filter((criterion) => criterion[1] === 'x').length;
const total = criteria.length;
const backlogStatus = `with ${String(checked)} of ${String(total)} acceptance criteria verified`;
requireText(backlog, backlogStatus, 'BACKLOG.md');

const publicStatus =
  `**Engineering snapshot:** v${pkg.version} · ` +
  `${String(checked)}/${String(total)} backlog acceptance criteria verified.`;
requireText(readme, publicStatus, 'README.md');
requireText(research, publicStatus, 'RESEARCH.md');

const index = notebook.split('## 8. Experiment Index')[1]?.split('\n---\n')[0] ?? '';
const experiments = [...index.matchAll(/^\| (E\d{2}) \|[^|]+\|[^|]+\| ([^|]+) \|/gmu)]
  .map((match) => ({ id: match[1], status: match[2].trim() }));
if (JSON.stringify(experiments.map(({ id }) => id).sort()) !==
    JSON.stringify(campaign.experiments.map(({ id }) => id).sort())) {
  throw new Error('notebook and campaign review disagree on the experiment inventory');
}
const count = (status) => experiments.filter((entry) => entry.status === status).length;
const expectedE02Status = e02Receipt.passed === true && e02Receipt.failure === null
  ? 'Qualified (software)'
  : e02Receipt.passed === false && typeof e02Receipt.failure === 'string' && e02Receipt.failure.length > 0
    ? 'Failed qualification attempt'
    : 'In progress';
const e02 = experiments.find((entry) => entry.id === 'E02');
if (e02?.status !== expectedE02Status) {
  throw new Error(`EXPERIMENT-NOTEBOOK.md reports E02 as ${String(e02?.status)}, but its terminal receipt requires ${expectedE02Status}`);
}
const researchStatus = `Research status: ${count('Qualified (software)')} qualified (software), ` +
  `${count('Failed qualification attempt')} failed qualification attempt, ` +
  `${count('In progress')} in progress, ${count('Not started')} not started; ` +
  `${campaign.blockingFindings.length} open campaign blockers.`;
requireText(readme, researchStatus, 'README.md');
for (const path of [
  'reports/phase-one-research-update.md',
  'reports/research/research-validation-report.md',
  'reports/research/research-critical-review.md',
  'reports/research/methods-readiness-review.md',
]) {
  requireText(await readFile(path, 'utf8'), researchStatus, path);
}

console.log(
  `Project status aligned: v${pkg.version}, ${String(checked)}/${String(total)} acceptance criteria. ${researchStatus}`,
);
