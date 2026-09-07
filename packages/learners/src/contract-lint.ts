/**
 * Learner-contract lint (SPEC §6.4, CONCEPT-IDEA.md §20.3, ALD-043).
 *
 * A contract MUST NOT contain example symbol-meaning pairs, sample exchanges,
 * or a suggested default vocabulary: "even an illustrative example can seed the
 * language the experiment is supposed to observe". The rules below are the
 * mechanical reading of that requirement, and they are deliberately blunt —
 * a false positive costs one reword, a false negative can invalidate a run.
 *
 * `scripts/lint-learner-contracts.mjs` is the CI twin of this module and
 * enforces the identical rule table over `contracts/*.md`; the two are checked
 * against each other in this package's tests. `loadLearnerContract` runs these
 * rules on load, so a contract that would fail CI can never be referenced by a
 * run.
 */

export interface ContractLintRule {
  id: string;
  description: string;
  /** Tested against each line. Must be non-global so `exec` is stateless. */
  pattern: RegExp;
}

/** The banned patterns of SPEC §6.4, applied line by line. */
export const CONTRACT_LINT_RULES: readonly ContractLintRule[] = [
  {
    id: 'symbol-identifier',
    description:
      'names a fixed-token symbol identifier, which seeds the inventory',
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

/**
 * Lint one contract's text. Accepts either a contract body or a whole contract
 * file: a leading `<!-- contract: <track> version: <n> -->` header is metadata
 * rather than contract body and is exempt (its comment terminator is not a
 * mark-to-meaning mapping). Returns one message per violation, formatted
 * `<line>: <ruleId>: <description> (matched "<text>")`, in line order then
 * rule order, with line numbers relative to the text supplied. An empty array
 * means the text is clean.
 */
export function lintLearnerContractText(text: string): string[] {
  const violations: string[] = [];
  const lines = text.replace(/\r\n/gu, '\n').split('\n');

  lines.forEach((line, index) => {
    if (index === 0 && HEADER_PATTERN.test(line.trim())) {
      return;
    }
    for (const rule of CONTRACT_LINT_RULES) {
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
