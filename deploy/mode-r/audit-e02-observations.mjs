import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyBundle } from '@ald/verifier';
import { canonicalJson } from '@ald/hashing';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { E02_PROBES, E02_ROWS_PER_STAGE, auditE02Rows, evaluateE02Probe } from './e02-observation-analysis.mjs';

const directory = process.argv[2];
assert.equal(process.argv.length, 3, 'usage: audit-e02-observations.mjs <retained-development-directory>');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const evidence = read(join(directory, 'development.json'));
assert.equal(evidence.classification, 'development-only');
assert.equal(evidence.researchFinding, false);
assert.equal(evidence.failure, null);
assert.equal(evidence.passed, true);
assert.equal(evidence.reports.length, 12);
assert.equal(evidence.captured.length, (2 * E02_ROWS_PER_STAGE + 2) * 2);
const bundle = join(directory, 'bundles/runs', evidence.runId);
const verification = await verifyBundle(bundle, { verifierVersion: 'e02-development-audit',
  now: () => new Date().toISOString(), writeReport: false });
assert.equal(verification.exitCode, 0);
const manifest = read(join(bundle, 'run-manifest.json'));
assert.equal(manifest.deploymentMode, evidence.mode);
assert.equal(manifest.runId, evidence.runId);
assert.equal(manifest.softwareCommit, evidence.softwareCommit);
const config = read(join(bundle, 'configuration/run-config.json'));
assert.equal(config.randomSeed, evidence.seed);
const engine = new ReferentialScenarioEngine({ version: 1, attributeCount: 2,
  valuesPerAttribute: 4, candidatesPerEpisode: 4, heldOutTypeCodes: [],
  symbolInventory: Array.from({ length: 32 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`),
  interactionMode: 'cooperative-signaling' }, config.randomSeed);
assert.equal(engine.bundleHash, manifest.scenarioBundleHash);
const events = (stream) => readFileSync(join(bundle, manifest.streams.find((s) => s.stream === stream).file), 'utf8')
  .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const turns = events('turns');
assert.equal(turns.length, 2 * E02_ROWS_PER_STAGE + 2);
const initialization = events('intervention').find((event) => event.reasonCode === 'learner-initialization');
const restore = read(join(bundle, 'analysis/semantic-leakage/restore.json'));
assert.deepEqual(restore, evidence.restoreRecord);
assert.equal(restore.snapshotTurn, E02_ROWS_PER_STAGE);
assert.equal(restore.restored.ok, true);
assert.equal(restore.restored.runs[0].turnMatches, true);
assert.equal(restore.restored.runs[0].prefix.ok, true);
assert.deepEqual(restore.restored.runs[0].policyMatches, { 'baby-a': true, 'baby-b': true });
assert.ok(events('intervention').some((event) => event.eventType === 'recovery'));
const rScript = `args <- as.numeric(commandArgs(TRUE)); k<-args[1]; n<-args[2]; kp<-args[3]; z<-qnorm(.95)
bound <- function(k) {p<-k/n; den<-1+z*z/n; center<-(p+z*z/(2*n))/den; half<-z*sqrt(p*(1-p)/n+z*z/(4*n*n))/den; c(max(0,center-half),min(1,center+half))}
cat(format(c(bound(k),bound(kp)),digits=17),sep="\\n")`;
const recomputed = [];
for (const stage of ['before-restore', 'after-restore']) {
  const reported = read(join(bundle, `analysis/semantic-leakage/${stage}-reports.json`));
  for (const role of ['baby-a', 'baby-b']) {
    const input = read(join(bundle, `analysis/semantic-leakage/${stage}-${role}-inputs.json`));
    assert.equal(input.classification, 'development-only');
    assert.equal(input.stage, stage);
    assert.equal(input.role, role);
    assert.deepEqual(input.provenance, initialization.details.provenance[role]);
    const captured = evidence.captured.filter((row) => row.stage === stage && row.observation.recipient === role
      && row.observation.turn < 2 * E02_ROWS_PER_STAGE);
    assert.deepEqual(input.rows, captured);
    for (const row of input.rows) {
      const turn = turns[row.observation.turn];
      assert.deepEqual(input.instances[row.observation.scenarioRef], engine.generate(turn.turn, 'train', turn.roles));
    }
    auditE02Rows(input.rows, role, stage, turns, input.instances);
    for (const probe of E02_PROBES) {
      const result = evaluateE02Probe(input.rows, input.provenance, `${evidence.seed}/${stage}/${role}/${probe}`, probe);
      const report = { stage, role, ...result };
      assert.equal(result.passed, true);
      assert.equal(canonicalJson(reported.find((r) => r.role === role && r.probe === probe)), canonicalJson(report));
      assert.equal(canonicalJson(evidence.reports.find((r) => r.stage === stage && r.role === role && r.probe === probe)), canonicalJson(report));
      const values = result.result.linearProbe;
      const n = values.testRows, k = Math.round(values.observedAccuracy * n), kp = Math.round(values.positiveControl.observedAccuracy * n);
      const bounds = execFileSync('/home/linuxbrew/.linuxbrew/bin/Rscript', ['--vanilla', '-e', rScript, String(k), String(n), String(kp)], { encoding: 'utf8' }).trim().split(/\s+/u).map(Number);
      assert.equal(bounds.length, 4);
      const heldOut = result.split.test.map((index) => input.rows[index].label);
      const majority = Math.max(...Object.values(Object.groupBy(heldOut, (label) => label)).map((labels) => labels.length)) / n;
      assert.equal(majority, values.majorityBaselineAccuracy);
      assert.ok(Math.abs(bounds[1] - majority - values.advantageUpperBound) < 1e-8);
      assert.ok(Math.abs(bounds[2] - majority - values.positiveControl.advantageLowerBound) < 1e-8);
      recomputed.push({ stage, role, probe, n, k, kp, rBounds: bounds });
      console.log(`recomputed ${stage}/${role}/${probe}: input binding, model, split, and R bounds pass`);
    }
  }
}
const rust = JSON.parse(execFileSync(resolve('.artifacts/cargo-target/release/ald-integrity-auditor'), [bundle], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
assert.equal(rust.integrityPass, true);
assert.equal(rust.anchored, true);
console.log(JSON.stringify({ classification: 'development-only', researchFinding: false,
  probesRecomputed: recomputed.length, independentWilsonReference: 'R qnorm and direct Wilson formula',
  estimatorReplay: 'same implementation, not independent model training', rust, passed: true }));
