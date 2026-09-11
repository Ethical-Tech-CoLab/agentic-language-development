import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [notebook, cards] = await Promise.all([
  readFile(new URL('../EXPERIMENT-NOTEBOOK.md', import.meta.url), 'utf8'),
  readFile(new URL('../protocols/research-protocol-cards.v1.json', import.meta.url), 'utf8').then(
    JSON.parse,
  ),
]);

const notebookIds = [...notebook.matchAll(/^## (E\d+)\./gm)].map((match) => match[1]);
const expectedIds = [
  'E00', 'E01', 'E02', 'E03', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15',
  'E16', 'E20', 'E21', 'E22', 'E30', 'E31', 'E32', 'E40', 'E50',
];
const expectedHypotheses = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6a', 'H6b', 'H7', 'H8'];
const allowedClasses = new Set([
  'qualification',
  'confirmatory',
  'secondary',
  'secondary-benchmark',
  'exploratory',
  'replication',
]);

assert.equal(cards.schemaVersion, 1);
assert.deepEqual(notebookIds, expectedIds, 'experiment notebook index has drifted');
assert.deepEqual(cards.cards.map((card) => card.id), expectedIds);
assert.deepEqual(cards.hypotheses.map((hypothesis) => hypothesis.id), expectedHypotheses);
assert.deepEqual(cards.confirmatoryFamily.members, expectedHypotheses);
assert.equal(cards.confirmatoryFamily.familywiseAlpha, 0.05);
assert.match(cards.confirmatoryFamily.procedure, /Holm/);
assert.match(cards.confirmatoryFamily.validityGate, /not-tested/);

const cardIds = new Set(expectedIds);
for (const card of cards.cards) {
  assert.equal(allowedClasses.has(card.class), true, `invalid class for ${card.id}`);
  for (const field of [
    'question', 'unit', 'exposure', 'comparator', 'primaryOutcome', 'estimand',
    'nextDesignOwner',
  ]) {
    assert.equal(
      typeof card[field] === 'string' && card[field].trim().length > 0,
      true,
      `missing ${field} for ${card.id}`,
    );
  }
  assert.equal(Array.isArray(card.secondary), true);
  assert.equal(Array.isArray(card.exploratory), true);
  assert.equal(Array.isArray(card.dependencies), true);
}

for (const hypothesis of cards.hypotheses) {
  assert.equal(cardIds.has(hypothesis.experiment), true);
  assert.equal(hypothesis.estimand.trim().length > 0, true);
  assert.equal(hypothesis.decision.trim().length > 0, true);
}

const h2 = cards.hypotheses.find((hypothesis) => hypothesis.id === 'H2');
const h4 = cards.hypotheses.find((hypothesis) => hypothesis.id === 'H4');
assert.notEqual(h2.estimand, h4.estimand);
assert.match(h2.estimand, /receiver probability/);
assert.match(h4.estimand, /proper prediction score/);
assert.match(h4.estimand, /transcript-only/);

console.log(
  `Protocol cards valid: ${cards.cards.length} experiments, ${cards.hypotheses.length} confirmatory hypotheses`,
);
