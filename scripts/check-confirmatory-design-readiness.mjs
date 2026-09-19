import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { validateConfirmatoryDesignReadiness } from './lib/confirmatory-design-readiness.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const readiness = read('protocols/confirmatory-design-readiness.v1.json');
const cards = read('protocols/research-protocol-cards.v1.json');
const allocation = read('protocols/seed-and-resource-allocation.v1.json');
const result = validateConfirmatoryDesignReadiness(readiness);

assert.deepEqual(result.memberIds, cards.confirmatoryFamily.members);
assert.equal(readiness.sourcePolicies.length, 4);
for (const source of readiness.sourcePolicies) {
  assert.equal(sha256(source.path), source.sha256, `${source.path}: design-readiness source changed`);
}
assert.equal(readiness.pilotRule.requiredValidSlotsPerMember,
  allocation.sampleSizeRule.pilotSlotsPerCondition);

console.log('Confirmatory design gate is incomplete by evidence: H5/H8 packet parameters, 8 margins, 9 pilots, and the joint simulation remain open');
