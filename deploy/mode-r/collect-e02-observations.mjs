import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import { InMemorySignerRegistry } from '@ald/hashing';
import { createIsolatedAdapterFactory } from '@ald/isolation';
import { PreRegistrationBindingSchema } from '@ald/types';
import { buildRunConfig } from '@ald/lifecycle';
import { createProductionRuntime } from '@ald/orchestrator';
import { autoRestore, takeSnapshot } from '@ald/ops';
import { ReferentialScenarioEngine, ScenarioBundleRegistry, registerGeneratorConfig } from '@ald/scenario';
import { E02_ANALYSIS_VERSION, E02_LABELS, E02_PROBES, E02_ROWS_PER_STAGE,
  E02_REGISTERED_ROWS_PER_STAGE, E02_REGISTERED_ANALYSIS_VERSION, auditE02Rows, evaluateE02Probe } from './e02-observation-analysis.mjs';

export function e02ProbeEvaluation(profile, reportCount) {
  if (profile === 'smoke') return 'not-run-short-transport-smoke';
  if (reportCount === 12) return 'completed';
  if (reportCount === 0) return 'not-reached';
  return 'incomplete';
}

export async function collectE02Observations({ directory, seed, mode, profile, softwareCommit, registration, slot }) {
  const registered = profile === 'registered';
  assert.ok(['full', 'smoke', 'registered'].includes(profile));
  assert.match(seed, /^[a-f0-9]{64}$/u);
  assert.match(softwareCommit, /^[a-f0-9]{40}$/u);
  assert.ok(['prototype', 'research-grade'].includes(mode));
  if (registered) {
    assert.equal(mode, 'research-grade');
    assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 5);
    registration = PreRegistrationBindingSchema.parse(registration);
    assert.equal(registration.registrationClass, 'qualification');
    assert.equal(registration.registrationAuthority, 'repository-native');
    assert.equal(registration.preRunAnchor.anchorClass, 'simulated');
    assert.match(directory, /^\/evidence\/registered-e02-v2-[1-5]$/u);
    assert.equal(directory, '/evidence/registered-e02-v2-' + slot);
  } else {
    assert.equal(registration, undefined);
    assert.equal(slot, undefined);
    assert.match(directory, /^(evidence\/development|\/evidence)\/e02-[a-z0-9-]+$/u);
  }
  const sampleCount = registered ? E02_REGISTERED_ROWS_PER_STAGE : profile !== 'smoke' ? E02_ROWS_PER_STAGE : 4;
  const classification = registered ? 'prospectively-registered-software-qualification' : 'development-only';
  const analysisVersion = registered ? E02_REGISTERED_ANALYSIS_VERSION : E02_ANALYSIS_VERSION;
  const runId = registered ? 'registered-e02-v2-' + slot : 'e02-development';
  const root = resolve(directory);
  const controllerSources = await Promise.all(['collect-e02-observations.mjs', 'e02-observation-analysis.mjs']
    .map(async (file) => ({ file, sha256: createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex') })));
  await mkdir(root); // Every attempted run, including failures, reserves its directory.
  const clock = { now: () => new Date().toISOString() };
  const signers = InMemorySignerRegistry.generate(runId);
  const instances = {};
  const captured = new Map();
  const reports = [];
  const factories = [];
  const topology = [];
  let production;
  let restoreRecord = null;
  let containerResourceUsage = null;
  let resourceMeasurementFailure = null;
  let failure = null;
  let failureStage = 'initialization';
  const started = performance.now();
  const bundleRoot = join(root, 'bundles');

  function openRuntime() {
    const chain = new FakeChainTransport({ endpointLabel: registered ? 'e02-registration-simulation' : 'e02-development-simulation' });
    const publisher = new BaseAnchorPublisher({ transport: chain, anchorClass: 'simulated', clock,
      evidence: { listRuns: () => production.runtime.listRuns().map((run) => run.runId),
        insertAnchorReceipt: (receipt) => production.runtime.writerFor(receipt.runId).insertAnchorReceipt(receipt),
        readCheckpoints: (id) => production.runtime.writerFor(id).readCheckpoints(id),
        readAnchorReceipts: (id) => production.runtime.writerFor(id).readAnchorReceipts(id) },
      anchorAddress: `0x${'42'.repeat(20)}`, finalityPolicy: '1-confirmation',
      retry: { attempts: 2, initialBackoffMs: 0, maxBackoffMs: 0, sleep: async () => chain.mineBlock() },
      confirmationPoll: { attempts: 2, intervalMs: 0 } });
    const registry = new ScenarioBundleRegistry({ directory: join(bundleRoot, 'scenario-registry'), clock });
    return createProductionRuntime({ databasePath: join(root, 'evidence.sqlite'), bundleRoot,
      softwareCommit, clock, signerProvider: () => signers, allowUnanchored: false,
      anchorPolicy: 'required', anchorPublisher: publisher, scenarioBundleRegistry: registry,
      scenarioFactory: (config) => {
        const engine = new ReferentialScenarioEngine({ version: 1, attributeCount: 2,
          valuesPerAttribute: 4, candidatesPerEpisode: 4, heldOutTypeCodes: [],
          symbolInventory: Array.from({ length: 32 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`),
          interactionMode: 'cooperative-signaling' }, config.randomSeed);
        registerGeneratorConfig({ ...engine.config }, { registry });
        const generate = engine.generate.bind(engine);
        engine.generate = (...args) => {
          const instance = generate(...args);
          if (instances[instance.scenarioRef]) assert.deepEqual(instances[instance.scenarioRef], instance);
          instances[instance.scenarioRef] = structuredClone(instance);
          return instance;
        };
        return engine;
      },
      ...(mode === 'research-grade' ? { adapterFactoryFor: (_config, role) => {
        const factory = createIsolatedAdapterFactory({ track: 'scratch-rl', transport: 'container',
          endpoint: { host: role, port: 4318, attempts: 40, retryDelayMs: 250, timeoutMs: 1000, hostLabel: role },
          timing: 'normalized', deadlineMs: 1000 });
        factories.push(factory);
        return factory;
      } } : {}),
    });
  }

  function captureAdapters() {
    if (mode === 'research-grade') {
      const containerIds = Object.values(production.runtime.adaptersFor(runId)).map((adapter) => adapter.isolation.containerId);
      assert.equal(containerIds.length, 2);
      assert.ok(containerIds.every((id) => typeof id === 'string' && id.length > 0));
      assert.equal(new Set(containerIds).size, 2);
      topology.push({ stage: topology.length === 0 ? 'before-restore' : 'after-restore', containerIds });
    }
    for (const [role, adapter] of Object.entries(production.runtime.adaptersFor(runId))) {
      const observe = adapter.observe.bind(adapter);
      adapter.observe = async (observation) => {
        const key = `${role}/${observation.turn}`;
        assert.equal(captured.has(key), false, `repeated observation: ${key}`);
        const row = { observation: structuredClone(observation), delivered: false,
          stage: observation.turn < sampleCount ? 'before-restore' : 'after-restore' };
        captured.set(key, row);
        const begin = performance.now();
        try { await observe(observation); row.delivered = true; }
        finally { row.observeDurationMs = performance.now() - begin; }
      };
      const act = adapter.act.bind(adapter);
      adapter.act = async (budget) => {
        const row = captured.get(`${role}/${budget.turn}`);
        assert.ok(row);
        assert.equal(row.budget, undefined, 'repeated action budget');
        row.budget = structuredClone(budget);
        return act(budget);
      };
    }
  }

  async function analyseStage(stage) {
    const runtime = production.runtime;
    const initialization = runtime.auditLog(runId).find((event) => event.reasonCode === 'learner-initialization');
    const provenance = initialization.details.provenance;
    const stageReports = [];
    for (const role of ['baby-a', 'baby-b']) {
      const rows = [...captured.values()].filter((row) => row.stage === stage && row.observation.recipient === role);
      for (const row of rows) {
        const truth = instances[row.observation.scenarioRef].groundTruth;
        row.label = E02_LABELS[truth.attributeCodes[String(truth.targetTypeCode)][0]];
      }
      auditE02Rows(rows, role, stage, runtime.turnRecords(runId), instances, sampleCount);
      await runtime.attachAnalysis({ runId, path: `analysis/semantic-leakage/${stage}-${role}-inputs.json`,
        kind: 'semantic-leakage-battery', analysisVersion,
        actorId: registered ? 'researcher:e02' : 'researcher:e02-development', reasonCode: 'e02-observed-inputs',
        value: { classification, stage, role, rows, provenance: provenance[role],
          instances: Object.fromEntries(rows.map((row) => [row.observation.scenarioRef, instances[row.observation.scenarioRef]])) } });
      for (const probe of E02_PROBES) {
        const result = evaluateE02Probe(rows, provenance[role], `${seed}/${stage}/${role}/${probe}`, probe, sampleCount);
        const report = { stage, role, ...result };
        reports.push(report);
        stageReports.push(report);
        console.log(`${stage} ${role} ${probe}: ${result.passed ? 'pass' : 'fail'}`);
      }
    }
    await runtime.attachAnalysis({ runId, path: `analysis/semantic-leakage/${stage}-reports.json`,
      kind: 'semantic-leakage-battery', analysisVersion,
      actorId: registered ? 'researcher:e02' : 'researcher:e02-development', reasonCode: 'e02-observed-probes', value: stageReports });
  }

  async function sampleContainerResources(scope) {
    const peakBytes = Number((await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim());
    const cpu = Object.fromEntries((await readFile('/sys/fs/cgroup/cpu.stat', 'utf8')).trim().split('\n')
      .map((line) => { const [key, value] = line.split(' '); return [key, Number(value)]; }));
    assert.ok(Number.isSafeInteger(peakBytes) && peakBytes > 0);
    assert.ok(Number.isSafeInteger(cpu.usage_usec) && cpu.usage_usec > 0);
    return { peakBytes, cpuUsageMicroseconds: cpu.usage_usec, scope };
  }

  try {
    production = openRuntime();
    failureStage = 'run-creation';
    await production.runtime.createRun(buildRunConfig({ runId, experimentId: 'E02', randomSeed: seed,
      deploymentMode: mode, babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' }, learningSignal: 'extrinsic-task',
      maxTurnsPerRun: 2 * sampleCount + 1, evaluationTurns: 1, checkpointEventInterval: 1024,
      turnResponseBudgetMs: 1000, protocolGitCommit: softwareCommit,
      ...(registered ? { registrationClass: 'qualification', preRegistrationHash: registration.preRegistrationHash } : {}) }),
      registered ? { preRegistration: registration } : {});
    captureAdapters();
    for (const stage of ['before-restore', 'after-restore']) {
      failureStage = `${stage}-collection`;
      for (let index = 0; index < sampleCount; index++) {
        await production.runtime.step(runId);
        if ((index + 1) % 100 === 0) console.log(`${stage}: ${index + 1}/${sampleCount} turns`);
      }
      if (profile !== 'smoke') {
        failureStage = `${stage}-analysis`;
        await analyseStage(stage);
      }
      if (stage === 'before-restore') {
        failureStage = 'snapshot';
        const taken = await takeSnapshot(production.runtime, join(root, 'snapshots'), { clock, softwareCommit });
        for (const factory of factories) await factory.dispose();
        production.close();
        production = undefined;
        production = openRuntime();
        failureStage = 'restore';
        const restored = await autoRestore(() => production.runtime, { directory: join(root, 'snapshots'), bundleRoot });
        assert.equal(restored.ok, true);
        assert.equal(restored.runs.length, 1);
        assert.equal(restored.runs[0].turnMatches, true);
        assert.equal(restored.runs[0].prefix.ok, true);
        assert.deepEqual(restored.runs[0].policyMatches, { 'baby-a': true, 'baby-b': true });
        restoreRecord = { snapshotDigest: taken.snapshot.digest, snapshotTurn: taken.snapshot.runs[0].turn,
          restored, scope: 'Runtime/database handle restart with original in-memory qualification signers; not a new operator or operating-system restart' };
        captureAdapters();
      }
    }
    failureStage = 'sealing';
    await production.runtime.attachAnalysis({ runId, path: 'analysis/semantic-leakage/restore.json',
      kind: 'semantic-leakage-battery', analysisVersion,
      actorId: registered ? 'researcher:e02' : 'researcher:e02-development', reasonCode: 'e02-actual-runtime-restore', value: restoreRecord });
    await production.runtime.runToCompletion(runId);
    const bundle = production.runtime.bundleDirFor(runId);
    const verification = JSON.parse(await readFile(join(bundle, 'verification-report.json'), 'utf8'));
    assert.equal(verification.exitCode, 0);
    assert.equal(production.runtime.turnRecords(runId).length, 2 * sampleCount + 2);
    if (mode === 'research-grade') {
      containerResourceUsage = await sampleContainerResources(
        'Nursery cgroup sampled after bundle verification, before cleanup/final-summary serialization; excludes learner containers and host-side audit',
      );
    }
    failureStage = 'complete';
  } catch (error) { failure = `${error.name}: ${error.message}`; console.error(failure); }
  finally {
    if (mode === 'research-grade' && containerResourceUsage === null) {
      try {
        containerResourceUsage = await sampleContainerResources(
          `Nursery cgroup sampled after failure during ${failureStage}; excludes learner containers and host-side audit`,
        );
      } catch (error) {
        resourceMeasurementFailure = `${error.name}: ${error.message}`;
      }
    }
    const adapterDiagnostics = factories.flatMap((factory) => factory.adapters.map((adapter) => ({
      isolation: adapter.isolation,
      diagnostics: adapter.diagnostics,
      transportStats: adapter.transportStats,
    })));
    let turnRecords = null;
    try { turnRecords = production?.runtime.turnRecords(runId).length ?? null; }
    catch { turnRecords = null; }
    if (production) production.close();
    for (const factory of factories) await factory.dispose();
    const probeEvaluation = e02ProbeEvaluation(profile, reports.length);
    await writeFile(join(root, registered ? 'slot.json' : 'development.json'), JSON.stringify({ classification, researchFinding: false,
      runId, seed, mode, profile, sampleCount, softwareCommit, controllerSources,
      ...(registered ? { slot, registrationHash: registration.preRegistrationHash } : {}),
      sourceBoundary: registered ? 'Frozen sources checked by the registered host runner' : 'Unregistered development source; base commit does not assert a clean execution tree',
      probeEvaluation,
      captured: [...captured.values()], reports, restoreRecord, topology, failure,
      executionProgress: { stage: failureStage, turnRecords, capturedRows: captured.size,
        completedProbeReports: reports.length, restoreCompleted: restoreRecord !== null },
      adapterDiagnostics, resourceMeasurementFailure,
      passed: failure === null && reports.length === (profile !== 'smoke' ? 12 : 0) && reports.every((report) => report.passed),
      wallMilliseconds: performance.now() - started, resourceUsage: process.resourceUsage(), containerResourceUsage }, null, 2));
  }
  return { passed: failure === null && reports.length === (profile !== 'smoke' ? 12 : 0) && reports.every((report) => report.passed), failure };
}
