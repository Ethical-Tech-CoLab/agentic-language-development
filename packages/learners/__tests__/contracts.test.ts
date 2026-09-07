import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { HASH_DOMAINS } from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  learnerContractPath,
  loadLearnerContract,
  promptBundleHash,
} from '../src/contracts.js';
import { LearnerConfigurationError } from '../src/errors.js';

const CONCEPT_IDEA = fileURLToPath(
  new URL('../../../CONCEPT-IDEA.md', import.meta.url),
);

/** The CONCEPT-IDEA.md §20.3 template, extracted from the source document. */
function conceptTemplate(): string {
  const source = readFileSync(CONCEPT_IDEA, 'utf8');
  const section = source.slice(
    source.indexOf('### 20.3'),
    source.indexOf('### 20.4'),
  );
  const match = /```text\n([\s\S]*?)\n```/u.exec(section);
  if (match?.[1] === undefined) {
    throw new Error('CONCEPT-IDEA.md §20.3 template block not found');
  }
  return match[1].trim();
}

describe('loadLearnerContract', () => {
  it('uses the CONCEPT-IDEA.md §20.3 template verbatim as the frozen-llm v1 body', () => {
    expect(loadLearnerContract('frozen-llm').text).toBe(conceptTemplate());
  });

  it('resolves contracts relative to the module, not the working directory', () => {
    expect(learnerContractPath('scratch-rl')).toMatch(
      /contracts\/learner-contract\.scratch-rl\.v1\.md$/u,
    );
    expect(loadLearnerContract('scratch-rl').version).toBe('1');
    expect(loadLearnerContract('scratch-rl').track).toBe('scratch-rl');
  });

  it('states the tool-only constraint, the alternate-channel ban, and evidence preservation', () => {
    for (const track of ['scratch-rl', 'no-learning'] as const) {
      // Contract bodies are hard-wrapped, so phrases are matched against the
      // whitespace-normalized text.
      const text = loadLearnerContract(track)
        .text.toLowerCase()
        .replace(/\s+/gu, ' ');
      expect(text).toContain('approved tool proposal');
      expect(text).toContain('construct another communication route');
      expect(text).toContain('alternate mark channel');
      expect(text).toContain('no assigned meaning');
    }
    expect(loadLearnerContract('scratch-rl').text).toContain(
      'Preserve contradictory evidence',
    );
    expect(loadLearnerContract('no-learning').text).toContain(
      'preserve contradictory evidence',
    );
  });

  it('rejects a missing version', () => {
    expect(() => loadLearnerContract('scratch-rl', 2)).toThrow();
  });

  it('rejects a track with no contract file', () => {
    expect(() => loadLearnerContract('hybrid')).toThrow();
  });
});

describe('promptBundleHash', () => {
  it('hashes the canonical track-to-body map under the prompt-bundle domain', () => {
    const contracts = [
      loadLearnerContract('scratch-rl'),
      loadLearnerContract('no-learning'),
    ];
    expect(promptBundleHash(contracts)).toBe(
      hashCanonical(HASH_DOMAINS.promptBundle, {
        'scratch-rl': contracts[0]?.text,
        'no-learning': contracts[1]?.text,
      }),
    );
  });

  it('does not depend on the order the contracts were loaded', () => {
    const a = loadLearnerContract('scratch-rl');
    const b = loadLearnerContract('no-learning');
    expect(promptBundleHash([a, b])).toBe(promptBundleHash([b, a]));
  });

  it('changes when a track joins the bundle', () => {
    const pair = [
      loadLearnerContract('scratch-rl'),
      loadLearnerContract('no-learning'),
    ];
    expect(promptBundleHash(pair)).not.toBe(
      promptBundleHash([...pair, loadLearnerContract('frozen-llm')]),
    );
  });

  it('rejects an empty bundle and conflicting contracts for one track', () => {
    expect(() => promptBundleHash([])).toThrow(LearnerConfigurationError);
    const contract = loadLearnerContract('scratch-rl');
    expect(() =>
      promptBundleHash([contract, { ...contract, text: 'different body' }]),
    ).toThrow(LearnerConfigurationError);
  });

  it('is stable across loads, so a referenced version is immutable in evidence', () => {
    expect(promptBundleHash([loadLearnerContract('frozen-llm')])).toBe(
      promptBundleHash([loadLearnerContract('frozen-llm')]),
    );
  });
});
