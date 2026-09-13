import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditE01Slot } from '../deploy/mode-r/audit-e01-v2-slot.mjs';

const source = resolve(process.argv[2]);
assert.equal(process.argv.length, 3, 'supply one retained development slot directory');
assert.equal((await auditE01Slot(source)).passed, true);
const alter = (root, path, change) => {
  const file = join(root, path);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  change(value);
  writeFileSync(file, `${JSON.stringify(value)}\n`);
};
const mutations = [
  ['changed receipt measurement', (root) => alter(root, 'slot.json', (r) => { r.records[31].durationMs = 0; })],
  ['changed run identity', (root) => alter(root, 'slot.json', (r) => { r.runId = 'unrelated'; })],
  ['duplicate topology', (root) => alter(root, 'slot.json', (r) => { r.topology.containerIds[1] = r.topology.containerIds[0]; })],
  ['missing signed attempt', (root) => unlinkSync(join(root, 'bundle/analysis/red-team-observation/gateway-url.json'))],
  ['missing attempt proof', (root) => unlinkSync(join(root, 'bundle/proofs/inclusion/intervention-2-at-1.json'))],
  ['corrupted raw capture', (root) => alter(root, 'bundle/analysis/red-team-observation/transport-rejected-1.json', (r) => { r.frames[0] = 'fiction'; })],
  ['changed witness', (root) => alter(root, 'bundle/run-manifest.json', (r) => { r.signers.find((s) => s.domain === 'witness').publicKey = r.signers[0].publicKey; })],
  ['false public anchor', (root) => alter(root, 'slot.json', (r) => { r.anchor.anchorClass = 'public-chain'; })],
];
for (const [label, mutate] of mutations) {
  const temporary = mkdtempSync(join(tmpdir(), 'ald-e01-mutation-'));
  try {
    cpSync(source, temporary, { recursive: true });
    mutate(temporary);
    let rejected = false;
    try { rejected = !(await auditE01Slot(temporary)).passed; } catch { rejected = true; }
    assert.equal(rejected, true, `${label} was accepted`);
    console.log(`rejected: ${label}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
console.log(`Original bundle preserved; ${mutations.length}/${mutations.length} mutated copies rejected`);
