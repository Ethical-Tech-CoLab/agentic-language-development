#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

import {
  binomialTest,
  fitBetaBinomial,
  holmBonferroni,
  logBeta,
  normalQuantile,
  oneSampleTTest,
  quantileSorted,
  studentTCdf,
  studentTQuantile,
  tost,
  welchTTest,
  wilsonInterval,
} from '@ald/analysis';
import {
  millerMadowEntropyBits,
  millerMadowMutualInformationBits,
  mutualInformationBits,
  shannonEntropyBits,
} from '../packages/analysis/src/information.js';

interface Row {
  category: string;
  case: string;
  metric: string;
  value: number;
  mcN?: number;
  lower95?: number;
  upper95?: number;
}

const trackedPath = 'reports/research/statistical-validation.tsv';
const protocol = JSON.parse(
  readFileSync('protocols/statistical-analysis-and-power.v1.json', 'utf8'),
) as {
  independentReference: { scriptSha256: string; receiptSha256: string };
};
let inputPath = trackedPath;
let temporaryDirectory: string | undefined;

if (process.argv.includes('--live-r')) {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'ald-statistics-'));
  inputPath = join(temporaryDirectory, 'statistical-validation.tsv');
  const result = spawnSync('Rscript', ['scripts/validate-statistics.R', inputPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`independent R validation failed: ${result.stderr}`);
  }
}

function parseOptional(value: string): number | undefined {
  return value === '' ? undefined : Number(value);
}

function parseRows(text: string): Row[] {
  const lines = text.trimEnd().split('\n');
  const header = lines.shift();
  if (header !== 'category\tcase\tmetric\tvalue\tmc_n\tlower95\tupper95') {
    throw new Error('unexpected statistical-validation header');
  }
  return lines.map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 7) {
      throw new Error(`row ${String(index + 2)} has ${String(fields.length)} fields`);
    }
    const value = Number(fields[3]);
    if (!Number.isFinite(value)) {
      throw new Error(`row ${String(index + 2)} has a non-finite value`);
    }
    return {
      category: fields[0] as string,
      case: fields[1] as string,
      metric: fields[2] as string,
      value,
      mcN: parseOptional(fields[4] as string),
      lower95: parseOptional(fields[5] as string),
      upper95: parseOptional(fields[6] as string),
    };
  });
}

const text = readFileSync(inputPath, 'utf8');
const rows = parseRows(text);
if (rows.length !== 66) {
  throw new Error(`expected 66 validation rows, found ${String(rows.length)}`);
}

function row(category: string, caseName: string, metric: string): Row {
  const matches = rows.filter(
    (entry) =>
      entry.category === category &&
      entry.case === caseName &&
      entry.metric === metric,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one row for ${category}/${caseName}/${metric}`);
  }
  return matches[0] as Row;
}

function close(actual: number, expected: number, tolerance = 1e-10): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `reference mismatch: production=${String(actual)} R=${String(expected)}`,
    );
  }
}

const centred = [0.24, 0.26, 0.25, 0.23, 0.27];
const shiftedT = oneSampleTTest(
  centred.map((value) => value + 0.1),
  0.25,
  'greater',
);
const tostResult = tost(centred, 0.2, 0.3, 0.05);
const holm = holmBonferroni([0.01, 0.04, 0.03, 0.005], 0.05);
const wilson = wilsonInterval(8, 10);

close(normalQuantile(0.975), row('reference', 'normal', 'qnorm-0.975').value);
close(
  studentTQuantile(0.975, 10),
  row('reference', 'student-t', 'qt-0.975-df10').value,
);
close(
  studentTCdf(2.228138851964, 10),
  row('reference', 'student-t', 'pt-2.228138851964-df10').value,
);
close(shiftedT.t, row('reference', 'one-sample-t', 't').value);
close(shiftedT.p, row('reference', 'one-sample-t', 'p-greater').value);
close(tostResult.pLower, row('reference', 'tost', 'p-lower').value);
close(tostResult.pUpper, row('reference', 'tost', 'p-upper').value);
close(tostResult.p, row('reference', 'tost', 'p-max').value);
holm.adjusted.forEach((value, index) => {
  close(value, row('reference', 'holm', `adjusted-${String(index + 1)}`).value);
});
close(wilson.lower, row('reference', 'wilson-8-of-10', 'lower').value);
close(wilson.upper, row('reference', 'wilson-8-of-10', 'upper').value);
close(
  binomialTest(4, 5, 0.5, 'greater').exactP,
  row('reference', 'binomial-4-of-5', 'greater-p').value,
);
close(
  quantileSorted([0, 1, 2, 3, 4], 0.025),
  row('reference', 'quantile-type7', 'q-0.025').value,
);
close(
  quantileSorted([0, 1, 2, 3, 4], 0.975),
  row('reference', 'quantile-type7', 'q-0.975').value,
);
close(logBeta(2, 3), row('reference', 'special', 'lbeta-2-3').value);
const welch = welchTTest(
  [1.2, 1.5, 1.7, 1.9, 2.2],
  [0.8, 1, 1.1, 1.3, 1.4, 1.5],
  'greater',
);
close(welch.t, row('reference', 'welch', 't').value);
close(welch.df, row('reference', 'welch', 'df').value);
close(welch.p, row('reference', 'welch', 'p-greater').value);
close(
  shannonEntropyBits([2, 3, 5]),
  row('reference', 'entropy-2-3-5', 'plugin-bits').value,
);
close(
  millerMadowEntropyBits([2, 3, 5]),
  row('reference', 'entropy-2-3-5', 'miller-madow-bits').value,
);
close(
  mutualInformationBits([
    [10, 0],
    [0, 10],
  ]),
  row('reference', 'mutual-information-perfect-binary', 'plugin-bits').value,
);
close(
  millerMadowMutualInformationBits([
    [10, 0],
    [0, 10],
  ]),
  row(
    'reference',
    'mutual-information-perfect-binary',
    'miller-madow-bits',
  ).value,
);
const betaFit = fitBetaBinomial([
  { seed: 's1', agreements: 1, probes: 10 },
  { seed: 's2', agreements: 9, probes: 10 },
  { seed: 's3', agreements: 2, probes: 10 },
  { seed: 's4', agreements: 8, probes: 10 },
  { seed: 's5', agreements: 5, probes: 10 },
]);
close(
  betaFit.mu,
  row('reference', 'beta-binomial-overdispersed', 'mu').value,
  1e-3,
);
close(
  betaFit.precision,
  row('reference', 'beta-binomial-overdispersed', 'precision').value,
  1e-3,
);
close(
  betaFit.logLikelihood,
  row('reference', 'beta-binomial-overdispersed', 'log-likelihood').value,
  1e-6,
);

for (const entry of rows.filter((candidate) => candidate.mcN !== undefined)) {
  if (
    entry.mcN === undefined ||
    entry.lower95 === undefined ||
    entry.upper95 === undefined ||
    !Number.isInteger(entry.mcN) ||
    entry.mcN < 1 ||
    entry.value < entry.lower95 ||
    entry.value > entry.upper95
  ) {
    throw new Error(`invalid Monte Carlo accounting for ${entry.case}/${entry.metric}`);
  }
}

if (
  row('coverage', 'wilson-binomial-p0.25-n200', 'contains-true-mean').lower95! <
    0.94 ||
  row('coverage', 'seed-t-beta-binomial-n25-sd0.05', 'contains-true-mean')
    .lower95! < 0.94
) {
  throw new Error('primary interval coverage fell below the 94% acceptance floor');
}
if (
  row(
    'coverage',
    'percentile-bootstrap-beta-binomial-n25-sd0.05-b999',
    'contains-true-mean',
  ).upper95! >= 0.95
) {
  throw new Error('percentile-bootstrap undercoverage finding did not reproduce');
}

for (const entry of rows.filter((candidate) => candidate.category === 'type-i')) {
  if (entry.value > 0.012) {
    throw new Error(`TOST boundary error exceeded tolerance for ${entry.case}`);
  }
}

if (
  row('clustering', 'beta-binomial-n25-sd0.10', 'pooled-episode-type-i')
    .lower95! <= 0.25 ||
  row('clustering', 'beta-binomial-n25-sd0.10', 'seed-level-type-i').upper95! >=
    0.05
) {
  throw new Error('clustering stress-test finding did not reproduce');
}

for (const entry of rows.filter(
  (candidate) =>
    candidate.category === 'full-e03' && candidate.metric === 'numeric-rule-power',
)) {
  if (entry.lower95! < 0.9) {
    throw new Error(`full E03 numeric power is below 90% for ${entry.case}`);
  }
}
for (const entry of rows.filter(
  (candidate) =>
    candidate.category === 'full-e03' &&
    candidate.metric === 'old-complete-rule-power',
)) {
  if (entry.upper95! >= 0.1) {
    throw new Error(`old high-tail incompatibility did not reproduce for ${entry.case}`);
  }
}

if (
  row('confirmatory-family', 'n100-d0.40', 'all-nine-holm-power').lower95! <
    0.9 ||
  row('confirmatory-family', 'n75-d0.40', 'all-nine-holm-power').upper95! >= 0.7
) {
  throw new Error('nine-member Holm sensitivity finding did not reproduce');
}

if (
  row(
    'invalid-runs',
    'n75-sd0.10-five-percent-as-failures',
    'numeric-rule-power',
  ).upper95! >= 0.01 ||
  row(
    'invalid-runs',
    'n75-reserve8-q0.05',
    'all-six-conditions-avoid-reserve-exhaustion',
  ).value < 0.9 ||
  row(
    'invalid-runs',
    'n75-reserve8-q0.10',
    'all-six-conditions-avoid-reserve-exhaustion',
  ).value >= 0.1
) {
  throw new Error('invalid-run sensitivity finding did not reproduce');
}

if (temporaryDirectory !== undefined) {
  const tracked = readFileSync(trackedPath, 'utf8');
  if (tracked !== text) {
    throw new Error('live R output differs from the tracked validation receipt');
  }
  rmSync(temporaryDirectory, { recursive: true });
}

const digest = createHash('sha256').update(text).digest('hex');
const scriptDigest = createHash('sha256')
  .update(readFileSync('scripts/validate-statistics.R'))
  .digest('hex');
if (
  protocol.independentReference.scriptSha256 !== scriptDigest ||
  protocol.independentReference.receiptSha256 !==
    createHash('sha256').update(readFileSync(trackedPath)).digest('hex')
) {
  throw new Error('statistical protocol hashes do not match script and receipt');
}
console.log(
  `Statistical validation passed: ${String(rows.length)} rows, 28 R reference values, ` +
    `coverage/type-I/clustering/full-rule/family/invalid-run checks, sha256:${digest}`,
);
