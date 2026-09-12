#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const outputPath = 'reports/research/manuscript-readiness-audit.json';
const read = (path: string): string => readFileSync(path, 'utf8');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const manuscript = read('RESEARCH.md');
const compactManuscript = manuscript.replace(/\s+/gu, ' ');
const notebook = read('EXPERIMENT-NOTEBOOK.md');
const packageJson = JSON.parse(read('package.json')) as { version: string };
const claims = JSON.parse(read('reports/research/data-claim-manifest.json')) as {
  totals: Record<string, number>;
};
const registration = JSON.parse(read('reports/research/registration-packet-readiness.json')) as {
  totals: Record<string, number>;
};
const campaign = JSON.parse(read('protocols/campaign-readiness-review.v1.json')) as {
  decision: string;
  independentHumanReview: boolean;
  blockingFindings: unknown[];
  experiments: unknown[];
};
const external = JSON.parse(read('reports/research/external-prerequisite-readiness.json')) as {
  decision: string;
  satisfiedCount: number;
  requiredCount: number;
};
const upstream = JSON.parse(read('reports/research/upstream-enforcement-observation.json')) as {
  decision: string;
};
const sources = JSON.parse(read('reports/research/source-verification-register.json')) as {
  existingReferences: unknown[];
  updatedSearch: unknown[];
};
const book = JSON.parse(read('book/pages/manifest.json')) as { pages: unknown[]; sourceSha256: string };

const [body, references = ''] = manuscript.split('\n## References\n');
const definedReferences = [...references.matchAll(/^\[(\d+)\]/gmu)].map((match) => Number(match[1]));
const citedReferences = [...body.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
const uniqueCitations = [...new Set(citedReferences)].sort((left, right) => left - right);
const experimentRows = [...notebook.matchAll(/^\| (E\d{2}) \|.*\| Not started \|/gmu)].map((match) => match[1]);
const exact = (needle: string): void => {
  if (!compactManuscript.includes(needle)) throw new Error(`manuscript lacks exact audited claim: ${needle}`);
};

if (definedReferences.length !== 50 || definedReferences.some((value, index) => value !== index + 1)) {
  throw new Error('reference definitions are not the complete ordered range 1..50');
}
if (uniqueCitations.join('|') !== definedReferences.join('|')) {
  throw new Error('every defined reference must be cited and every citation must resolve');
}
if (sources.existingReferences.length !== 50 || sources.updatedSearch.length !== 5) {
  throw new Error('source register counts differ from the manuscript audit scope');
}
if (experimentRows.length !== 19 || campaign.experiments.length !== 19) {
  throw new Error('experiment inventory must contain 19 not-started experiments');
}
if (notebook.includes('Ready for pre-registration')) {
  throw new Error('notebook contradicts the fail-closed campaign decision');
}
if (campaign.decision !== 'not-registration-ready' || campaign.blockingFindings.length !== 8) {
  throw new Error('campaign readiness decision or blocker count changed');
}
if (campaign.independentHumanReview) throw new Error('independent human review must not be inferred');
if (
  external.decision !== 'ready' ||
  external.satisfiedCount !== 1 ||
  external.requiredCount !== 1 ||
  upstream.decision !== 'not-demonstrated'
) {
  throw new Error('external prerequisite or upstream-enforcement status changed');
}
if (registration.totals['compiledPackets'] !== 1 || registration.totals['unresolvedBindings'] !== 180) {
  throw new Error('registration readiness counts changed');
}
if (claims.totals['researchIncluded'] !== 0 || claims.totals['confirmedPublicChainAnchors'] !== 0) {
  throw new Error('pre-results manuscript status contradicts the eligible-data or public-chain inventory');
}
if (book.pages.length !== 51 || book.sourceSha256 !== sha256(manuscript.replace(/\r\n?/gu, '\n'))) {
  throw new Error('rendered research book is missing pages or does not bind the current manuscript');
}
exact(`v${packageJson.version} · 254/258 backlog acceptance criteria verified.`);
exact(`resolves ${String(claims.totals['bundles'])} exported bundles across ${String(claims.totals['collections'])} collections`);
exact(`leaves ${String(registration.totals['unresolvedBindings'])} experiment-specific bindings open, and emits one E00 registration hash`);
exact(`external-dependency ledger is ready at ${String(external.satisfiedCount)}/${String(external.requiredCount)}`);
exact('No empirical results are reported in this version.');

const result = {
  schemaVersion: 1,
  classification: 'manuscript-readiness-audit',
  researchFinding: false,
  capturedAt: '2026-09-12',
  decision: 'needs-revision',
  manuscript: {
    path: 'RESEARCH.md',
    sha256: sha256(manuscript),
    version: packageJson.version,
    majorSections: [...manuscript.matchAll(/^## (?:\d+\.|Abstract|Keywords|Research Integrity Notice|Declarations|References|Appendix )/gmu)].length,
    referencesDefined: definedReferences.length,
    referencesCited: uniqueCitations.length,
    renderedPages: book.pages.length,
    renderedSourceSha256: book.sourceSha256,
  },
  evidenceState: {
    experiments: experimentRows.length,
    notStartedExperiments: experimentRows.length,
    researchIncludedBundles: claims.totals['researchIncluded'],
    confirmedPublicChainAnchors: claims.totals['confirmedPublicChainAnchors'],
    compiledRegistrationPackets: registration.totals['compiledPackets'],
    unresolvedRegistrationBindings: registration.totals['unresolvedBindings'],
    campaignBlockers: campaign.blockingFindings.length,
    externalPrerequisitesSatisfied: external.satisfiedCount,
    externalPrerequisitesRequired: external.requiredCount,
    upstreamEnforcement: upstream.decision,
    independentHumanReview: campaign.independentHumanReview,
  },
  sourceState: {
    existingReferences: sources.existingReferences.length,
    updatedSearchRecords: sources.updatedSearch.length,
    allDefinitionsResolve: true,
    allDefinedReferencesCited: true,
    requiredIndependentHumanRecheck: true,
  },
  boundary: 'This audit checks current-draft consistency and readiness claims. It does not supply missing experiment data, repository registration, prospective simulated commitments, independent human review, or venue acceptance.'
};
const rendered = `${JSON.stringify(result, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(outputPath, rendered);
  console.log(`wrote ${outputPath}`);
} else if (read(outputPath) !== rendered) {
  throw new Error('manuscript readiness audit is stale; run pnpm run build:manuscript-readiness');
}
console.log(`manuscript readiness valid: ${String(experimentRows.length)} experiments not started, ${String(definedReferences.length)} references resolved, decision=${result.decision}`);
