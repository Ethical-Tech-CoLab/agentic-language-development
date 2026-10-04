import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Named quarantine for evidence-absent checks (governance: plans/decisions.md,
// 2026-10-04 ~10:05 UTC; record: docs/quarantine-record.md).
//
// A check quarantines ONLY when its evidence is absent AND a committed marker
// file (quarantine/<name>.json) permits the skip. Evidence present always runs
// the full check; absent without a marker fails closed through the check's
// natural path. Reversal: restore the evidence (checks auto-restore) or delete
// the markers (checks fail closed again), then remove the branches.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function quarantineMarkerPath(name) {
  return join(ROOT, 'quarantine', `${name}.json`);
}

export function readQuarantineMarker(name) {
  const path = quarantineMarkerPath(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function quarantineLine(marker) {
  return `QUARANTINED ${marker.name}: ${marker.reason} | resume: ${marker.resume} | marker: quarantine/${marker.name}.json | record: docs/quarantine-record.md`;
}

// For check scripts: exit 0 with a loud line when quarantined; return
// normally otherwise. `present` must be true only when the check's own
// evidence probe succeeds.
export function exitIfQuarantined(name, present) {
  if (present) return;
  const marker = readQuarantineMarker(name);
  if (!marker) return;
  console.log(quarantineLine(marker));
  process.exit(0);
}

// For tests: return the loud line when quarantined, null otherwise. The
// caller prints it and asserts on it (a loud pass, never a silent skip).
export function quarantineSkipLine(name, present) {
  if (present) return null;
  const marker = readQuarantineMarker(name);
  if (!marker) return null;
  return quarantineLine(marker);
}
