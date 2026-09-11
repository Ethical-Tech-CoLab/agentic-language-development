import { access, readFile } from 'node:fs/promises';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function requireText(text, expected, surface) {
  if (!text.includes(expected)) {
    throw new Error(`${surface} is missing the canonical status: ${expected}`);
  }
}

const [pkg, backlog, readme, research, plan] = await Promise.all([
  readJson('package.json'),
  readFile('BACKLOG.md', 'utf8'),
  readFile('README.md', 'utf8'),
  readFile('RESEARCH.md', 'utf8'),
  readFile('plans/completion-plan.md', 'utf8'),
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

const executionSteps = [...plan.matchAll(/^\d+\. \[([x ])\]/gmu)];
if (
  executionSteps.length !== 6 ||
  executionSteps.some((step) => step[1] !== 'x')
) {
  throw new Error('completion plan must contain exactly six completed execution steps');
}
requireText(
  plan,
  '**Status:** Local execution complete; external evidence gates remain',
  'plans/completion-plan.md',
);

console.log(
  `Project status aligned: v${pkg.version}, ${String(checked)}/${String(total)} acceptance criteria, six execution steps complete.`,
);
