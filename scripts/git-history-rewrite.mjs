import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const map = JSON.parse(readFileSync(
  fileURLToPath(new URL('../protocols/git-history-rewrite-map.v1.json', import.meta.url)),
  'utf8',
));
const entries = Object.entries(map.entries);

/** Resolve a historical pre-rewrite commit to its equivalent current commit. */
export function resolveRewrittenCommit(commit) {
  const exact = map.entries[commit];
  if (exact !== undefined) return exact;
  const matches = entries.filter(([old]) => old.startsWith(commit));
  if (matches.length > 1) throw new Error(`ambiguous historical commit prefix: ${commit}`);
  return matches[0]?.[1] ?? commit;
}
