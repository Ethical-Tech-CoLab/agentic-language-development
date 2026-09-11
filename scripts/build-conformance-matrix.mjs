#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  buildEvidenceIndex,
  evidencePathsFor,
} from './lib/acceptance-evidence.mjs';

const OUTPUT_JSON = 'docs/requirement-conformance-matrix.json';
const OUTPUT_MARKDOWN = 'docs/requirement-conformance-matrix.md';
const EXTERNAL_ITEMS = new Set(['ALD-020', 'ALD-022', 'ALD-078', 'ALD-079']);
const NON_REQUIREMENT_LINES = new Set([
  'SPECIFICATION.md:101',
  'SPECIFICATION.md:102',
  'SPECIFICATION.md:219',
  'SPECIFICATION.md:242',
]);

const specSectionItems = Object.freeze({
  1: ['ALD-001'],
  2: ['ALD-078'],
  3: ['ALD-002'],
  4: ['ALD-001', 'ALD-004', 'ALD-010', 'ALD-029'],
  5: ['ALD-053', 'ALD-054', 'ALD-055'],
  6: ['ALD-042', 'ALD-043', 'ALD-044', 'ALD-045', 'ALD-046', 'ALD-047', 'ALD-057'],
  7: ['ALD-024', 'ALD-026', 'ALD-027', 'ALD-028'],
  8: ['ALD-010', 'ALD-025'],
  9: ['ALD-029', 'ALD-030', 'ALD-031', 'ALD-032', 'ALD-033', 'ALD-034', 'ALD-035', 'ALD-036'],
  10: ['ALD-038', 'ALD-039', 'ALD-040', 'ALD-056', 'ALD-067', 'ALD-068'],
  11: ['ALD-002', 'ALD-018', 'ALD-023', 'ALD-035', 'ALD-037'],
  12: ['ALD-004', 'ALD-010', 'ALD-048', 'ALD-049', 'ALD-050', 'ALD-051', 'ALD-052'],
  13: ['ALD-005', 'ALD-006', 'ALD-007', 'ALD-008', 'ALD-009', 'ALD-012', 'ALD-013', 'ALD-016', 'ALD-018', 'ALD-019', 'ALD-020', 'ALD-021', 'ALD-022', 'ALD-064'],
  14: ['ALD-058', 'ALD-059', 'ALD-060', 'ALD-061', 'ALD-062', 'ALD-066'],
  15: ['ALD-041', 'ALD-071', 'ALD-072'],
  16: ['ALD-063', 'ALD-065', 'ALD-066'],
  17: ['ALD-036', 'ALD-073', 'ALD-074', 'ALD-075', 'ALD-076', 'ALD-077', 'ALD-078'],
  18: ['ALD-023', 'ALD-041', 'ALD-071'],
  19: ['ALD-070'],
  20: ['ALD-080'],
});

function normalize(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

function parseBacklog(backlog) {
  const items = [];
  const matches = [...backlog.matchAll(/^#### (ALD-\d+) — (.+)$/gmu)];
  for (const [index, match] of matches.entries()) {
    const start = match.index;
    const end = matches[index + 1]?.index ?? backlog.length;
    const section = backlog.slice(start, end);
    const criteria = [...section.matchAll(/^  - \[([x ])\] (.+)$/gmu)].map(
      (criterion, criterionIndex) => ({
        id: `${match[1]}.${String(criterionIndex + 1)}`,
        checked: criterion[1] === 'x',
        statement: normalize(criterion[2]),
      }),
    );
    items.push({ id: match[1], title: normalize(match[2]), criteria });
  }
  return items;
}

function testSelectors(text) {
  return [...text.matchAll(/\b(?:it|test)(?:\.(?:only|skip|todo))?\(\s*(['"`])([^'"`]+)\1/gmu)]
    .map((match) => normalize(match[2]));
}

function commandFor(path) {
  const commands = {
    '.github/workflows/book-integrity.yml': 'hosted consolidated-suite or mode-r job',
    'scripts/check-api-docs.mjs': 'pnpm run lint:api-docs',
    'scripts/check-project-status.mjs': 'pnpm run lint:project-status',
    'scripts/check-readiness-gates.mjs': 'pnpm run lint:readiness',
    'scripts/check-research-console.mjs': 'pnpm run lint:research-console',
    'scripts/lint-crypto-boundary.mjs': 'pnpm run lint:crypto-boundary',
    'scripts/lint-learner-contracts.mjs': 'pnpm run lint:contracts',
    'scripts/run-mode-r-smoke.mjs': 'pnpm run test:mode-r',
    'scripts/run-mode-r-study.mjs': 'pnpm run test:mode-r-study',
    'scripts/scan-secrets.mjs': 'pnpm run scan:secrets',
  };
  return commands[path] ?? `node ${path}`;
}

function assertionFor(path, evidenceIndex) {
  const selectors = path.endsWith('.test.ts')
    ? testSelectors(evidenceIndex.text.get(path) ?? '')
    : [commandFor(path)];
  return {
    selectors: selectors.length > 0 ? selectors : ['whole-file executable check'],
    requiredReceipt: path === 'scripts/run-mode-r-smoke.mjs' || path === 'scripts/run-mode-r-study.mjs'
      ? commandFor(path)
      : path.startsWith('.github/')
        ? 'hosted workflow receipt for the exact commit'
        : path.endsWith('.test.ts')
          ? `pnpm exec vitest run ${path}`
          : commandFor(path),
  };
}

function sourceBlocks(source, text, sectionItems) {
  const lines = text.split('\n');
  let section = 0;
  const result = [];
  for (const [index, line] of lines.entries()) {
    const heading = line.match(/^## (\d+)\./u);
    if (heading) section = Number(heading[1]);
    if (!/\bMUST(?: NOT)?\b/u.test(line)) continue;
    let start = index;
    let end = index;
    if (!line.startsWith('|')) {
      while (start > 0 && lines[start - 1].trim() !== '' && !lines[start - 1].startsWith('#')) start -= 1;
      while (end + 1 < lines.length && lines[end + 1].trim() !== '' && !lines[end + 1].startsWith('#')) end += 1;
    }
    const sourceRef = `${source}:${String(index + 1)}`;
    result.push({
      id: `${source === 'SPECIFICATION.md' ? 'SPEC' : 'LEDGER'}-MUST-L${String(index + 1)}`,
      source: sourceRef,
      section,
      statement: normalize(lines.slice(start, end + 1).join(' ')),
      applicable: !NON_REQUIREMENT_LINES.has(sourceRef),
      backlogItems: sectionItems[section] ?? [],
    });
  }
  return result;
}

function markdown(matrix) {
  const lines = [
    '# Requirement Conformance Matrix',
    '',
    `Generated from repository sources for baseline \`${matrix.candidate.baselineCommit.slice(0, 7)}\` / matrix v${matrix.candidate.version}.`,
    '',
    'This is a mapping and provisional-disposition artifact. A mapped file or test',
    'name is not by itself proof that the requirement is true. V04–V11 execution',
    'receipts promote individual rows only after the named behavior is freshly checked.',
    '',
    '## Summary',
    '',
    '| Population | Total | Provisionally mapped | Open/external | Not applicable |',
    '|---|---:|---:|---:|---:|',
    `| Backlog acceptance criteria | ${matrix.summary.backlogCriteria} | ${matrix.summary.checkedBacklogCriteria} | ${matrix.summary.openBacklogCriteria} | 0 |`,
    `| MUST-bearing source lines | ${matrix.summary.normativeLines} | ${matrix.summary.mappedNormativeLines} | ${matrix.summary.unmappedNormativeLines} | ${matrix.summary.nonRequirementLines} |`,
    '',
    '## Backlog acceptance criteria',
    '',
    '| Criterion | State | Provisional disposition | Assertion paths | Requirement |',
    '|---|---|---|---|---|',
  ];
  for (const row of matrix.backlogCriteria) {
    const paths = row.assertionPaths.map((path) => `\`${path}\``).join('<br>') || 'none';
    lines.push(`| ${row.id} | ${row.checked ? 'checked' : 'open'} | ${row.disposition} | ${paths} | ${row.statement.replaceAll('|', '\\|')} |`);
  }
  lines.push(
    '',
    '## Normative MUST inventory',
    '',
    '| Requirement | Source | Applicable | Provisional disposition | Backlog mapping | Assertion paths |',
    '|---|---|---|---|---|---|',
  );
  for (const row of matrix.normativeRequirements) {
    const paths = row.assertionPaths.map((path) => `\`${path}\``).join('<br>') || 'none';
    lines.push(`| ${row.id} | \`${row.source}\` | ${row.applicable ? 'yes' : 'no'} | ${row.disposition} | ${row.backlogItems.join(', ') || 'none'} | ${paths} |`);
  }
  lines.push(
    '',
    '## Interpretation',
    '',
    '- `provisional-mapped` means a concrete executable surface and required receipt are identified; behavioral truth still awaits the relevant V04–V11 challenge.',
    '- `external-blocked` means the checked state cannot be completed from local execution without authentic authority or independent evidence.',
    '- `open-unmapped` is a conformance defect and causes the generator to fail for a checked criterion or applicable normative line.',
    '- `not-applicable-definition` covers normative-language definitions and table headers that contain the word MUST but impose no independently executable behavior.',
    '',
    'Exact statements, test selectors, and required commands are retained in the companion JSON.',
    '',
  );
  return lines.join('\n');
}

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
const [backlog, specification, ledger, pkg] = await Promise.all([
  readFile('BACKLOG.md', 'utf8'),
  readFile('SPECIFICATION.md', 'utf8'),
  readFile('LEDGER-INTEGRITY-DESIGN.md', 'utf8'),
  readFile('package.json', 'utf8').then(JSON.parse),
]);
const evidenceIndex = await buildEvidenceIndex();
const items = parseBacklog(backlog);
const itemAssertions = new Map();
for (const item of items) {
  itemAssertions.set(item.id, evidencePathsFor(item.id, evidenceIndex));
}
const assertionPaths = [...new Set([...itemAssertions.values()].flat())].sort();
const assertionCatalog = Object.fromEntries(
  assertionPaths.map((path) => [path, assertionFor(path, evidenceIndex)]),
);

const backlogCriteria = items.flatMap((item) => item.criteria.map((criterion) => {
  const assertionPaths = itemAssertions.get(item.id) ?? [];
  const disposition = criterion.checked
    ? assertionPaths.length > 0 ? 'provisional-mapped' : 'open-unmapped'
    : EXTERNAL_ITEMS.has(item.id) ? 'external-blocked' : 'open-unmapped';
  return { ...criterion, itemId: item.id, itemTitle: item.title, disposition, assertionPaths };
}));

const normative = [
  ...sourceBlocks('SPECIFICATION.md', specification, specSectionItems),
  ...sourceBlocks('LEDGER-INTEGRITY-DESIGN.md', ledger, { 8: ['ALD-013', 'ALD-015', 'ALD-016'] }),
].map((requirement) => {
  const assertionPaths = [...new Set(
    requirement.backlogItems.flatMap((item) => itemAssertions.get(item) ?? []),
  )].sort();
  const disposition = !requirement.applicable
    ? 'not-applicable-definition'
    : assertionPaths.length > 0 ? 'provisional-mapped' : 'open-unmapped';
  return { ...requirement, disposition, assertionPaths };
});

const matrix = {
  schemaVersion: 1,
  generatedAtUtc: '2026-09-11T00:00:00Z',
  classification: 'provisional-conformance-mapping',
  researchFinding: false,
  candidate: { baselineCommit: '559436fee0d7a95ea38fd92fbcbcccf762d10f92', version: pkg.version },
  sourcePolicy: {
    checkedBacklogCriteria: 'Every checked criterion must have one or more concrete executable assertion paths.',
    normativeRequirements: 'Every applicable MUST-bearing line must map through its controlling section to one or more executable assertion paths.',
    limitation: 'File and selector mappings are not execution results; V04–V11 receipts determine behavioral disposition.',
  },
  assertionCatalog,
  summary: {
    backlogItems: items.length,
    backlogCriteria: backlogCriteria.length,
    checkedBacklogCriteria: backlogCriteria.filter((row) => row.checked).length,
    openBacklogCriteria: backlogCriteria.filter((row) => !row.checked).length,
    normativeLines: normative.length,
    mappedNormativeLines: normative.filter((row) => row.disposition === 'provisional-mapped').length,
    unmappedNormativeLines: normative.filter((row) => row.disposition === 'open-unmapped').length,
    nonRequirementLines: normative.filter((row) => !row.applicable).length,
  },
  backlogCriteria,
  normativeRequirements: normative,
};

const unresolved = [
  ...backlogCriteria.filter((row) => row.checked && row.assertionPaths.length === 0),
  ...normative.filter((row) => row.applicable && row.assertionPaths.length === 0),
];
if (unresolved.length > 0) {
  throw new Error(`unmapped applicable requirements: ${unresolved.map((row) => row.id).join(', ')}`);
}

const json = `${JSON.stringify(matrix, null, 2)}\n`;
const md = `${markdown(matrix)}\n`;
if (values.check) {
  const [actualJson, actualMarkdown] = await Promise.all([
    readFile(OUTPUT_JSON, 'utf8'),
    readFile(OUTPUT_MARKDOWN, 'utf8'),
  ]);
  if (actualJson !== json || actualMarkdown !== md) {
    throw new Error('requirement conformance matrix is stale; run pnpm run build:conformance-matrix');
  }
  console.log(`Conformance matrix current: ${matrix.summary.backlogCriteria} criteria, ${matrix.summary.normativeLines} normative lines.`);
} else {
  await Promise.all([
    writeFile(OUTPUT_JSON, json, 'utf8'),
    writeFile(OUTPUT_MARKDOWN, md, 'utf8'),
  ]);
  console.log(`Wrote ${OUTPUT_JSON} and ${OUTPUT_MARKDOWN}.`);
}
