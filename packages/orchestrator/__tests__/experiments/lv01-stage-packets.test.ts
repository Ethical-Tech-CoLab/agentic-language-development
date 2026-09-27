/** LV01 stage packets: compile, bind, and admit over verified identities. */
import { describe, expect, it } from 'vitest';

import {
  admitLv01Stage,
  bindLv01StagePacket,
  compileLv01StagePacket,
  lv01SlotPlanForStage,
  verifyLv01StageBinding,
  verifyLv01StagePacket,
  type Lv01StagePacketInput,
} from '../../src/experiments/lv01-stage-packets.js';

const hash = (char: string): string => `sha256:${char.repeat(64)}`;
const POLICY = {
  pilot: { primaryDyads: 20, reserves: 0 },
  development: { fullCalibrationDyads: 5 },
  qualification: { freshQualificationSeeds: 25 },
};

function packetInput(overrides: Partial<Lv01StagePacketInput> = {}): Lv01StagePacketInput {
  return {
    stage: 'pilot',
    version: 2,
    designVersion: 2,
    designCommitmentHash: hash('a'),
    analysisCommitmentHash: hash('b'),
    seedResourceCommitmentHash: hash('c'),
    sourceCommit: 'd'.repeat(40),
    modelIdentity: {
      architecture: 'gru-actor-critic-v1',
      track: 'scratch-rl',
      parameterCountPerAgent: 4049,
      inputSize: 50,
      hiddenSize: 16,
    },
    allocation: { path: 'protocols/lv01-pilot-resource-allocation.v2.json', sha256: hash('e') },
    qualifications: {
      designCheck: 'passed',
      powerCheck: 'passed',
      topology: { path: 'reports/research/lv01-topology-qualification.v2.json', sha256: hash('f'), passed: true },
    },
    slotPlan: { primaries: 20, reserves: 0 },
    ...overrides,
  };
}

describe('LV01 stage packets', () => {
  it('derives slot plans from the frozen policy and refuses main stages', () => {
    expect(lv01SlotPlanForStage('development', POLICY)).toEqual({ primaries: 5, reserves: 0 });
    expect(lv01SlotPlanForStage('qualification', POLICY)).toEqual({ primaries: 25, reserves: 0 });
    expect(lv01SlotPlanForStage('pilot', POLICY)).toEqual({ primaries: 20, reserves: 0 });
    expect(() => lv01SlotPlanForStage('confirmatory', POLICY)).toThrow(/locked design receipt/u);
    expect(() => lv01SlotPlanForStage('replication', POLICY)).toThrow(/locked design receipt/u);
  });

  it('compiles a verifiable packet and rejects tampering or wrong identities', () => {
    const packet = compileLv01StagePacket(packetInput());
    expect(verifyLv01StagePacket(packet)).toEqual(packet);
    expect(verifyLv01StagePacket(structuredClone(packet)).packetCommitment).toBe(packet.packetCommitment);
    expect(() => verifyLv01StagePacket({ ...packet, version: 3 })).toThrow(/commitment/u);
    expect(() => compileLv01StagePacket(packetInput({
      modelIdentity: { ...packetInput().modelIdentity, parameterCountPerAgent: 4050 as unknown as 4049 },
    }))).toThrow(/invalid/u);
    expect(() => compileLv01StagePacket(packetInput({ sourceCommit: 'short' }))).toThrow(/invalid/u);
  });

  it('binds the packet into a pre-run commitment with no outcomes', () => {
    const packet = compileLv01StagePacket(packetInput());
    const binding = bindLv01StagePacket(packet, '1'.repeat(40), hash('e'));
    expect(verifyLv01StageBinding(binding, packet)).toEqual(binding);
    expect(() => verifyLv01StageBinding({ ...binding, allocationSha256: hash('9') }, packet)).toThrow(/pre-run commitment/u);
    const other = compileLv01StagePacket(packetInput({ version: 3 }));
    expect(() => verifyLv01StageBinding(binding, other)).toThrow(/match the registered packet/u);
  });

  it('admits only fully verified stages and records reasons', () => {
    const packet = compileLv01StagePacket(packetInput());
    const binding = bindLv01StagePacket(packet, '1'.repeat(40), hash('e'));
    const checks = {
      designVerified: true,
      numericalQualificationVerified: true,
      topologyQualificationVerified: true,
      sourceClean: true,
      resourcesSufficient: true,
      stage: 'pilot' as const,
    };
    const ready = admitLv01Stage({ packet, binding, checks });
    expect(ready.status).toBe('ready');
    expect(ready.reasons).toEqual([]);
    expect(ready.scientificDisposition).toBe('not-tested');
    const blocked = admitLv01Stage({ packet, binding, checks: { ...checks, sourceClean: false } });
    expect(blocked.status).toBe('blocked');
    expect(blocked.reasons.length).toBeGreaterThan(0);
    expect(() => admitLv01Stage({
      packet: { ...packet, version: 3 },
      binding,
      checks,
    })).toThrow(/commitment/u);
  });
});
