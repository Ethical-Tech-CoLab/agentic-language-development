import assert from 'node:assert/strict';
import { compileRegistrationPacket } from '@ald/analysis';
import { PreRegistrationBindingSchema } from '@ald/types';
import { E02_REGISTERED_ROWS_PER_STAGE } from './e02-observation-analysis.mjs';

export function e02RootBuildInputs(packageJson) {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prebuild', 'postbuild']) {
    assert.equal(packageJson.scripts[hook], undefined, `unregistered root lifecycle hook: ${hook}`);
  }
  return { name: packageJson.name, type: packageJson.type, engines: packageJson.engines,
    dependencies: packageJson.dependencies, devDependencies: packageJson.devDependencies,
    buildCommand: packageJson.scripts.build };
}

// A second boundary inside the container; the host also verifies Git ancestry
// and every frozen source before starting any registered learner observation.
export function validateE02SlotContract(packet, candidate, slot, seed) {
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 5);
  assert.match(seed, /^[a-f0-9]{64}$/u);
  assert.equal(packet.artifact.experimentId, 'E02');
  assert.equal(packet.artifact.registrationClass, 'qualification');
  assert.equal(packet.researchFinding, false);
  const bindings = Object.fromEntries(packet.artifact.bindings.map((entry) => [entry.key, entry.content]));
  const compiled = compileRegistrationPacket({ experimentId: 'E02', registrationClass: 'qualification', bindings });
  assert.deepEqual(compiled.artifact, packet.artifact);
  assert.equal(compiled.preRegistrationHash, packet.preRegistrationHash);
  assert.equal(bindings.selectedSeedPrefix.primary.length, 5);
  assert.equal(new Set(bindings.selectedSeedPrefix.primary.map((entry) => entry.scenario)).size, 5);
  assert.deepEqual(bindings.selectedSeedPrefix.primary.map((entry) => entry.slot), [1, 2, 3, 4, 5]);
  assert.deepEqual(bindings.selectedSeedPrefix.primary[slot - 1], { slot, scenario: seed });
  assert.equal(bindings.runConfigurations.length, 1);
  const config = bindings.runConfigurations[0];
  assert.equal(config.rowsPerRolePerStage, E02_REGISTERED_ROWS_PER_STAGE);
  assert.equal(config.totalTurnsPerSlot, 2 * E02_REGISTERED_ROWS_PER_STAGE + 2);
  assert.equal(config.deploymentMode, 'research-grade');
  assert.equal(config.learnerTrack, 'scratch-rl');
  assert.equal(config.turnResponseBudgetMs, 1000);
  const binding = PreRegistrationBindingSchema.parse(candidate);
  assert.equal(binding.registrationClass, 'qualification');
  assert.equal(binding.registrationAuthority, 'repository-native');
  assert.equal(binding.preRegistrationHash, packet.preRegistrationHash);
  assert.equal(binding.repositoryRegistration.path, 'protocols/e02-registration.v1.json');
  assert.equal(binding.repositoryRegistration.artifactSha256, packet.preRegistrationHash);
  assert.equal(binding.preRunAnchor.anchorClass, 'simulated');
  assert.equal(binding.preRunAnchor.network, 'base-sepolia');
  assert.equal(binding.preRunAnchor.chainId, 84532);
  assert.equal(binding.preRunAnchor.status, 'confirmed');
  assert.ok(Number.isSafeInteger(binding.preRunAnchor.blockNumber) && binding.preRunAnchor.blockNumber >= 0);
  assert.equal(binding.preRunAnchor.inputData, `0x${packet.preRegistrationHash.slice(7)}`);
  return binding;
}
