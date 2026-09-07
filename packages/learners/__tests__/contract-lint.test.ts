import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTRACT_LINT_RULES,
  lintLearnerContractText,
} from '../src/contract-lint.js';
import { learnerContractsDirectory } from '../src/contracts.js';

const SCRIPT = fileURLToPath(
  new URL('../../../scripts/lint-learner-contracts.mjs', import.meta.url),
);

/** One text per banned pattern of SPEC §6.4, keyed by the rule it must trip. */
const OFFENDING_TEXTS: Record<string, string[]> = {
  'symbol-identifier': ['The mark S13 is available to both learners.'],
  'glyph-identifier': ['The carrier offers glyph G04 first.'],
  'affect-identifier': ['Display A3 reports low arousal.'],
  'assigned-meaning': [
    'A mark means an object attribute.',
    'The first mark stands for a target object.',
  ],
  'mapping-arrow': ['mark -> object attribute', 'mark => object attribute'],
  'illustrative-example': [
    'For example, a mark may be reused.',
    'Choose a mark, e.g. the first one.',
    'An Example exchange follows.',
  ],
  'color-or-shape-word': [
    'The target is the red object.',
    'A triangle is a valid target.',
    'Prefer the BLUE candidate.',
  ],
  emoji: ['Use \u{1F642} as an affect display.'],
  'fenced-code-block': ['```text', '   ~~~'],
};

function runScript(directory: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, directory], {
      encoding: 'utf8',
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { status: failure.status ?? 1, output: failure.stdout ?? '' };
  }
}

describe('lintLearnerContractText', () => {
  it('catches every banned pattern and names the rule and line', () => {
    for (const [ruleId, texts] of Object.entries(OFFENDING_TEXTS)) {
      for (const text of texts) {
        const violations = lintLearnerContractText(`clean line\n${text}`);
        expect(
          violations.some(
            (violation) => violation.startsWith('2: ') && violation.includes(ruleId),
          ),
          `${ruleId} should reject: ${text}`,
        ).toBe(true);
      }
    }
  });

  it('covers every declared rule with at least one fixture', () => {
    expect(Object.keys(OFFENDING_TEXTS).sort()).toEqual(
      CONTRACT_LINT_RULES.map((rule) => rule.id).sort(),
    );
  });

  it('accepts contract prose that names no marks or categories', () => {
    expect(
      lintLearnerContractText(
        'Treat every unfamiliar mark as semantically unknown.\n' +
          'Preserve contradictory evidence rather than overwriting it.',
      ),
    ).toEqual([]);
  });

  it('exempts the contract header line but not a header elsewhere', () => {
    expect(lintLearnerContractText('<!-- contract: scratch-rl version: 1 -->')).toEqual(
      [],
    );
    const violations = lintLearnerContractText(
      'body\n<!-- contract: scratch-rl version: 1 -->',
    );
    expect(violations.some((violation) => violation.includes('mapping-arrow'))).toBe(
      true,
    );
  });

  it('reports one violation per rule per line, in line order', () => {
    const violations = lintLearnerContractText('a mark means red\nclean\nS13');
    expect(violations[0]).toContain('1: assigned-meaning');
    expect(violations[1]).toContain('1: color-or-shape-word');
    expect(violations[2]).toContain('3: symbol-identifier');
  });
});

describe('the shipped contracts', () => {
  it('holds one contract per implemented track and nothing else', () => {
    expect(readdirSync(learnerContractsDirectory()).sort()).toEqual([
      'learner-contract.frozen-llm.v1.md',
      'learner-contract.no-learning.v1.md',
      'learner-contract.scratch-rl.v1.md',
    ]);
  });

  it('passes the lint, header included', () => {
    for (const file of readdirSync(learnerContractsDirectory())) {
      const text = readFileSync(join(learnerContractsDirectory(), file), 'utf8');
      expect(lintLearnerContractText(text), file).toEqual([]);
    }
  });
});

describe('scripts/lint-learner-contracts.mjs', () => {
  it('exits 0 and reports the count for the shipped contracts', () => {
    const result = runScript(learnerContractsDirectory());
    expect(result.status).toBe(0);
    expect(result.output).toContain('3 contract file(s) clean');
  });

  it('exits 1 and prints file:line: rule for a seeded contract', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-contract-lint-'));
    writeFileSync(
      join(directory, 'learner-contract.bad.v1.md'),
      '<!-- contract: bad version: 1 -->\n\nclean line\nthe mark S13 means red\n',
      'utf8',
    );
    const result = runScript(directory);
    expect(result.status).toBe(1);
    expect(result.output).toContain('learner-contract.bad.v1.md:4: symbol-identifier');
    expect(result.output).toContain('assigned-meaning');
    expect(result.output).toContain('color-or-shape-word');
  });

  it('exits 1 when the directory holds no contracts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-contract-lint-empty-'));
    const result = runScript(directory);
    expect(result.status).toBe(1);
    expect(result.output).toContain('no contract files found');
  });

  it('agrees with the TypeScript twin on every fixture', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-contract-lint-twin-'));
    const texts = Object.values(OFFENDING_TEXTS).flat();
    texts.forEach((text, index) => {
      writeFileSync(
        join(directory, `learner-contract.case${index}.v1.md`),
        `<!-- contract: case version: 1 -->\n${text}\n`,
        'utf8',
      );
    });
    const result = runScript(directory);
    const expected = texts.reduce(
      (total, text) =>
        total +
        lintLearnerContractText(`<!-- contract: case version: 1 -->\n${text}\n`)
          .length,
      0,
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain(`${expected} violation(s)`);
  });
});
