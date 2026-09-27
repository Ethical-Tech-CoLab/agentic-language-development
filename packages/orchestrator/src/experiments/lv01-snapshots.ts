/**
 * Fixed-cadence policy snapshots (R04 item 5). Pure extraction: select the
 * comparable drift series (initial, every cadence multiple, final) from a
 * bundle's policy-file listing. Callers do the filesystem reads; this module
 * only parses names and enforces gap-free coverage.
 */
function fail(message: string): never {
  throw new Error(`LV01 policy snapshots: ${message}`);
}

export interface Lv01PolicySnapshotRef {
  readonly role: 'baby-a' | 'baby-b';
  /** 'initial' or the checkpoint turn. */
  readonly turn: number | 'initial';
  readonly fileName: string;
}

const POLICY_FILE = /^baby-(a|b)-policy-(initial|\d+)\.json$/u;

export function extractLv01PolicySnapshots(
  fileNames: readonly string[],
  cadenceTurns: number,
  finalTurn: number,
): { readonly babyA: readonly Lv01PolicySnapshotRef[]; readonly babyB: readonly Lv01PolicySnapshotRef[] } {
  if (!Number.isInteger(cadenceTurns) || cadenceTurns < 1) {
    fail('snapshot cadence must be a positive integer number of turns');
  }
  if (!Number.isInteger(finalTurn) || finalTurn < 0) fail('final turn is invalid');
  const byRole = { 'baby-a': new Map<string, string>(), 'baby-b': new Map<string, string>() };
  for (const fileName of fileNames) {
    const match = POLICY_FILE.exec(fileName);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    byRole[match[1] === 'a' ? 'baby-a' : 'baby-b'].set(match[2], fileName);
  }
  const expected: (number | 'initial')[] = ['initial'];
  for (let turn = cadenceTurns; turn <= finalTurn; turn += cadenceTurns) expected.push(turn);
  if (finalTurn > 0 && finalTurn % cadenceTurns !== 0) expected.push(finalTurn);
  const select = (role: 'baby-a' | 'baby-b'): Lv01PolicySnapshotRef[] => {
    const available = byRole[role];
    const missing = expected.filter((turn) => !available.has(String(turn)));
    if (missing.length > 0) {
      fail(`${role} is missing snapshots at ${missing.join(', ')}`);
    }
    return expected.map((turn) => ({
      role,
      turn,
      fileName: available.get(String(turn)) as string,
    }));
  };
  return { babyA: select('baby-a'), babyB: select('baby-b') };
}
