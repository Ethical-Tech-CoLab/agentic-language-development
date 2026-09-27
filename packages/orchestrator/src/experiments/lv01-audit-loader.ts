/**
 * LV01 audit evidence loader (R05.2b).
 *
 * Pure: parsed bundle documents in, auditor inputs out. Maps one branch
 * bundle (intervention log, turn records, child ledgers, run config and
 * manifest) plus the parent bundle (frozen ledger streams, run config,
 * checkpoints, policy exports) onto {@link Lv01AuditedBranch} and the
 * shared audit input. The sealed treatment batch arrives as an explicit
 * input: per-branch slices cannot reconstruct it.
 *
 * Ordering is VERIFIED from evidence, never imposed: the intervention
 * stream must run initialization < prediction < draw-commit < disclosure
 * by sequence and recordedAt, the receiver's intention record must fall
 * between draw-commit and disclosure, and the turn record must follow
 * prediction and draw-commit. Only then are canonical transcript numbers
 * assigned, chained under a loader domain that binds the observed
 * coordinates of every entry.
 */
import { hashCanonical, verifyHashSignature } from '@ald/hashing';
import { parseExportedRecurrentScratchPolicy } from '@ald/learners';
import {
  InterventionEventSchema,
  LedgerEventSchema,
  RunConfigSchema,
  TurnRecordSchema,
  fixedTokenInventory,
  type LedgerEvent,
} from '@ald/types';

import {
  type Lv01AuditParentBundle,
  type Lv01AuditSharedInput,
  type Lv01AuditTranscriptEntry,
  type Lv01AuditedBranch,
} from './lv01-auditor.js';
import { LV01_BRANCHES } from './ledger-value.js';
import type { Lv01LedgerTreatmentBatch } from './lv01-ledger-treatments.js';
import type { Lv01PairedPredictionPayload } from './lv01-paired-predictions.js';

export const LV01_AUDIT_TRANSCRIPT_DOMAIN = 'lv01-audit-transcript/v1' as const;
const LV01_TRANSCRIPT_GENESIS = 'lv01-audit-transcript-genesis/v1' as const;

function fail(message: string): never {
  throw new Error(`LV01 audit loader: ${message}`);
}

/** Parsed files of one branch or parent bundle directory. */
export interface Lv01BundleDocs {
  readonly runManifest: unknown;
  readonly runConfig: unknown;
  readonly interventions: readonly unknown[];
  readonly turns: readonly unknown[];
  readonly ledgerA: readonly unknown[];
  readonly ledgerB: readonly unknown[];
  readonly policies: Readonly<Record<string, unknown>>;
  /** Parent checkpoint hashes (branches carry none). */
  readonly checkpoints: readonly string[];
}

function parseJsonl(content: string, file: string): unknown[] {
  return content.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      fail(`${file} line ${index + 1} is not JSON`);
    }
  });
}

function parseJson(content: string, file: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    fail(`${file} is not JSON`);
  }
}

/** Parse-only bundle reader; every record is schema-validated on load. */
export function parseBundleFiles(files: Readonly<Record<string, string>>): Lv01BundleDocs {
  const required = ['run-manifest.json', 'run-config.json', 'intervention-log.jsonl', 'turn-records.jsonl', 'baby-a-ledger.jsonl', 'baby-b-ledger.jsonl'];
  for (const name of required) {
    if (files[name] === undefined) fail(`bundle is missing ${name}`);
  }
  const policies: Record<string, unknown> = {};
  for (const [name, content] of Object.entries(files)) {
    if (name.startsWith('policies/')) policies[name] = parseJson(content, name);
  }
  const checkpointsRaw = files['checkpoints.json'];
  const checkpoints: string[] = checkpointsRaw === undefined
    ? []
    : (parseJson(checkpointsRaw, 'checkpoints.json') as { readonly checkpointHashes?: readonly unknown[] }).checkpointHashes?.map((hash) => {
      if (typeof hash !== 'string') fail('checkpoints.json carries a non-string hash');
      return hash;
    }) ?? [];
  return {
    runManifest: parseJson(files['run-manifest.json'] as string, 'run-manifest.json'),
    runConfig: parseJson(files['run-config.json'] as string, 'run-config.json'),
    interventions: parseJsonl(files['intervention-log.jsonl'] as string, 'intervention-log.jsonl'),
    turns: parseJsonl(files['turn-records.jsonl'] as string, 'turn-records.jsonl'),
    ledgerA: parseJsonl(files['baby-a-ledger.jsonl'] as string, 'baby-a-ledger.jsonl'),
    ledgerB: parseJsonl(files['baby-b-ledger.jsonl'] as string, 'baby-b-ledger.jsonl'),
    policies,
    checkpoints,
  };
}

interface TypedIntervention {
  readonly sequence: number;
  readonly recordedAt: string;
  readonly entryHash: string;
  readonly eventType: string;
  readonly reasonCode: string;
  readonly details: Record<string, unknown>;
}

function typedInterventions(docs: Lv01BundleDocs): TypedIntervention[] {
  return docs.interventions.map((entry, index) => {
    const parsed = InterventionEventSchema.safeParse(entry);
    if (!parsed.success) fail(`intervention-log.jsonl line ${index + 1} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    const value = parsed.data as unknown as Record<string, unknown>;
    return {
      sequence: value['sequence'] as number,
      recordedAt: value['recordedAt'] as string,
      entryHash: value['entryHash'] as string,
      eventType: value['eventType'] as string,
      reasonCode: value['reasonCode'] as string,
      details: value['details'] as Record<string, unknown>,
    };
  });
}

function typedTurns(docs: Lv01BundleDocs): Record<string, unknown>[] {
  return docs.turns.map((entry, index) => {
    const parsed = TurnRecordSchema.safeParse(entry);
    if (!parsed.success) fail(`turn-records.jsonl line ${index + 1} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    return parsed.data as unknown as Record<string, unknown>;
  });
}

function typedLedger(events: readonly unknown[], file: string): LedgerEvent[] {
  return events.map((entry, index) => {
    const parsed = LedgerEventSchema.safeParse(entry);
    if (!parsed.success) fail(`${file} line ${index + 1} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    return parsed.data as LedgerEvent;
  });
}

function uniqueIntervention(events: readonly TypedIntervention[], eventType: string, reasonCode: string): TypedIntervention {
  const matches = events.filter((entry) => entry.eventType === eventType && entry.reasonCode === reasonCode);
  if (matches.length !== 1) fail(`bundle has ${matches.length} ${reasonCode} events, expected exactly one`);
  return matches[0] as TypedIntervention;
}

function payloadFrom(details: Record<string, unknown>): Lv01PairedPredictionPayload {
  const payload = details['predictionPayload'];
  if (typeof payload !== 'object' || payload === null) fail('prediction details carry no payload');
  for (const key of ['native', 'ordinary', 'replay', 'state', 'cutoff', 'candidateRefs', 'candidateTypeCodes', 'deliveredToken', 'caseId', 'turn', 'receiver']) {
    if (!(key in (payload as Record<string, unknown>))) fail(`committed payload is missing ${key}`);
  }
  return payload as Lv01PairedPredictionPayload;
}

function stringField(details: Record<string, unknown>, name: string, owner: string): string {
  const value = details[name];
  if (typeof value !== 'string' || value.length === 0) fail(`${owner} carries no ${name}`);
  return value;
}

/** Load one branch's auditor input from its raw bundle documents. */
export function loadLv01AuditedBranch(docs: Lv01BundleDocs): Lv01AuditedBranch {
  const config = RunConfigSchema.safeParse(docs.runConfig);
  if (!config.success) fail(`branch run-config is invalid: ${config.error.issues[0]?.message ?? 'unknown'}`);
  const pairedCase = config.data.lv01PairedCase;
  if (pairedCase === undefined || !LV01_BRANCHES.includes(pairedCase.branch)) fail('branch run-config carries no LV01 paired case');
  const branch = pairedCase.branch;
  const turns = typedTurns(docs);
  if (turns.length !== 1 || turns[0]!['turn'] !== 0) fail(`${branch} bundle is not a single turn-0 record`);
  const turn = turns[0] as Record<string, unknown>;
  const events = typedInterventions(docs);
  const init = uniqueIntervention(events, 'runtime-attestation', 'learner-initialization');
  const prediction = uniqueIntervention(events, 'prediction-commitment', 'lv01-paired-pre-receiver-action-prediction-committed');
  const draw = uniqueIntervention(events, 'action-draw-commitment', 'lv01-shared-action-draw-committed');
  const disclosureEvent = uniqueIntervention(events, 'action-draw-disclosed', 'lv01-shared-action-draw-disclosed');
  const payload = payloadFrom(prediction.details);
  const receiver = payload.receiver === 'baby-a' || payload.receiver === 'baby-b' ? payload.receiver : fail(`${branch} payload receiver is invalid`);
  const receiverStream = typedLedger(receiver === 'baby-a' ? docs.ledgerA : docs.ledgerB, receiver === 'baby-a' ? 'baby-a-ledger.jsonl' : 'baby-b-ledger.jsonl');
  const intentions = receiverStream.filter((event) => event.eventType === 'intention.recorded' && event.turn === 0);
  if (intentions.length !== 1) fail(`${branch} bundle has ${intentions.length} turn-0 intention records, expected exactly one`);
  const intention = intentions[0] as LedgerEvent;
  const content = intention.content as Record<string, unknown>;
  const symbols = content['symbols'];
  if (!Array.isArray(symbols)) fail(`${branch} intention record carries no symbol delivery`);
  const deliveredToken = (symbols[0] ?? null) as string | null;
  if (deliveredToken !== null && typeof deliveredToken !== 'string') fail(`${branch} intention delivery is malformed`);
  if (deliveredToken === null && branch !== 'disabled') fail(`${branch} intention record has no delivered token`);
  const selectedCandidateRef = content['selection'];
  if (typeof selectedCandidateRef !== 'string' || selectedCandidateRef.length === 0) fail(`${branch} intention record carries no selection`);
  const outcome = turn['outcome'] as Record<string, unknown> | undefined;
  const outcomeSelection = (outcome?.['details'] as Record<string, unknown> | undefined)?.['selectedRef'];
  if (outcomeSelection !== selectedCandidateRef) fail(`${branch} turn outcome disagrees with the intention selection`);
  const details = disclosureEvent.details;
  const disclosure = {
    uBitsHex: stringField(details, 'uBitsHex', `${branch} disclosure`),
    probs: Array.isArray(details['probs']) ? details['probs'] as readonly number[] : fail(`${branch} disclosure carries no sampling vector`),
    candidateRefs: Array.isArray(details['candidateRefs']) ? details['candidateRefs'] as readonly string[] : fail(`${branch} disclosure carries no candidate order`),
    selectedCandidateRef: stringField(details, 'selectedCandidateRef', `${branch} disclosure`),
  };
  if (disclosure.selectedCandidateRef !== selectedCandidateRef) fail(`${branch} disclosure disagrees with the intention selection`);
  if (turn['scenarioStateHash'] !== payload.state.scenarioStateHash) fail(`${branch} turn scenario disagrees with the committed scenario`);
  const drawSeed = config.data.seedBindings?.actionDraw;
  if (typeof drawSeed !== 'string' || drawSeed.length === 0) fail(`${branch} run-config carries no action-draw seed`);

  // Observed order must match the required causal order before canonical
  // transcript numbers are assigned; anything else fails, never re-sorts.
  const ordered = [init, prediction, draw, disclosureEvent];
  for (let index = 1; index < ordered.length; index += 1) {
    const before = ordered[index - 1] as TypedIntervention;
    const after = ordered[index] as TypedIntervention;
    if (!(before.sequence < after.sequence && before.recordedAt < after.recordedAt)) {
      fail(`${branch} intervention stream violates causal order at ${after.reasonCode}`);
    }
  }
  if (!(draw.recordedAt < intention.recordedAt && intention.recordedAt < disclosureEvent.recordedAt)) {
    fail(`${branch} selection falls outside the draw-disclosure window`);
  }
  const turnAt = turn['recordedAt'] as string;
  if (!(prediction.recordedAt < turnAt && draw.recordedAt < turnAt)) fail(`${branch} turn record precedes its commitments`);
  const lineage = (init.details['lineage'] ?? fail(`${branch} initialization carries no lineage`)) as Record<string, unknown>;
  const refs = (lineage['initialPolicyRefs'] ?? fail(`${branch} lineage carries no policy refs`)) as Record<string, unknown>;

  const observed = [
    { type: 'learner-initialization' as const, event: init, body: { parentRunId: lineage['parentRunId'], derivedFromCheckpointHash: lineage['derivedFromCheckpointHash'], babyAInitialPolicyRef: refs['babyA'], babyBInitialPolicyRef: refs['babyB'] } },
    { type: 'prediction-commitment' as const, event: prediction, body: { commitment: stringField(prediction.details, 'predictionCommitmentV2', `${branch} prediction`) } },
    { type: 'action-draw-commitment' as const, event: draw, body: { drawCommitment: stringField(draw.details, 'drawCommitment', `${branch} draw`) } },
    {
      type: 'receiver-action-recorded' as const,
      event: { sequence: intention.sequence, recordedAt: intention.recordedAt, entryHash: intention.entryHash },
      body: { selectedCandidateRef, deliveredToken, candidateRefs: [...payload.candidateRefs], scenarioStateHash: turn['scenarioStateHash'] },
    },
    { type: 'action-draw-disclosed' as const, event: disclosureEvent, body: { uBitsHex: disclosure.uBitsHex } },
  ];
  let previous: string = LV01_TRANSCRIPT_GENESIS;
  const transcript: Lv01AuditTranscriptEntry[] = observed.map((entry, index) => {
    const body = { ...entry.body, observed: { stream: index === 3 ? `${receiver}-ledger` : 'intervention', sequence: entry.event.sequence, recordedAt: entry.event.recordedAt, entryHash: entry.event.entryHash } };
    const entryHash = hashCanonical(LV01_AUDIT_TRANSCRIPT_DOMAIN, { sequence: index + 1, eventType: entry.type, previousEntryHash: previous, body });
    const transcriptEntry: Lv01AuditTranscriptEntry = { sequence: index + 1, eventType: entry.type, entryHash, previousEntryHash: previous, body };
    previous = entryHash;
    return transcriptEntry;
  });

  return {
    branch,
    runId: config.data.runId,
    payload,
    predictionCommitment: stringField(prediction.details, 'predictionCommitmentV2', `${branch} prediction`),
    drawSeed,
    drawCommitment: stringField(draw.details, 'drawCommitment', `${branch} draw`),
    disclosure,
    transcript,
    ...(pairedCase.ledgerTreatment === undefined ? {} : { treatmentSlice: { ...pairedCase.ledgerTreatment } }),
  };
}

/**
 * Resolve the frozen recurrent model through the registered derivation ref.
 *
 * The committed receiver policy hash covers a volatile re-export (runtime
 * state the retained file never carries), so exports cannot match it by
 * hash. Binding instead runs through the derivation ref, which the branch
 * transcript lineage, the parent bundle, and the case pre-state all commit
 * to; the auditor then binds the model behaviorally by requiring recorded
 * sampling vectors to equal its replayed response.
 */
export function resolveLv01FrozenModel(
  policies: Readonly<Record<string, unknown>>,
  initialPolicyRef: string,
): unknown {
  const exported = policies[initialPolicyRef];
  if (exported === undefined) fail(`parent bundle is missing ${initialPolicyRef}`);
  return parseExportedRecurrentScratchPolicy(exported).model;
}

export function authenticateFromManifest(manifest: unknown): (event: LedgerEvent) => boolean {
  const signers = (manifest as Record<string, unknown>)?.['signers'];
  if (!Array.isArray(signers) || signers.length === 0) fail('run manifest carries no signers');
  const keys = new Map(signers.map((entry) => {
    const record = entry as Record<string, unknown>;
    if (typeof record['keyId'] !== 'string' || typeof record['publicKey'] !== 'string') fail('run manifest signer is malformed');
    return [record['keyId'] as string, record['publicKey'] as string];
  }));
  return (event: LedgerEvent): boolean => {
    const publicKey = keys.get(event.writerKeyId);
    return publicKey !== undefined && verifyHashSignature(event.entryHash, event.writerSignature, publicKey);
  };
}

/** Load the shared audit input from the parent bundle and branch derivation refs. */
export function loadLv01AuditShared(input: {
  readonly parentDocs: Lv01BundleDocs;
  readonly branchDocs: Lv01BundleDocs;
  readonly firstBranch: Lv01AuditedBranch;
  readonly treatmentBatch: Lv01LedgerTreatmentBatch;
}): Lv01AuditSharedInput {
  const parentConfig = RunConfigSchema.safeParse(input.parentDocs.runConfig);
  if (!parentConfig.success) fail(`parent run-config is invalid: ${parentConfig.error.issues[0]?.message ?? 'unknown'}`);
  const branchConfig = RunConfigSchema.safeParse(input.branchDocs.runConfig);
  if (!branchConfig.success) fail(`branch run-config is invalid: ${branchConfig.error.issues[0]?.message ?? 'unknown'}`);
  if (branchConfig.data.parentRunId !== parentConfig.data.runId) fail('branch derivation points outside the parent bundle');
  const checkpoint = branchConfig.data.derivedFromCheckpointHash;
  if (typeof checkpoint !== 'string' || !input.parentDocs.checkpoints.includes(checkpoint)) {
    fail('branch derivation checkpoint is not a retained parent checkpoint');
  }
  const babyARef = branchConfig.data.babyA.initialPolicyRef;
  const babyBRef = branchConfig.data.babyB.initialPolicyRef;
  if (typeof babyARef !== 'string' || typeof babyBRef !== 'string') fail('branch derivation carries no policy refs');
  const parent: Lv01AuditParentBundle = {
    parentRunId: parentConfig.data.runId,
    parentCheckpointHash: checkpoint,
    babyAInitialPolicyRef: babyARef,
    babyBInitialPolicyRef: babyBRef,
    parentConfigurationHash: hashCanonical('lv01-paired-parent-config/v1', parentConfig.data),
    parentRandomSeed: parentConfig.data.randomSeed,
  };
  const receiver = input.firstBranch.payload.receiver;
  if (receiver !== 'baby-a' && receiver !== 'baby-b') fail('case receiver role is invalid');
  return {
    symbolInventory: fixedTokenInventory(branchConfig.data.symbolInventorySize ?? 32),
    frozenModel: resolveLv01FrozenModel(input.parentDocs.policies, receiver === 'baby-a' ? babyARef : babyBRef),
    authenticate: authenticateFromManifest(input.parentDocs.runManifest),
    parent,
    treatmentBatch: input.treatmentBatch,
    parentLedgerEvents: {
      babyA: typedLedger(input.parentDocs.ledgerA, 'parent baby-a-ledger.jsonl'),
      babyB: typedLedger(input.parentDocs.ledgerB, 'parent baby-b-ledger.jsonl'),
    },
  };
}
