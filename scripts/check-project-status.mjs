import { access, readFile } from 'node:fs/promises';
import { checkE03LocalPilotState } from './e03-local-pilot-state.mjs';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function requireText(text, expected, surface) {
  if (!text.includes(expected)) {
    throw new Error(`${surface} is missing the canonical status: ${expected}`);
  }
}

const [pkg, backlog, readme, research, notebook, campaign] = await Promise.all([
  readJson('package.json'),
  readFile('BACKLOG.md', 'utf8'),
  readFile('README.md', 'utf8'),
  readFile('RESEARCH.md', 'utf8'),
  readFile('EXPERIMENT-NOTEBOOK.md', 'utf8'),
  readJson('protocols/campaign-readiness-review.v1.json'),
]);
checkE03LocalPilotState(campaign.experiments.find((entry) => entry.id === 'E03'),
  campaign.e03PilotCompletionSupplement, campaign.e03PowerSelectionSupplement,
  campaign.e03SampleSizeDecisionSupplement, campaign.e03FullAllocationSupplement);

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
const experiments = [...index.matchAll(/^\| (E\d{2}) \|[^|]+\|[^|]+\| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gmu)]
  .map((match) => ({ id: match[1], attempt: match[2].trim(), disposition: match[3].trim(), gate: match[4].trim() }));
if (JSON.stringify(experiments.map(({ id }) => id).sort()) !==
    JSON.stringify(campaign.experiments.map(({ id }) => id).sort())) {
  throw new Error('notebook and campaign review disagree on the experiment inventory');
}
const labels = (value) => {
  const text = value.replaceAll('-', ' ');
  return text[0].toUpperCase() + text.slice(1);
};
for (const expected of campaign.experiments) {
  const actual = experiments.find((entry) => entry.id === expected.id);
  if (actual?.attempt !== labels(expected.attempt.status) || actual.disposition !== labels(expected.scientificDisposition)) {
    throw new Error(`${expected.id} notebook attempt/disposition contradicts the campaign progress record`);
  }
  const gatePrefix = `${labels(expected.executionReadiness.stage)} ${expected.executionReadiness.decision}`;
  if (!actual.gate.startsWith(gatePrefix)) {
    throw new Error(`${expected.id} notebook gate contradicts the campaign progress record`);
  }
  const packet = expected.evidence.find((evidence) => evidence.kind === 'prospective-registration-packet');
  if (packet) {
    const registered = await readJson(packet.path);
    const terminalPath = registered.artifact?.bindings?.find((binding) =>
      binding.key === 'evidenceAndAnchorPolicy')?.content?.receiptPath;
    if (terminalPath) {
      try {
        const terminal = await readJson(terminalPath);
        if (terminal.experimentId !== expected.id || terminal.registrationHash !== registered.preRegistrationHash) {
          throw new Error(`${expected.id} terminal receipt contradicts its prospective registration`);
        }
        if (!expected.evidence.some((evidence) => evidence.path === terminalPath && evidence.statusAuthority)) {
          throw new Error(`${expected.id} terminal receipt exists but is not the status authority`);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}
const qualifiedSoftware = campaign.experiments.filter((entry) =>
  entry.executionReadiness.stage === 'qualification' && entry.executionReadiness.decision === 'complete').length;
const failedQualification = campaign.experiments.reduce((sum, entry) => {
  if (entry.executionReadiness.stage !== 'qualification') return sum;
  const historical = entry.evidence.filter((evidence) =>
    evidence.kind === 'historical-terminal-receipt').length;
  return sum + historical + (entry.attempt.status === 'failed' ? 1 : 0);
}, 0);
const running = campaign.experiments.filter((entry) => entry.attempt.status === 'running').length;
const notStarted = campaign.experiments.filter((entry) =>
  entry.attempt.status === 'not-started').length;
const researchStatus = `Research status: ${qualifiedSoftware} qualified (software), ` +
  `${failedQualification} failed qualification ${failedQualification === 1 ? 'attempt' : 'attempts'}, ` +
  `${running} in progress, ${notStarted} not started; ` +
  `${campaign.blockingFindings.length} open campaign blockers.`;
requireText(readme, researchStatus, 'README.md');
for (const [path, cutoff] of [
  ['reports/research/research-validation-report.md', 'Evidence cutoff: 2026-09-13'],
  ['reports/research/research-critical-review.md', 'Review date: 2026-09-13'],
  ['reports/research/methods-readiness-review.md', 'Review date: 2026-09-13'],
]) {
  requireText(await readFile(path, 'utf8'), cutoff, path);
}

console.log(
  `Project status aligned: v${pkg.version}, ${String(checked)}/${String(total)} acceptance criteria. ${researchStatus}`,
);
