import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyBundle } from '@ald/verifier';
import { canonicalJson } from '@ald/hashing';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { E02_PROBES, E02_ROWS_PER_STAGE, E02_REGISTERED_ROWS_PER_STAGE,
  auditE02Rows, evaluateE02Probe } from './e02-observation-analysis.mjs';

export async function auditE02Observations(directory, expected) {
  const registered = expected !== undefined;
  const sampleCount = registered ? E02_REGISTERED_ROWS_PER_STAGE : E02_ROWS_PER_STAGE;
  const classification = registered ? 'prospectively-registered-software-qualification' : 'development-only';
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const evidence = read(join(directory, registered ? 'slot.json' : 'development.json'));
  assert.equal(evidence.classification, classification);
  assert.equal(evidence.researchFinding, false);
  assert.equal(evidence.failure, null);
  if (registered) {
    assert.equal(evidence.sampleCount, sampleCount);
    assert.equal(evidence.profile, 'registered');
    assert.equal(evidence.slot, expected.slot);
    assert.equal(evidence.seed, expected.seed);
    assert.equal(evidence.softwareCommit, expected.executionCommit);
    assert.equal(evidence.registrationHash, expected.binding.preRegistrationHash);
    assert.equal(evidence.runId, `registered-e02-${expected.slot}`);
    assert.equal(evidence.mode, 'research-grade');
    assert.deepEqual(evidence.topology.map((entry) => entry.stage), ['before-restore', 'after-restore']);
    for (const entry of evidence.topology) {
      assert.equal(entry.containerIds.length, 2);
      assert.equal(new Set(entry.containerIds).size, 2);
      assert.ok(entry.containerIds.every((id) => typeof id === 'string' && id.length > 0));
    }
    assert.deepEqual(evidence.topology[0].containerIds, evidence.topology[1].containerIds);
    assert.ok(evidence.containerResourceUsage.peakBytes > 0 && evidence.containerResourceUsage.peakBytes <= 2 * 1024 ** 3);
    assert.ok(evidence.containerResourceUsage.cpuUsageMicroseconds > 0);
  } else {
    // The first retained full-development record predates these annotations.
    // Exact row/turn/report counts and signed inputs below establish its design;
    // an explicit contradictory annotation still fails, and smoke cannot pass.
    assert.ok(evidence.sampleCount === undefined || evidence.sampleCount === sampleCount);
    assert.ok(evidence.profile === undefined || evidence.profile === 'full');
  }
  assert.equal(evidence.reports.length, 12);
  assert.equal(evidence.captured.length, (2 * sampleCount + 2) * 2);
  const bundle = join(directory, 'bundles/runs', evidence.runId);
  const verification = await verifyBundle(bundle, { verifierVersion: 'e02-development-audit',
    now: () => new Date().toISOString(), writeReport: false });
  assert.equal(verification.exitCode, 0);
  const manifest = read(join(bundle, 'run-manifest.json'));
  assert.equal(manifest.deploymentMode, evidence.mode);
  assert.equal(manifest.runId, evidence.runId);
  assert.equal(manifest.softwareCommit, evidence.softwareCommit);
  if (registered) assert.deepEqual(manifest.preRegistration, expected.binding);
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
  assert.equal(turns.length, 2 * sampleCount + 2);
  const initialization = events('intervention').find((event) => event.reasonCode === 'learner-initialization');
  const restore = read(join(bundle, 'analysis/semantic-leakage/restore.json'));
  assert.deepEqual(restore, evidence.restoreRecord);
  assert.equal(restore.snapshotTurn, sampleCount);
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
      assert.equal(input.classification, classification);
      assert.equal(input.stage, stage);
      assert.equal(input.role, role);
      assert.deepEqual(input.provenance, initialization.details.provenance[role]);
      const captured = evidence.captured.filter((row) => row.stage === stage && row.observation.recipient === role
        && row.observation.turn < 2 * sampleCount);
      assert.deepEqual(input.rows, captured);
      for (const row of input.rows) {
        const turn = turns[row.observation.turn];
        assert.deepEqual(input.instances[row.observation.scenarioRef], engine.generate(turn.turn, 'train', turn.roles));
      }
      auditE02Rows(input.rows, role, stage, turns, input.instances, sampleCount);
      for (const probe of E02_PROBES) {
        const result = evaluateE02Probe(input.rows, input.provenance, `${evidence.seed}/${stage}/${role}/${probe}`, probe, sampleCount);
        const report = { stage, role, ...result };
        if (!registered) assert.equal(result.passed, true);
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
        recomputed.push({ stage, role, probe, n, k, kp, rBounds: bounds, passed: result.passed });
        console.log(`recomputed ${stage}/${role}/${probe}: input binding, model, split, and R bounds pass`);
      }
    }
  }
  const rustPath = registered ? expected.rustPath : resolve('.artifacts/cargo-target/release/ald-integrity-auditor');
  if (registered) assert.equal(createHash('sha256').update(readFileSync(rustPath)).digest('hex'), expected.rustSha256);
  const rust = JSON.parse(execFileSync(rustPath, [bundle], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000 }));
  assert.equal(rust.integrityPass, true);
  assert.equal(rust.anchored, true);
  const passed = recomputed.length === 12 && recomputed.every((probe) => probe.passed);
  assert.equal(evidence.passed, passed);
  return { classification, researchFinding: false,
    probesRecomputed: recomputed.length, independentWilsonReference: 'R qnorm and direct Wilson formula',
    estimatorReplay: 'same implementation, not independent model training', rust, passed,
    probes: recomputed, bundleManifestHash: verification.bundleManifestHash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'usage: audit-e02-observations.mjs <retained-development-directory>');
  console.log(JSON.stringify(await auditE02Observations(process.argv[2])));
}
