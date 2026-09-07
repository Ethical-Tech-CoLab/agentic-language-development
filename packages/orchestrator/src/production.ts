/**
 * Production wiring of the Nursery Controller runtime — Phase D (BACKLOG
 * ALD-072): the real SQLite-backed evidence store (`@ald/evidence`), the real
 * `EvidenceCheckpointService` Merkle/witness checkpoint service
 * (`@ald/checkpoint`), the real independent `@ald/verifier`, and, per
 * SPECIFICATION.md §5.1/§7.2/§13.4, `anchorPolicy: 'skip'`.
 *
 * This environment carries no funded Base Sepolia wallet, so skipping the
 * anchor is a declared, audited governance decision (SPEC §7.2's
 * `governance-decision` intervention, `ANCHORING_SKIPPED_DEVIATION`), never a
 * silent omission. Every run this runtime produces is therefore permanently
 * `invalid` by construction (SPEC §7.2) and carries the Prototype Mode claim
 * boundary of §5.1/§5.4 (`CLAIM_BOUNDARY_STATEMENTS.prototype`). A real
 * `AnchorPublisher` — fund a wallet, set `ALD_BASE_RPC_URL` /
 * `ALD_ANCHOR_KEY_FILE`, wire it through `anchorPublisher` — would flip this
 * option to `'required'`.
 *
 * This construction deliberately mirrors
 * `twins/packs/nursery/behavior/pack.ts`'s `init(context)`, which wires the
 * identical three services for its DTSF routes; the one addition here is a
 * `keyDir`-backed `FileKeyStore` signer provider, so a qualification run's
 * per-run keys survive a process restart (LEDGER-INTEGRITY-DESIGN.md §11).
 */
import type {
  CheckpointService,
  Clock,
  SignerRegistry,
  VerificationReport,
} from '@ald/types';
import { FileKeyStore, InMemorySignerRegistry } from '@ald/hashing';
import {
  openEvidenceDatabase,
  type EvidenceDatabase,
  type SqliteEvidenceWriter,
} from '@ald/evidence';
import { EvidenceCheckpointService } from '@ald/checkpoint';
import { verifyBundle, VERIFIER_VERSION } from '@ald/verifier';

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
   * Directory of per-run signer seeds (LEDGER §11). Omit to generate
   * in-memory keys that do not survive a restart — fine for a short-lived
   * qualification run, not for a run meant to be resumed later.
   */
  keyDir?: string;
  clock?: Clock;
  /**
   * Passed straight through to `verifyBundle`. Default `true`: this runtime
   * never anchors (see module doc), so an unanchored tail must be a reported
   * note rather than an automatic verifier failure, or every run would fail
   * verification for the one deviation it already declares honestly.
   */
  allowUnanchored?: boolean;
  learnerOptions?: NurseryRuntimeOptions['learnerOptions'];
  scenarioFactory?: NurseryRuntimeOptions['scenarioFactory'];
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
  const keyDir = options.keyDir;

  let pendingRunId: string | undefined;
  const checkpointServices = new Map<string, EvidenceCheckpointService>();

  const signerProvider = (runId: string): SignerRegistry => {
    pendingRunId = runId;
    if (keyDir === undefined) {
      return InMemorySignerRegistry.generate(runId);
    }
    const store = new FileKeyStore(keyDir);
    return store.hasRun(runId) ? store.loadRun(runId) : store.provisionRun(runId);
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

  const verifier = (bundleDir: string): Promise<VerificationReport> =>
    verifyBundle(bundleDir, {
      verifierVersion: VERIFIER_VERSION,
      now: () => clock.now(),
      allowUnanchored,
    });

  const runtime = createNurseryRuntime({
    database,
    softwareCommit: options.softwareCommit,
    bundleRoot: options.bundleRoot,
    checkpointFactory,
    signerProvider,
    clock,
    anchorPolicy: 'skip',
    verifier,
    proofWriter,
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
