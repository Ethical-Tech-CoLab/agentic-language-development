import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

const dir = 'reports/manuscript/';
const readme = read(`${dir}README.md`);
const draft = read(`${dir}first-paper-draft.md`);
const estimates = read(`${dir}estimates-and-intervals.md`);
const accounting = read(`${dir}run-accounting.md`);
const artifact = read(`${dir}artifact-outline.md`);
const review = read(`${dir}review-package.md`);

describe('R11 manuscript skeleton (pre-results)', () => {
  it('labels every file as skeleton/pre-results with TBD-only results', () => {
    for (const [name, text] of [
      ['README.md', readme],
      ['first-paper-draft.md', draft],
      ['estimates-and-intervals.md', estimates],
      ['run-accounting.md', accounting],
      ['artifact-outline.md', artifact],
      ['review-package.md', review],
    ] as const) {
      expect(text, name).toMatch(/skeleton|shell/i);
      expect(text, name).toContain('TBD');
    }
  });

  it('draft states the exact question, population, and information-access table', () => {
    expect(draft).toContain('Exact question');
    expect(draft).toContain('Study population');
    expect(draft).toContain('Information-access table');
    expect(draft).toContain('dyad');
    expect(draft).toContain('Mode limitations');
  });

  it('draft separates inherited foundation from new work with provenance', () => {
    expect(draft).toContain('Inherited foundation versus new work');
    expect(draft).toContain('data-and-claim-inventory');
  });

  it('estimates cover training, controls, LV-U/P/C/L, baselines, equality, mutation, cost, repeat', () => {
    for (const heading of [
      'Training curves',
      'Causal controls',
      'LV-U',
      'LV-P',
      'LV-C',
      'LV-L',
      'baselines',
      'predictive equality',
      'Mutation detection',
      'Cost',
      'Repeat',
    ]) {
      expect(estimates).toContain(heading);
    }
    expect(estimates).toContain('0.02 Brier');
    expect(estimates).toContain('signing-improves-semantics');
  });

  it('run accounting reconciles stages, failures, deviations, and resources', () => {
    expect(accounting).toContain('attempt table');
    expect(accounting).toContain('Failed-development accounting');
    expect(accounting).toContain('Deviation log');
    expect(accounting).toContain('Resource reconciliation');
    expect(accounting).toContain('R01');
    expect(accounting).toContain('detector-v3');
  });

  it('artifact outline pins one reproduction entry point with input digests', () => {
    expect(artifact).toContain('reproduction entry point');
    expect(artifact).toContain('input digests');
    expect(artifact).toContain('SHA-256');
    expect(artifact).toContain('Verification steps');
  });

  it('review package holds claim-to-evidence, skeptical review, and release gates', () => {
    expect(review).toContain('Claim-to-evidence appendix');
    expect(review).toContain('Skeptical-review checklist');
    for (const topic of [
      'Trivial fidelity',
      'Weak comparators',
      'Temporal leakage',
      'Outcome selection',
      'Logical isolation',
      'Seed uncertainty',
      'Cost',
      'External validity',
    ]) {
      expect(review).toContain(topic);
    }
    expect(review).toContain('independent human review');
    expect(review).toContain('TMLR');
    expect(review).toContain('authorization');
  });

  it('forbids premature submission and fabricated independence', () => {
    expect(review).toContain('Not');
    expect(review).toContain('independent replication');
    expect(readme).toContain('only from verified');
  });
});
