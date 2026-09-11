/**
 * Qualification report writer (BACKLOG ALD-072): renders the `runE03Controls`
 * and/or `runE11NamingGame` results into a machine-readable pair of
 * `canonicalJson` summaries and one human-readable `REPORT.md`, verbatim
 * carrying SPECIFICATION.md's Prototype Mode claim boundary
 * (`CLAIM_BOUNDARY_STATEMENTS.prototype`) and the qualification-run label
 * (`QUALIFICATION_LABEL`) so nobody mistakes this for a pre-registered
 * research finding (ALD-072 acceptance criterion 3).
 *
 * This never touches EXPERIMENT-NOTEBOOK.md — it is a report generator, not a
 * pre-registration document.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from '@ald/hashing';
import { CLAIM_BOUNDARY_STATEMENTS } from '@ald/types';

import { QUALIFICATION_LABEL, type E03Result } from './e03-controls.js';
import type { E11Result } from './e11-naming-game.js';

export interface WriteQualificationReportOptions {
  readonly e03?: E03Result;
  readonly e11?: E11Result;
  readonly runSetId: string;
  readonly nodeVersion: string;
}

export interface WriteQualificationReportResult {
  readonly files: string[];
}

/**
 * `e03Analysis` reports genuinely undefined quantities as `NaN` (e.g. a
 * condition's Holm-adjusted p when it was excluded for `insufficient-seeds`,
 * RESEARCH.md Appendix D §D.10) — a real analysis result at small seed
 * counts, not a bug, but `canonicalJson` (RFC 8785) rejects `NaN`/`Infinity`
 * outright. Recursively downgrading them to `null` keeps the report
 * artifact representable without changing any finite value.
 */
function sanitizeForCanonicalJson(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForCanonicalJson);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeForCanonicalJson(entry);
    }
    return out;
  }
  return value;
}

async function writeJsonSummary(path: string, value: unknown): Promise<void> {
  await writeFile(
    path,
    `${canonicalJson(sanitizeForCanonicalJson(value))}\n`,
    'utf8',
  );
}

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function num(value: number, digits = 4): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function markdownTable(header: string[], rows: string[][]): string {
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

function renderMetadata(options: WriteQualificationReportOptions): string {
  const { e03, e11 } = options;
  const lines = [
    `- Generated at: ${e03?.generatedAt ?? e11?.generatedAt ?? 'n/a'}`,
    `- Software commit: ${e03?.softwareCommit ?? e11?.softwareCommit ?? 'n/a'}`,
    `- Node version: ${options.nodeVersion}`,
    `- Run set id: ${options.runSetId}`,
  ];
  if (e03) {
    lines.push(
      `- E03 conditions: ${e03.params.conditions.join(', ')}`,
      `- E03 seeds per condition: ${String(e03.params.seeds)}`,
      `- E03 evaluation episodes per run: ${String(e03.params.episodes)}`,
      `- E03 symbol inventory: ${String(e03.params.symbolInventorySize)} (max ${String(e03.params.maxSymbolsPerMessage)} symbol(s)/message)`,
      `- E03 alpha: ${num(e03.params.alpha)}`,
      `- E03 equivalence bounds: [${num(e03.params.equivalenceLower)}, ${num(e03.params.equivalenceUpper)}]`,
      `- E03 oracle lower bound: ${num(e03.params.oracleLowerBound)}`,
      `- E03 separation lower bound: ${num(e03.params.separationLowerBound)}`,
    );
  }
  if (e11) {
    lines.push(
      `- E11 seeds: ${String(e11.params.seeds)}`,
      `- E11 training turns: ${String(e11.params.trainingTurns)}`,
      `- E11 evaluation turns: ${String(e11.params.evaluationTurns)}`,
      `- E11 symbol inventory: ${String(e11.params.symbolInventorySize)}`,
      `- E11 learner options: learningRate=${num(e11.params.learnerOptions.learningRate)}, temperature=${num(e11.params.learnerOptions.temperature)}, messageLength=${String(e11.params.learnerOptions.messageLength)}`,
    );
  }
  return lines.join('\n');
}

function renderE03Section(e03: E03Result): string {
  const { analysis } = e03;
  const conditionRows = analysis.conditions.map((condition) => [
    condition.condition,
    String(condition.n),
    num(condition.summary.mean),
    num(condition.summary.sd),
    condition.decision,
    num(condition.holmAdjustedP),
    condition.pooledEpisodes
      ? `[${num(condition.pooledEpisodes.lower)}, ${num(condition.pooledEpisodes.upper)}]`
      : 'n/a',
  ]);

  const separationRows = analysis.conditions.map((condition) => [
    condition.condition,
    num(condition.separation.simultaneousInterval.lower),
    num(condition.separation.holmAdjustedP),
    condition.separation.meets ? 'meets' : 'fails',
  ]);

  const lines = [
    '## E03: chance-baseline controls',
    '',
    markdownTable(
      [
        'condition',
        'seeds',
        'mean success',
        'sd',
        'TOST decision',
        'Holm-adjusted p',
        'pooled Wilson 95% CI',
      ],
      conditionRows,
    ),
    '',
    `Oracle adequacy: one-sided seed-level t lower bound ${num(analysis.oracle.simultaneousInterval.lower)} vs floor ${num(analysis.oracleLowerBound)} — ${analysis.criteria.oracleAdequate ? 'meets' : 'fails'} (bootstrap sensitivity lower bound ${num(analysis.oracle.adequacy.lower)}).`,
    '',
    '### Oracle separation (seed-level Holm tests)',
    '',
    markdownTable(
      [
        'condition',
        `simultaneous lower bound vs ${num(analysis.separationLowerBound)}`,
        'Holm-adjusted p',
        'decision',
      ],
      separationRows,
    ),
    '',
    `Appendix D clauses 1-3 qualify: ${String(analysis.qualifies)}`,
    analysis.unmetCriteria.length > 0
      ? `Unmet criteria: ${analysis.unmetCriteria.join(', ')}`
      : 'Unmet criteria: none',
    analysis.auditTriggers.length > 0
      ? `Required leakage-audit triggers: ${analysis.auditTriggers.join(', ')}`
      : 'Required leakage-audit triggers: none',
    '',
    `All evidence bundles verified: ${String(e03.allBundlesVerified)}`,
  ];
  return lines.join('\n');
}

function renderE11Section(e11: E11Result): string {
  const rows = e11.runs.map((run) => [
    String(run.slot),
    run.lastWindowTrainingSuccess === undefined
      ? 'n/a'
      : num(run.lastWindowTrainingSuccess),
    num(run.evaluationSuccess),
    `[${num(run.wilson.lower)}, ${num(run.wilson.upper)}]`,
    num(run.chanceTest.exactP),
    percent(run.vocabularyUtilization),
    num(run.symbolEntropyBits),
    String(run.policyHashConstant),
    String(run.verifierExitCode),
  ]);

  const lines = [
    '## E11: from-scratch RL naming game',
    '',
    markdownTable(
      [
        'seed',
        'last-window training success',
        'evaluation success',
        'Wilson 95% CI',
        'chance p (one-sided vs 0.25)',
        'vocabulary utilization',
        'symbol entropy (bits)',
        'policy hash constant',
        'verifier exit',
      ],
      rows,
    ),
    '',
    `Aggregate evaluation success: mean ${num(e11.aggregate.meanEvaluationSuccess)}, sd ${
      e11.aggregate.sdEvaluationSuccess === null
        ? 'n/a (fewer than 2 seeds)'
        : num(e11.aggregate.sdEvaluationSuccess)
    } across ${String(e11.aggregate.seeds)} seed(s).`,
    '',
    '### What this shows / does not show',
    '',
    '**Shows:** the pipeline executes end to end through the scenario engine, ' +
      'learner adapters, the Symbol Gateway, the atomic Evidence Writer, ' +
      'checkpoints, Experiment Records, bundle export, and independent ' +
      'verification.',
    '',
    '**Does not show:** research-grade isolation (Mode P only, not Mode R), ' +
      'anchoring (no Base Sepolia transaction was submitted), ' +
      'pre-registration (none was filed), or statistical power (these are ' +
      'developer seed counts, not the SPECIFICATION.md §15.3 floor) — and ' +
      'therefore no E00-E03 qualification in EXPERIMENT-NOTEBOOK.md\'s sense.',
    '',
    '**Next steps:** authorize a Base Sepolia wallet and RPC credential through ' +
      '`si fort` file materialization, register the protocol, then run in Mode R.',
  ];
  return lines.join('\n');
}

function renderAppendix(options: WriteQualificationReportOptions): string {
  const rows: string[][] = [];
  for (const run of options.e03?.runs ?? []) {
    rows.push([
      run.runId,
      `${run.condition}/s${String(run.slot)}`,
      run.state,
      run.dispositions.join(', '),
      run.configurationHash,
      run.finalCheckpointHash ?? 'n/a',
      run.replayDigest,
      String(run.verifierExitCode),
    ]);
  }
  for (const run of options.e11?.runs ?? []) {
    rows.push([
      run.runId,
      `s${String(run.slot)}`,
      run.state,
      run.dispositions.join(', '),
      run.configurationHash,
      run.finalCheckpointHash ?? 'n/a',
      run.replayDigest,
      String(run.verifierExitCode),
    ]);
  }
  return [
    '## Per-run appendix',
    '',
    markdownTable(
      [
        'runId',
        'condition/seed',
        'state',
        'dispositions',
        'configurationHash',
        'final checkpoint',
        'replayDigest',
        'verifier exit',
      ],
      rows,
    ),
  ].join('\n');
}

/**
 * Writes `<outDir>/e03-summary.json`, `<outDir>/e11-summary.json` (whichever
 * result was supplied), and `<outDir>/REPORT.md`. Never touches
 * `EXPERIMENT-NOTEBOOK.md`.
 */
export async function writeQualificationReport(
  outDir: string,
  options: WriteQualificationReportOptions,
): Promise<WriteQualificationReportResult> {
  await mkdir(outDir, { recursive: true });
  const files: string[] = [];

  if (options.e03) {
    const path = join(outDir, 'e03-summary.json');
    await writeJsonSummary(path, options.e03);
    files.push(path);
  }
  if (options.e11) {
    const path = join(outDir, 'e11-summary.json');
    await writeJsonSummary(path, options.e11);
    files.push(path);
  }

  const sections = [
    `# Qualification Run Report ${options.runSetId}`,
    '',
    `> ${CLAIM_BOUNDARY_STATEMENTS.prototype}`,
    '',
    `> ${QUALIFICATION_LABEL}`,
    '',
    '## Metadata',
    '',
    renderMetadata(options),
  ];
  if (options.e03) {
    sections.push('', renderE03Section(options.e03));
  }
  if (options.e11) {
    sections.push('', renderE11Section(options.e11));
  }
  sections.push('', renderAppendix(options));

  const reportPath = join(outDir, 'REPORT.md');
  await writeFile(reportPath, `${sections.join('\n')}\n`, 'utf8');
  files.push(reportPath);

  return { files };
}
