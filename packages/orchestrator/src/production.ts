/**
 * Production wiring of the Nursery Controller runtime — Phase D (BACKLOG
 * ALD-072): the real SQLite-backed evidence store (`@ald/evidence`), the real
 * `EvidenceCheckpointService` Merkle/witness checkpoint service
 * (`@ald/checkpoint`), the real independent `@ald/verifier`, and, per
 * SPECIFICATION.md §5.1/§7.2/§13.4, `anchorPolicy: 'skip'`.
 *
 * The default is an explicitly unanchored Prototype Mode qualification path.
 * A caller running Research-Grade Mode must inject an `anchorPublisher` and
 * use `anchorPolicy: 'required'`; local topology qualification may use the
 * production publisher with a clearly identified fake transport, while a
 * public study must use the authorized chain path.
 *
 * This construction deliberately mirrors
 * `twins/packs/nursery/behavior/pack.ts`'s `init(context)`, which wires the
 * identical three services for its DTSF routes. Persistent study signers enter
 * only through the injected `signerProvider`; the production constructor does
 * not read or create plaintext key directories.
 */
import type {
  AnchorPublisher,
  BabyRole,
  CheckpointService,
  Clock,
  LearnerAdapterFactory,
  RunConfig,
  SignerRegistry,
  VerificationReport,
} from '@ald/types';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemorySignerRegistry } from '@ald/hashing';
import {
  openEvidenceDatabase,
  type EvidenceDatabase,
  type SqliteEvidenceWriter,
} from '@ald/evidence';
import { EvidenceCheckpointService } from '@ald/checkpoint';
import { verifyBundle, VERIFIER_VERSION } from '@ald/verifier';
import { ScenarioBundleRegistry } from '@ald/scenario';

import {
  createNurseryRuntime,
  NurseryRuntimeImpl,
  type NurseryRuntimeOptions,
} from './nursery-runtime.js';

export interface ProductionRuntimeOptions {
  /** Path to the SQLite evidence store; created if it does not exist. */
  databasePath: string;
  /** Bundles are written to `<bundleRoot>/runs/<runId>`. */
  bundleRoot: string;
  softwareCommit: string;
  /**
   * Persistent per-run signer boundary. Public studies inject a provider
   * materialized through Fort. Omit only for short-lived qualification runs.
   */
  signerProvider?: (runId: string) => SignerRegistry;
  clock?: Clock;
  /**
   * Passed straight through to `verifyBundle`. Default `true`: this runtime
   * never anchors (see module doc), so an unanchored tail must be a reported
   * note rather than an automatic verifier failure, or every run would fail
   * verification for the one deviation it already declares honestly.
   */
  allowUnanchored?: boolean;
  learnerOptions?: NurseryRuntimeOptions['learnerOptions'];
  /** Builds the role-specific adapter, including real container transports. */
  adapterFactoryFor?: (
    config: RunConfig,
    role: BabyRole,
  ) => LearnerAdapterFactory;
  anchorPublisher?: AnchorPublisher;
  anchorPolicy?: 'required' | 'skip';
  scenarioFactory?: NurseryRuntimeOptions['scenarioFactory'];
  /**
   * Approved scenario-bundle registry. Defaults to a persistent registry
   * under `bundleRoot`; inject a pre-populated registry with a custom factory.
   */
  scenarioBundleRegistry?: ScenarioBundleRegistry;
  retryBudget?: number;
}

export interface ProductionRuntime {
  runtime: NurseryRuntimeImpl;
  database: EvidenceDatabase;
  close(): void;
}

/**
 * Builds one production `NurseryRuntimeImpl` over one open evidence store.
 *
 * `checkpointFactory` and `proofWriter` share one `CheckpointService` per run:
 * `NurseryRuntimeImpl.createRun` calls `signerProvider(runId)` and then
 * `checkpointFactory(evidence, signers)` synchronously, with no `await`
 * between the two calls (verified against `nursery-runtime.ts`), so recording
 * the run id in `signerProvider` and reading it back in `checkpointFactory`
 * is safe even if a caller starts two `createRun` calls without awaiting the
 * first — JS never preempts that synchronous span, so the second call's
 * prefix cannot interleave with the first's.
 */
export function createProductionRuntime(
  options: ProductionRuntimeOptions,
): ProductionRuntime {
  const database = openEvidenceDatabase(options.databasePath);
  const clock: Clock = options.clock ?? {
    now: () => new Date().toISOString(),
  };
  const allowUnanchored = options.allowUnanchored ?? true;
  const scenarioBundleRegistry =
    options.scenarioBundleRegistry ??
    new ScenarioBundleRegistry({
      directory: join(options.bundleRoot, 'scenario-registry'),
      clock,
    });

  let pendingRunId: string | undefined;
  const checkpointServices = new Map<string, EvidenceCheckpointService>();

  const signerProvider = (runId: string): SignerRegistry => {
    pendingRunId = runId;
    return options.signerProvider?.(runId) ?? InMemorySignerRegistry.generate(runId);
  };

  const checkpointFactory = (
    evidence: SqliteEvidenceWriter,
    signers: SignerRegistry,
  ): CheckpointService => {
    const runId = pendingRunId;
    if (runId === undefined) {
      throw new Error(
        'createProductionRuntime: checkpointFactory invoked before ' +
          'signerProvider — NurseryRuntimeImpl.createRun ordering invariant ' +
          'violated',
      );
    }
    const service = new EvidenceCheckpointService({
      evidence,
      signers,
      clock,
      softwareCommit: options.softwareCommit,
    });
    checkpointServices.set(runId, service);
    return service;
  };

  const proofWriter = async (
    runId: string,
    bundleDir: string,
  ): Promise<void> => {
    const service = checkpointServices.get(runId);
    if (service === undefined) {
      throw new Error(
        `createProductionRuntime: no checkpoint service registered for run "${runId}"`,
      );
    }
    await service.writeProofFiles(runId, bundleDir);
  };

  const verifier = async (bundleDir: string): Promise<VerificationReport> => {
    const manifest = JSON.parse(
      await readFile(join(bundleDir, 'run-manifest.json'), 'utf8'),
    ) as { parentRunId?: unknown };
    const parentBundleDir =
      typeof manifest.parentRunId === 'string'
        ? join(options.bundleRoot, 'runs', manifest.parentRunId)
        : undefined;
    return verifyBundle(bundleDir, {
      verifierVersion: VERIFIER_VERSION,
      now: () => clock.now(),
      allowUnanchored,
      ...(parentBundleDir === undefined ? {} : { parentBundleDir }),
    });
  };

  const runtime = createNurseryRuntime({
    database,
    softwareCommit: options.softwareCommit,
    bundleRoot: options.bundleRoot,
    checkpointFactory,
    signerProvider,
    clock,
    anchorPolicy: options.anchorPolicy ?? 'skip',
    verifier,
    proofWriter,
    scenarioBundleRegistry,
    ...(options.adapterFactoryFor === undefined
      ? {}
      : { adapterFactoryFor: options.adapterFactoryFor }),
    ...(options.anchorPublisher === undefined
      ? {}
      : { anchorPublisher: options.anchorPublisher }),
    ...(options.learnerOptions === undefined
      ? {}
      : { learnerOptions: options.learnerOptions }),
    ...(options.scenarioFactory === undefined
      ? {}
      : { scenarioFactory: options.scenarioFactory }),
    ...(options.retryBudget === undefined
      ? {}
      : { retryBudget: options.retryBudget }),
  });

  return {
    runtime,
    database,
    close: () => {
      database.close();
    },
  };
}
