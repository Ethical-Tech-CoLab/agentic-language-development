import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileRegistrationPacket, REGISTRATION_BINDING_KEYS } from '@ald/analysis';
// @ts-expect-error The container boundary is executable ESM.
import { e02RootBuildInputs, validateE02SlotContract } from '../../deploy/mode-r/e02-slot-contract.mjs';
// @ts-expect-error The shared collector is executable ESM.
import { collectE02Observations, e02ProbeEvaluation } from '../../deploy/mode-r/collect-e02-observations.mjs';

// Synthetic contract fixtures only. No observations, receipts or registrations
// produced by this test are eligible as qualification evidence.
const seed = '1'.repeat(64);
function fixture() {
  const bindings: any = Object.fromEntries(REGISTRATION_BINDING_KEYS.map((key) => [key, 'unit-test-fixture']));
  bindings.selectedSeedPrefix = { primary: Array.from({ length: 5 }, (_, index) => ({
    slot: index + 1, scenario: String(index + 1).repeat(64),
  })) };
  bindings.runConfigurations = [{ rowsPerRolePerStage: 2016, totalTurnsPerSlot: 4034,
    deploymentMode: 'research-grade', learnerTrack: 'scratch-rl', turnResponseBudgetMs: 1000 }];
  const compiled = compileRegistrationPacket({ experimentId: 'E02', registrationClass: 'qualification', bindings });
  const packet = { artifact: compiled.artifact, preRegistrationHash: compiled.preRegistrationHash, researchFinding: false };
  const binding = JSON.parse(readFileSync('protocols/e01-registration-binding.v2.json', 'utf8'));
  binding.preRegistrationHash = packet.preRegistrationHash;
  binding.repositoryRegistration.path = 'protocols/e02-registration.v3.json';
  binding.repositoryRegistration.artifactSha256 = packet.preRegistrationHash;
  binding.preRunAnchor.inputData = `0x${packet.preRegistrationHash.slice(7)}`;
  binding.label = 'Synthetic E02 unit-test binding; not a registration';
  return { packet, binding };
}

describe('E02 prospective container contract', () => {
  it('derives probe status from completed reports rather than the requested profile', () => {
    expect(e02ProbeEvaluation('smoke', 0)).toBe('not-run-short-transport-smoke');
    expect(e02ProbeEvaluation('registered', 0)).toBe('not-reached');
    expect(e02ProbeEvaluation('registered', 5)).toBe('incomplete');
    expect(e02ProbeEvaluation('registered', 12)).toBe('completed');
  });
  it('binds root installation/build inputs while allowing commit-scoped version bumps', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(e02RootBuildInputs({ ...root, version: '999.0.1' })).toEqual(e02RootBuildInputs(root));
    expect(e02RootBuildInputs({ ...root, dependencies: { ...root.dependencies, injected: '1.0.0' } })).not.toEqual(e02RootBuildInputs(root));
    expect(() => e02RootBuildInputs({ ...root, scripts: { ...root.scripts, postinstall: 'unregistered-hook' } })).toThrow();
  });
  it('accepts the exact slot, seed, source-packet hash, class and simulated binding', () => {
    const { packet, binding } = fixture();
    expect(validateE02SlotContract(packet, binding, 1, seed, 'protocols/e02-registration.v3.json')).toEqual(binding);
  });
  const mutations = [
    ['wrong experiment', (p: any) => { p.artifact.experimentId = 'E01'; }],
    ['changed packet hash', (p: any) => { p.preRegistrationHash = `sha256:${'0'.repeat(64)}`; }],
    ['omitted binding', (p: any) => { p.artifact.bindings.pop(); }],
    ['duplicated binding', (p: any) => { p.artifact.bindings.push(p.artifact.bindings[0]); }],
    ['changed child digest', (p: any) => { p.artifact.bindings[0].sha256 = `sha256:${'0'.repeat(64)}`; }],
    ['behavioral finding claim', (p: any) => { p.researchFinding = true; }],
    ['wrong registered path', (_p: any, b: any) => { b.repositoryRegistration.path = 'protocols/e01-registration.v2.json'; }],
    ['wrong binding hash', (_p: any, b: any) => { b.preRegistrationHash = `sha256:${'0'.repeat(64)}`; }],
    ['wrong repository artifact', (_p: any, b: any) => { b.repositoryRegistration.artifactSha256 = `sha256:${'0'.repeat(64)}`; }],
    ['wrong anchor input', (_p: any, b: any) => { b.preRunAnchor.inputData = `0x${'0'.repeat(64)}`; }],
    ['unconfirmed anchor', (_p: any, b: any) => { b.preRunAnchor.status = 'pending'; }],
    ['wrong anchor network', (_p: any, b: any) => { b.preRunAnchor.network = 'base-mainnet'; b.preRunAnchor.chainId = 8453; }],
  ] as const;
  it.each(mutations)('rejects %s', (_label, mutate) => {
    const { packet, binding } = fixture();
    mutate(packet, binding);
    expect(() => validateE02SlotContract(packet, binding, 1, seed, 'protocols/e02-registration.v3.json')).toThrow();
  });
  it('does not allow a different seed or out-of-range slot', () => {
    const { packet, binding } = fixture();
    expect(() => validateE02SlotContract(packet, binding, 1, '9'.repeat(64), 'protocols/e02-registration.v3.json')).toThrow();
    expect(() => validateE02SlotContract(packet, binding, 0, seed, 'protocols/e02-registration.v3.json')).toThrow();
    expect(() => validateE02SlotContract(packet, binding, 6, seed, 'protocols/e02-registration.v3.json')).toThrow();
  });
  it('does not promote a development profile or run a registered profile in-process', async () => {
    const { binding } = fixture();
    const options = { directory: 'evidence/development/e02-unit-must-not-exist', seed,
      mode: 'prototype', profile: 'smoke', softwareCommit: 'a'.repeat(40) };
    await expect(collectE02Observations({ ...options, registration: binding })).rejects.toThrow();
    await expect(collectE02Observations({ ...options, profile: 'registered', registration: binding, slot: 1 })).rejects.toThrow();
    await expect(collectE02Observations({ ...options, profile: 'arbitrary' })).rejects.toThrow();
  });
});
