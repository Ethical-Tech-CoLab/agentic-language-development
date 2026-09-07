#!/usr/bin/env node
/**
 * Learner-contract lint (SPECIFICATION.md §6.4, ALD-043).
 *
 * A learner contract MUST NOT contain example symbol-meaning pairs, sample
 * exchanges, or a suggested default vocabulary, and MUST be linted
 * automatically before a run may reference it — a build/CI check, not only a
 * human review step. This script is that check.
 *
 * Usage:
 *   node scripts/lint-learner-contracts.mjs [dir]     # default: contracts/
 *
 * Exits 1 and prints `file:line: rule: description` for every violation.
 * Exits 1 if the directory holds no contract files at all, so a moved or
 * renamed directory can never look like a clean pass.
 *
 * The rule table is kept identical to `lintLearnerContractText` in
 * `packages/learners/src/contract-lint.ts`; the two are asserted to agree in
 * that package's tests.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = [
  {
    id: 'symbol-identifier',
    description: 'names a fixed-token symbol identifier, which seeds the inventory',
    pattern: /\bS\d{2,3}\b/u,
  },
  {
    id: 'glyph-identifier',
    description: 'names a fixed-glyph identifier, which seeds the inventory',
    pattern: /\bG\d{2}\b/u,
  },
  {
    id: 'affect-identifier',
    description: 'names an affect display identifier, which seeds the protocol',
    pattern: /\bA[1-6]\b/u,
  },
  {
    id: 'assigned-meaning',
    description: 'asserts an assigned meaning for a mark',
    pattern: /\bmeans\b|\bstands for\b/iu,
  },
  {
    id: 'mapping-arrow',
    description: 'shows a mark-to-meaning mapping',
    pattern: /->|=>/u,
  },
  {
    id: 'illustrative-example',
    description: 'introduces an illustrative example or sample exchange',
    pattern: /\be\.g\.|\bexamples?\b/iu,
  },
  {
    id: 'color-or-shape-word',
    description:
      'names a perceptual category the learners are supposed to invent a mark for',
    pattern: /\b(?:red|green|blue|yellow|circle|square|triangle|star)\b/iu,
  },
  {
    id: 'emoji',
    description: 'contains a pictographic code point usable as a seeded mark',
    pattern: /[\p{Extended_Pictographic}\u{FE0F}]/u,
  },
  {
    id: 'fenced-code-block',
    description: 'opens a fenced code block, the usual carrier of a sample exchange',
    pattern: /^\s*(?:```|~~~)/u,
  },
];

const HEADER_PATTERN =
  /^<!--\s*contract:\s*[a-z-]+\s+version:\s*\d+\s*-->$/u;

function lintText(text) {
  const violations = [];
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  lines.forEach((line, index) => {
    // The `<!-- contract: <track> version: <n> -->` header is metadata, not
    // contract body; it is exempt (its comment terminator is not a mapping).
    if (index === 0 && HEADER_PATTERN.test(line.trim())) {
      return;
    }
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (match !== null) {
        violations.push(
          `${index + 1}: ${rule.id}: ${rule.description} (matched "${match[0]}")`,
        );
      }
    }
  });
  return violations;
}

const defaultDirectory = fileURLToPath(new URL('../contracts/', import.meta.url));
const directory = resolve(process.argv[2] ?? defaultDirectory);

let entries;
try {
  entries = readdirSync(directory);
} catch {
  process.stdout.write(`lint-learner-contracts: cannot read ${directory}\n`);
  process.exit(1);
}

const files = entries
  .filter((entry) => entry.endsWith('.md'))
  .map((entry) => join(directory, entry))
  .filter((path) => statSync(path).isFile())
  .sort();

if (files.length === 0) {
  process.stdout.write(
    `lint-learner-contracts: no contract files found in ${directory}\n`,
  );
  process.exit(1);
}

let violationCount = 0;
for (const file of files) {
  for (const violation of lintText(readFileSync(file, 'utf8'))) {
    violationCount += 1;
    process.stdout.write(`${file}:${violation}\n`);
  }
}

if (violationCount > 0) {
  process.stdout.write(
    `lint-learner-contracts: ${violationCount} violation(s) in ${files.length} contract file(s)\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `lint-learner-contracts: ${files.length} contract file(s) clean\n`,
);
