/** Structural E13 side-feature attacks executed through the real Gateway. */
import {
  ALTERNATE_CARRIER_VECTORS,
  InMemoryEvidenceWriter,
  SymbolGatewayImpl,
  registerAlternateCarriers,
  type ConformanceVector,
} from '@ald/gateway';
import { fixedTokenInventory, type RunConfig, type TurnProposalEnvelope } from '@ald/types';

export const GENERATED_CARRIERS = [
  'generative-bitmap',
  'generative-canvas',
  'generative-tone',
] as const;
export type GeneratedCarrier = (typeof GENERATED_CARRIERS)[number];

export const CARRIER_SIDE_FEATURE_ATTACK_PLAN: Readonly<
  Record<GeneratedCarrier, Readonly<Record<string, readonly string[]>>>
> = {
  'generative-bitmap': {
    dimension: [
      'rejects a 255-bit matrix',
      'rejects a 257-bit matrix',
      'rejects an explicit bitmap width side feature',
      'rejects an explicit bitmap height side feature',
    ],
    metadata: [
      'rejects a color field beside the bitmap',
      'rejects a caption nested inside the bitmap',
      'rejects a numeric grid override nested inside the bitmap',
    ],
    compression: ['rejects a bitmap compression side feature'],
    container: ['rejects a bitmap container side feature'],
  },
  'generative-canvas': {
    dimension: [
      'rejects nine strokes against a cap of eight',
      'rejects a stroke past the right edge of the grid',
      'rejects an explicit canvas width side feature',
      'rejects an explicit canvas height side feature',
    ],
    metadata: [
      'rejects a per-stroke color field',
      'rejects a per-stroke semantic tag',
      'rejects a per-stroke numeric extra field',
    ],
    compression: ['rejects a canvas compression side feature'],
    container: ['rejects a canvas container side feature'],
  },
  'generative-tone': {
    dimension: [
      'rejects nine tones against a cap of eight',
      'rejects a ninth pitch bin',
      'rejects a fifth duration bin',
    ],
    metadata: [
      'rejects a note name beside the quantized bins',
      'rejects a numeric tempo field beside the sequence',
      'rejects a per-tone numeric extra field',
    ],
    'raw-media': ['rejects a base64 audio payload smuggled beside the sequence'],
    'sample-rate': ['rejects a tone sample-rate side feature'],
    compression: ['rejects a tone compression side feature'],
    container: ['rejects a tone container side feature'],
  },
};

export interface CarrierSideFeatureAttackResult {
  readonly carrier: GeneratedCarrier;
  readonly feature: string;
  readonly vectorName: string;
  readonly expectedReason: string;
  readonly actualReason: string | null;
  readonly rejected: boolean;
  readonly noDelivery: boolean;
  readonly exactlyOneEvidenceEvent: boolean;
  readonly rawArtifactAbsentFromEvidence: boolean;
  readonly passed: boolean;
}

export interface CarrierSideFeatureReport {
  readonly version: 1;
  readonly deploymentMode: RunConfig['deploymentMode'];
  readonly carriers: readonly GeneratedCarrier[];
  readonly features: readonly string[];
  readonly positiveControls: readonly {
    carrier: GeneratedCarrier;
    accepted: boolean;
    delivered: boolean;
  }[];
  readonly attacks: readonly CarrierSideFeatureAttackResult[];
  readonly passed: boolean;
  readonly evidenceReady: false;
  readonly boundary: 'structural-gateway-qualification-only';
}

function vectorNamed(vectors: readonly ConformanceVector[], name: string): ConformanceVector {
  const selected = vectors.find((vector) => vector.name === name);
  if (selected === undefined) throw new Error(`carrier-side-features: missing vector ${name}`);
  return selected;
}

export async function runCarrierSideFeatureAttacks(
  configs: Readonly<Record<GeneratedCarrier, RunConfig>>,
): Promise<CarrierSideFeatureReport> {
  registerAlternateCarriers();
  const positiveControls: Array<{ carrier: GeneratedCarrier; accepted: boolean; delivered: boolean }> = [];
  const attacks: CarrierSideFeatureAttackResult[] = [];
  const modes = new Set<RunConfig['deploymentMode']>();
  for (const carrier of GENERATED_CARRIERS) {
    const config = configs[carrier];
    if (config.carrierMode !== carrier) throw new Error(`carrier-side-features: config carrier mismatch for ${carrier}`);
    modes.add(config.deploymentMode);
    const vectors = ALTERNATE_CARRIER_VECTORS.get(carrier);
    if (vectors === undefined) throw new Error(`carrier-side-features: no vectors for ${carrier}`);
    const writer = InMemoryEvidenceWriter.forRun(config.runId);
    writer.registerRun(config);
    const gateway = new SymbolGatewayImpl({
      runId: config.runId,
      config,
      symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
      seed: config.randomSeed,
    }, writer);
    let turn = 0;
    const positive = vectors.find((vector) => vector.expect === 'accepted');
    if (positive === undefined) throw new Error(`carrier-side-features: no positive control for ${carrier}`);
    turn += 1;
    const positiveResult = await gateway.submitProposal(
      { turn, sender: 'baby-a', recipient: 'baby-b' },
      positive.envelope as TurnProposalEnvelope,
    );
    positiveControls.push({
      carrier,
      accepted: positiveResult.kind === 'accepted',
      delivered: gateway.deliveryFor(turn, 'baby-b') !== undefined,
    });
    for (const [feature, names] of Object.entries(CARRIER_SIDE_FEATURE_ATTACK_PLAN[carrier])) {
      for (const name of names) {
        const vector = vectorNamed(vectors, name);
        if (vector.expect === 'accepted') throw new Error(`carrier-side-features: attack vector is accepted: ${name}`);
        turn += 1;
        gateway.resetRejectionCounter();
        const before = writer.channelEvents(config.runId).length;
        const result = await gateway.submitProposal(
          { turn, sender: 'baby-a', recipient: 'baby-b' },
          vector.envelope as TurnProposalEnvelope,
        );
        const appended = writer.channelEvents(config.runId).slice(before);
        const artifact = (vector.envelope as { proposal?: { publicArtifact?: unknown } }).proposal?.publicArtifact;
        const rawArtifactAbsentFromEvidence = artifact === undefined
          || !JSON.stringify(appended).includes(JSON.stringify(artifact));
        const actualReason = result.kind === 'rejected' ? result.reasonCode : null;
        const rejected = result.kind === 'rejected' && actualReason === vector.expect;
        const noDelivery = gateway.deliveryFor(turn, 'baby-b') === undefined;
        const exactlyOneEvidenceEvent = appended.length === 1;
        attacks.push({
          carrier,
          feature,
          vectorName: name,
          expectedReason: vector.expect,
          actualReason,
          rejected,
          noDelivery,
          exactlyOneEvidenceEvent,
          rawArtifactAbsentFromEvidence,
          passed: rejected && noDelivery && exactlyOneEvidenceEvent && rawArtifactAbsentFromEvidence,
        });
      }
    }
  }
  if (modes.size !== 1) throw new Error('carrier-side-features: deployment modes must match');
  const features = [...new Set(attacks.map((attack) => attack.feature))].sort();
  return {
    version: 1,
    deploymentMode: configs['generative-bitmap'].deploymentMode,
    carriers: GENERATED_CARRIERS,
    features,
    positiveControls,
    attacks,
    passed: positiveControls.every((control) => control.accepted && control.delivered)
      && attacks.every((attack) => attack.passed),
    evidenceReady: false,
    boundary: 'structural-gateway-qualification-only',
  };
}
