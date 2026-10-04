import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { repoRoot, venvPython } from './resolve-venv-python.mjs';

import {
  LV01_CANDIDATE_DYADS,
  LV01_COMPONENT_IDS,
  LV01_PILOT_UPPER_SD_FACTOR,
  reduceLv01Pilot,
  selectLv01Power,
} from '@ald/analysis';

const SAMPLE_SD = 0.08;
const mean = 0;
const deviation = SAMPLE_SD * Math.sqrt(19 / 20);
const pilot = reduceLv01Pilot(
  LV01_COMPONENT_IDS.map((component) => ({
    component,
    values: Array.from({ length: 20 }, (_, index) =>
      index < 10 ? mean - deviation : mean + deviation),
  })),
  0,
);
assert.equal(pilot.status, 'eligible');
const upperSd = pilot.upperSdByComponent.fidelity;
const referenceLines = execFileSync(venvPython(), [resolve(repoRoot, 'scripts/validate-lv01-reference.py'), String(upperSd)], { encoding: 'utf8' }).trim().split('\n');
const [factorLabel, factorRaw] = referenceLines.shift().split(',');
assert.equal(factorLabel, 'factor');
assert.ok(Math.abs(Number(factorRaw) - LV01_PILOT_UPPER_SD_FACTOR) <= 1e-12, 'Python and TypeScript pilot dispersion factors disagree');
const reference = new Map(referenceLines.map((line) => {
  const [n, component, critical, power] = line.split(',');
  return [`${n}/${component}`, { critical: Number(critical), power: Number(power) }];
}));
const selection = selectLv01Power(pilot, 'lv01-power-reference-fixture/v2');
assert.deepEqual(selection.rows.map((row) => row.dyads), LV01_CANDIDATE_DYADS);
let comparisons = 0;
for (const row of selection.rows) {
  for (const component of LV01_COMPONENT_IDS) {
    const expected = reference.get(`${row.dyads}/${component}`);
    assert.ok(expected && Number.isFinite(expected.power) && Number.isFinite(expected.critical));
    const observed = row.successes[component] / 30_000;
    const se = Math.sqrt(expected.power * (1 - expected.power) / 30_000);
    assert.ok(Math.abs(observed - expected.power) <= Math.max(6 * se, 0.002), `${row.dyads}/${component} differs from independent Python power`);
    comparisons += 1;
  }
}
console.log(`LV01 power reference valid: ${comparisons} Python comparisons; no pilot or study data used`);
