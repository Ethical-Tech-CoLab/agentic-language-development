import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manuscript = await readFile(new URL('../RESEARCH.md', import.meta.url), 'utf8');
const register = JSON.parse(
  await readFile(
    new URL('../reports/research/source-verification-register.json', import.meta.url),
    'utf8',
  ),
);

const referenceSection = manuscript.slice(
  manuscript.indexOf('\n## References\n'),
  manuscript.indexOf('\n---\n\n## Appendix A.'),
);
const manuscriptReferences = [...referenceSection.matchAll(/^\[(\d+)\] /gm)].map(
  (match) => Number(match[1]),
);

assert.deepEqual(
  manuscriptReferences,
  Array.from({ length: 50 }, (_, index) => index + 1),
  'RESEARCH.md must contain references [1] through [50] exactly once and in order',
);
assert.equal(register.schemaVersion, 1);
assert.equal(register.auditDate, '2026-09-11');
assert.equal(register.existingReferences.length, 50);
assert.equal(register.updatedSearch.length >= 5, true);

const allowedDepth = new Set(['metadata', 'abstract', 'description', 'full-text']);
const allowedDecision = new Set([
  'retain-load-bearing',
  'retain-supporting',
  'retain-method',
  'retain-context',
  'process-only',
  'exploratory-only',
]);
const seen = new Set();

for (const entry of register.existingReferences) {
  assert.equal(Number.isInteger(entry.ref), true);
  assert.equal(seen.has(entry.ref), false, `duplicate source-register ref ${entry.ref}`);
  seen.add(entry.ref);
  assert.equal(allowedDepth.has(entry.evidenceDepth), true, `invalid depth for [${entry.ref}]`);
  assert.equal(
    allowedDecision.has(entry.decision),
    true,
    `invalid decision for [${entry.ref}]`,
  );
  for (const field of ['publicationStatus', 'exactSupport', 'limitation']) {
    assert.equal(
      typeof entry[field] === 'string' && entry[field].trim().length > 0,
      true,
      `missing ${field} for [${entry.ref}]`,
    );
  }
}

assert.deepEqual([...seen].sort((a, b) => a - b), manuscriptReferences);
assert.match(referenceSection, /\[26\][\s\S]*116-140\./);
assert.doesNotMatch(manuscript, /\[15\][^\n]*causal symbol interventions/i);

const searchKeys = new Set();
for (const entry of register.updatedSearch) {
  assert.match(entry.key, /^S\d{2}$/);
  assert.equal(searchKeys.has(entry.key), false, `duplicate updated-search key ${entry.key}`);
  searchKeys.add(entry.key);
  assert.match(entry.url, /^https:\/\//);
  for (const field of ['title', 'publicationStatus', 'evidenceDepth', 'relevance', 'decision']) {
    assert.equal(
      typeof entry[field] === 'string' && entry[field].trim().length > 0,
      true,
      `missing ${field} for ${entry.key}`,
    );
  }
}

console.log(
  `Source register valid: ${register.existingReferences.length} existing references and ${register.updatedSearch.length} updated-search records`,
);
