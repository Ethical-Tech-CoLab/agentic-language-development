/**
 * LV01 stage packet compiler, binder, and admitter (R05.1).
 *
 * Pure hashing plus schema validation; the `scripts/*-lv01-stage.mjs`
 * wrappers do filesystem and git IO. Compile binds complete
 * allocation/code/model/design/analysis identities into an immutable
 * packet; bind re-verifies the packet into a pre-run commitment with no
 * outcomes; admit assesses the verified packet, binding, source, and
 * allocation into an immutable gate receipt. Live capacity enforcement is
 * the collector's job (R05.2), not the packet's.
 */
import { hashCanonical } from '@ald/hashing';
import {
  Lv01GateReceiptSchema,
  Lv01StageBindingSchema,
  Lv01StagePacketSchema,
  type Lv01GateReceipt,
  type Lv01StageBinding,
  type Lv01StagePacket,
} from '@ald/types';

import { assessLv01Admission, type Lv01AdmissionInput, type Lv01Stage } from './ledger-value.js';

export const LV01_STAGE_PACKET_DOMAIN = 'lv01-stage-packet/v1' as const;
export const LV01_STAGE_PRERUN_DOMAIN = 'lv01-stage-prerun/v1' as const;
export const LV01_STAGE_BINDING_DOMAIN = 'lv01-stage-binding/v1' as const;

function fail(message: string): never {
  throw new Error(`LV01 stage packet: ${message}`);
}

/** Stage slot plans come from the frozen v2 seed-resource policy. */
export function lv01SlotPlanForStage(
  stage: Lv01Stage,
  policy: {
    readonly pilot: { readonly primaryDyads: number; readonly reserves: number };
    readonly development: { readonly fullCalibrationDyads: number };
    readonly qualification: { readonly freshQualificationSeeds: number };
  },
): { readonly primaries: number; readonly reserves: number } {
  switch (stage) {
    case 'development': return { primaries: policy.development.fullCalibrationDyads, reserves: 0 };
    case 'qualification': return { primaries: policy.qualification.freshQualificationSeeds, reserves: 0 };
    case 'pilot': return { primaries: policy.pilot.primaryDyads, reserves: policy.pilot.reserves };
    case 'confirmatory':
    case 'replication':
      fail('main stages require a locked design receipt before compilation');
  }
}

export interface Lv01StagePacketInput {
  readonly stage: Lv01Stage;
  readonly version: number;
  readonly designVersion: 1 | 2;
  readonly designCommitmentHash: string;
  readonly analysisCommitmentHash: string;
  readonly seedResourceCommitmentHash: string;
  readonly sourceCommit: string;
  readonly modelIdentity: Lv01StagePacket['modelIdentity'];
  readonly allocation: Lv01StagePacket['allocation'];
  readonly qualifications: Lv01StagePacket['qualifications'];
  readonly slotPlan: Lv01StagePacket['slotPlan'];
}

export function compileLv01StagePacket(input: Lv01StagePacketInput): Lv01StagePacket {
  const packet = {
    schemaVersion: 1 as const,
    studyId: 'LV01' as const,
    stage: input.stage,
    version: input.version,
    designVersion: input.designVersion,
    designCommitmentHash: input.designCommitmentHash,
    analysisCommitmentHash: input.analysisCommitmentHash,
    seedResourceCommitmentHash: input.seedResourceCommitmentHash,
    sourceCommit: input.sourceCommit,
    modelIdentity: input.modelIdentity,
    allocation: input.allocation,
    qualifications: input.qualifications,
    slotPlan: input.slotPlan,
    researchFinding: false as const,
    claimBoundary: 'Prospective stage registration only. No run, outcome, or scientific result is implied.',
  };
  const parsed = Lv01StagePacketSchema.safeParse({ ...packet, packetCommitment: hashCanonical(LV01_STAGE_PACKET_DOMAIN, packet) });
  if (!parsed.success) fail(`stage packet is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  return parsed.data;
}

export function verifyLv01StagePacket(packet: unknown): Lv01StagePacket {
  const parsed = Lv01StagePacketSchema.safeParse(packet);
  if (!parsed.success) fail(`stage packet is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  const { packetCommitment, ...rest } = parsed.data;
  if (hashCanonical(LV01_STAGE_PACKET_DOMAIN, rest) !== packetCommitment) fail('stage packet commitment does not match its identities');
  return parsed.data;
}

export function bindLv01StagePacket(packet: Lv01StagePacket, sourceCommit: string, allocationSha256: string): Lv01StageBinding {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) fail('binding source commit is invalid');
  const preRunCommitment = hashCanonical(LV01_STAGE_PRERUN_DOMAIN, {
    packetCommitment: packet.packetCommitment,
    sourceCommit,
    allocationSha256,
  });
  const binding = {
    schemaVersion: 1 as const,
    studyId: 'LV01' as const,
    stage: packet.stage,
    version: packet.version,
    packetCommitment: packet.packetCommitment,
    sourceCommit,
    allocationSha256,
    preRunCommitment,
    researchFinding: false as const,
    claimBoundary: 'Pre-run binding only. No outcome exists at bind time.',
  };
  const parsed = Lv01StageBindingSchema.safeParse({ ...binding, bindingCommitment: hashCanonical(LV01_STAGE_BINDING_DOMAIN, binding) });
  if (!parsed.success) fail(`stage binding is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  return parsed.data;
}

export function verifyLv01StageBinding(binding: unknown, packet: Lv01StagePacket): Lv01StageBinding {
  const parsed = Lv01StageBindingSchema.safeParse(binding);
  if (!parsed.success) fail(`stage binding is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  if (parsed.data.packetCommitment !== packet.packetCommitment) fail('binding does not match the registered packet');
  if (parsed.data.stage !== packet.stage || parsed.data.version !== packet.version) fail('binding stage or version disagrees with the packet');
  const expectedPreRun = hashCanonical(LV01_STAGE_PRERUN_DOMAIN, {
    packetCommitment: packet.packetCommitment,
    sourceCommit: parsed.data.sourceCommit,
    allocationSha256: parsed.data.allocationSha256,
  });
  if (expectedPreRun !== parsed.data.preRunCommitment) fail('binding pre-run commitment does not match its inputs');
  const { bindingCommitment, ...rest } = parsed.data;
  if (hashCanonical(LV01_STAGE_BINDING_DOMAIN, rest) !== bindingCommitment) fail('binding commitment does not match its contents');
  return parsed.data;
}

/**
 * Admit a stage from live-verified evidence. The packet and binding are
 * re-verified here (never trusted from filenames); the remaining flags
 * arrive from the caller's live checks and are assessed, not assumed.
 */
export function admitLv01Stage(input: {
  readonly packet: unknown;
  readonly binding: unknown;
  readonly checks: Omit<Lv01AdmissionInput, 'registrationBound'>;
}): Lv01GateReceipt {
  const packet = verifyLv01StagePacket(input.packet);
  const binding = verifyLv01StageBinding(input.binding, packet);
  const verdict = assessLv01Admission({ ...input.checks, registrationBound: true, stage: packet.stage });
  const receipt = {
    schemaVersion: 1 as const,
    studyId: 'LV01' as const,
    stage: packet.stage,
    version: packet.version,
    packetCommitment: packet.packetCommitment,
    bindingCommitment: binding.bindingCommitment,
    status: verdict.status === 'ready' ? 'ready' as const : 'blocked' as const,
    reasons: [...verdict.reasons],
    researchFinding: false as const,
    scientificDisposition: 'not-tested' as const,
    claimBoundary: 'Admission verdict over verified identities only. No run has started and no scientific result is implied.',
  };
  const parsed = Lv01GateReceiptSchema.safeParse(receipt);
  if (!parsed.success) fail(`gate receipt is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  return parsed.data;
}
