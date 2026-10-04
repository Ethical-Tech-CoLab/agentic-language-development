/**
 * Exact single-call R08 timing recipe (UNEXECUTED until fresh admission passes).
 *
 * Measures one selectLv01Power call (6 candidates x 7 components x 30,000
 * inner reps) on a PINNED synthetic pilot — no outer runs, no sampling.
 * Pinned inputs: all-1x-reference pilot (incremental SD 0.02, fidelity SD
 * 0.01, five contrasts SD 0.05; mean 0; deviation SD*sqrt(19/20);
 * 10 below + 10 above per component; invalidSlots 0), seed
 * 'lv01-power-timing/v1', 3 sequential trials (median reported).
 *
 * ADMISSION (full calculation — 2 GiB is the retained host RESERVE,
 * never the launch threshold alone): run ONLY when operator-authorized AND
 *   MemAvailable >= 2048 MiB (reserve) + 1.5 x P_stip + policy charges
 * where P_stip = 512 MiB STIPULATED peak for this recipe (grounded in the
 * preserved power log: maxRSS 271 MiB for 4 calls + vitest harness;
 * 512 covers 1.5 x 271 = 407 + margin; a single node call runs lower).
 * Unknown peak => REFUSE (no run without a stipulated P); stop and
 * report a breach if observed maxRSS exceeds P_stip. R01-B/R06 stay
 * gated regardless. Exact admitted execution:
 *   free -m; git log --oneline -1   # verify the inequality above first
 *   /usr/bin/time -v nice -n 15 ionice -c 3 \
 *     timeout -k 10s 900s node scripts/time-lv01-power-call.mjs | tee plans/timing-<UTC>.log
 * Record stdout JSON + wall/CPU/peak lines into the OC cost table (§7).
 */
import { performance } from 'node:perf_hooks';

import { LV01_COMPONENT_IDS, reduceLv01Pilot, selectLv01Power } from '@ald/analysis';

const SEED = 'lv01-power-timing/v1';
const TRIALS = 3;
const REFERENCE_SD = {
  incremental: 0.02,
  fidelity: 0.01,
  disabled: 0.05,
  constant: 0.05,
  random: 0.05,
  shuffled: 0.05,
  intervention: 0.05,
};

const pilot = reduceLv01Pilot(
  LV01_COMPONENT_IDS.map((component) => {
    const sd = REFERENCE_SD[component];
    const deviation = sd * Math.sqrt(19 / 20);
    return {
      component,
      values: Array.from({ length: 20 }, (_, index) =>
        index < 10 ? 0 - deviation : 0 + deviation,
      ),
    };
  }),
  0,
);
if (pilot.status !== 'eligible') {
  throw new Error(`timing pilot must be eligible, got ${pilot.status}`);
}

const trialsMs = [];
let firstSelection = null;
for (let trial = 0; trial < TRIALS; trial += 1) {
  const start = performance.now();
  const selection = selectLv01Power(pilot, SEED);
  trialsMs.push(performance.now() - start);
  if (trial === 0) {
    firstSelection = selection;
  }
}
const sorted = [...trialsMs].sort((a, b) => a - b);
const selection = firstSelection;
console.log(
  JSON.stringify({
    seed: SEED,
    trialsMs,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    selectedDyads: selection.selectedDyads,
    reserveDyads: selection.reserveDyads,
    node: process.version,
  }),
);
