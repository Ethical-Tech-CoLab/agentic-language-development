import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { readGroundTruth, ReferentialScenarioEngine } from '../packages/scenario/src/index.ts';
import { fixedTokenInventory, type ScenarioSplit } from '../packages/types/src/index.ts';

const design = JSON.parse(
  await readFile(
    new URL('../protocols/scenario-split-and-model-comparison.v1.json', import.meta.url),
    'utf8',
  ),
);
const scenario = design.scenario;
const allCodes = Array.from({ length: scenario.typeCodeCount }, (_, index) => index);
const seen = scenario.trainAndValidationTargetTypeCodes as number[];
const heldOut = scenario.heldOutTestTargetTypeCodes as number[];

assert.equal(design.schemaVersion, 1);
assert.deepEqual([...new Set([...seen, ...heldOut])].sort((a, b) => a - b), allCodes);
assert.equal(new Set(seen).size, seen.length);
assert.equal(new Set(heldOut).size, heldOut.length);
assert.equal(seen.some((code) => heldOut.includes(code)), false);
assert.deepEqual(heldOut, [0, 5, 10, 15]);

for (let value = 0; value < scenario.valuesPerAttribute; value += 1) {
  for (let position = 0; position < scenario.attributeCount; position += 1) {
    const divisor = scenario.valuesPerAttribute ** (scenario.attributeCount - position - 1);
    const seenCount = seen.filter(
      (code) => Math.floor(code / divisor) % scenario.valuesPerAttribute === value,
    ).length;
    const heldOutCount = heldOut.filter(
      (code) => Math.floor(code / divisor) % scenario.valuesPerAttribute === value,
    ).length;
    assert.equal(seenCount, 3, `seen attribute imbalance at position ${position}`);
    assert.equal(heldOutCount, 1, `held-out attribute imbalance at position ${position}`);
  }
}

const requiredBudgets = [
  'training episodes',
  'environment turns',
  'optimizer updates',
  'evaluation episodes',
  'intervention opportunities',
  'effective message capacity',
];
for (const budget of requiredBudgets) {
  assert.equal(design.budgetDimensions.includes(budget), true, `missing budget ${budget}`);
}
assert.equal(design.comparisonRules.length, 7);
assert.equal(
  design.comparisonRules.filter((rule: { kind: string }) => rule.kind === 'within-architecture-causal').length,
  6,
);
const crossArchitecture = design.comparisonRules.find(
  (rule: { id: string }) => rule.id === 'C-CROSS-ARCH',
);
assert.equal(crossArchitecture.kind, 'cross-architecture-descriptive');
assert.match(crossArchitecture.claim, /do not attribute differences causally/);

const engine = new ReferentialScenarioEngine(
  {
    version: 1,
    attributeCount: scenario.attributeCount,
    valuesPerAttribute: scenario.valuesPerAttribute,
    candidatesPerEpisode: scenario.candidatesPerEpisode,
    heldOutTypeCodes: heldOut,
    symbolInventory: fixedTokenInventory(32),
  },
  'ald-d04-split-audit-v1',
);
const roles = { sender: 'baby-a' as const, receiver: 'baby-b' as const };
const references = new Map<string, ScenarioSplit>();
const states = new Map<string, ScenarioSplit>();
const heldOutTargets = new Set<number>();

for (const split of ['train', 'validation', 'held-out'] as const) {
  for (let episode = 0; episode < 2_000; episode += 1) {
    const instance = engine.generate(episode, split, roles);
    const truth = readGroundTruth(instance.groundTruth);
    assert.equal(references.has(instance.scenarioRef), false, 'cross-split scenarioRef duplicate');
    assert.equal(states.has(instance.stateHash), false, 'cross-split stateHash duplicate');
    references.set(instance.scenarioRef, split);
    states.set(instance.stateHash, split);

    if (split === 'train' || split === 'validation') {
      assert.equal(heldOut.includes(truth.targetTypeCode), false);
      for (const code of [...truth.senderOrder, ...truth.receiverOrder]) {
        assert.equal(heldOut.includes(code), false, `${split} exposed held-out code ${code}`);
      }
    } else {
      assert.equal(heldOut.includes(truth.targetTypeCode), true);
      heldOutTargets.add(truth.targetTypeCode);
    }
  }
}

assert.deepEqual([...heldOutTargets].sort((a, b) => a - b), heldOut);
console.log(
  `Scenario design valid: 6,000 unique instances, ${seen.length} seen types, ${heldOut.length} held-out types, 7 comparison rules`,
);
