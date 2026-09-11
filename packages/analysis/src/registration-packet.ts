/** Fail-closed canonical registration packet compiler for E00-E50. */
import { canonicalJson, hashCanonical, isSha256Hash } from '@ald/hashing';
import { HASH_DOMAINS } from '@ald/types';

import { AnalysisError } from './errors.js';

export const REGISTRATION_PACKET_COMPILER_VERSION = 1;
export const REGISTRATION_BINDING_KEYS = [
  'protocolCard',
  'runConfigurations',
  'practicalMargins',
  'analysisVersions',
  'modelAssets',
  'selectedSeedPrefix',
  'executionHost',
  'scenarioBundle',
  'exclusionRules',
  'stoppingRules',
  'evidenceAndAnchorPolicy',
] as const;

export type RegistrationBindingKey =
  (typeof REGISTRATION_BINDING_KEYS)[number];

export interface RegistrationBinding {
  readonly key: RegistrationBindingKey;
  readonly sha256: string;
  readonly content: unknown;
}

export interface RegistrationPacketArtifact {
  readonly schemaVersion: 1;
  readonly compilerVersion: typeof REGISTRATION_PACKET_COMPILER_VERSION;
  readonly experimentId: string;
  readonly registrationClass: string;
  readonly bindings: readonly RegistrationBinding[];
}

export interface CompiledRegistrationPacket {
  readonly artifact: RegistrationPacketArtifact;
  readonly canonicalArtifact: string;
  readonly preRegistrationHash: string;
  readonly claimBoundary: 'draft-until-externally-registered-and-pre-run-anchored';
}

export interface CompileRegistrationPacketInput {
  readonly experimentId: string;
  readonly registrationClass: string;
  readonly bindings: Readonly<Record<RegistrationBindingKey, unknown>>;
}

const PLACEHOLDER = /^(?:tbd|todo|unknown|unset|unresolved|pending|n\/a)$/iu;

function invalid(path: string, detail: string): never {
  throw new AnalysisError('domain', `${path} ${detail}`);
}

function assertConcrete(value: unknown, path: string): void {
  if (value === null || value === undefined) invalid(path, 'must be resolved');
  if (typeof value === 'string') {
    if (value.trim().length === 0 || PLACEHOLDER.test(value.trim())) {
      invalid(path, 'contains an empty or placeholder value');
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'must be finite');
    return;
  }
  if (typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length === 0) invalid(path, 'must not be an empty array');
    value.forEach((entry, index) => assertConcrete(entry, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) invalid(path, 'must not be an empty object');
    for (const [key, entry] of entries) {
      if (key.length === 0) invalid(path, 'contains an empty key');
      assertConcrete(entry, `${path}.${key}`);
    }
    return;
  }
  invalid(path, `contains unsupported ${typeof value}`);
}

function assertExactBindingKeys(bindings: object): void {
  const actual = Object.keys(bindings).sort();
  const expected = [...REGISTRATION_BINDING_KEYS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid('bindings', `must contain exactly ${expected.join(', ')}`);
  }
}

export function compileRegistrationPacket(
  input: CompileRegistrationPacketInput,
): CompiledRegistrationPacket {
  if (!/^E\d{2}$/u.test(input.experimentId)) {
    invalid('experimentId', 'must have the form E00');
  }
  if (input.registrationClass.trim().length === 0 || PLACEHOLDER.test(input.registrationClass)) {
    invalid('registrationClass', 'must be concrete');
  }
  assertExactBindingKeys(input.bindings);
  const bindings = REGISTRATION_BINDING_KEYS.map((key): RegistrationBinding => {
    const content = input.bindings[key];
    assertConcrete(content, `bindings.${key}`);
    return {
      key,
      sha256: hashCanonical(HASH_DOMAINS.preRegistration, { key, content }),
      content,
    };
  });
  const artifact: RegistrationPacketArtifact = {
    schemaVersion: 1,
    compilerVersion: REGISTRATION_PACKET_COMPILER_VERSION,
    experimentId: input.experimentId,
    registrationClass: input.registrationClass,
    bindings,
  };
  const canonicalArtifact = canonicalJson(artifact);
  const preRegistrationHash = hashCanonical(HASH_DOMAINS.preRegistration, artifact);
  if (!isSha256Hash(preRegistrationHash)) invalid('preRegistrationHash', 'did not encode as SHA-256');
  return {
    artifact,
    canonicalArtifact,
    preRegistrationHash,
    claimBoundary: 'draft-until-externally-registered-and-pre-run-anchored',
  };
}
