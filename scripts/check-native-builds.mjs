import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const workspace = parse(await readFile('pnpm-workspace.yaml', 'utf8'));
const lock = parse(await readFile('pnpm-lock.yaml', 'utf8'));

const exactAllowlist = new Set(
  Object.entries(workspace.allowBuilds ?? {})
    .filter(([, allowed]) => allowed === true)
    .map(([selector]) => selector),
);
const exactSelector = /^(?:@[^/]+\/[^@]+|[^@/]+)@(?:\d+\.\d+\.\d+|https:\/\/.*\/[0-9a-f]{40})$/u;
for (const selector of exactAllowlist) {
  if (!exactSelector.test(selector)) {
    throw new Error(`lifecycle build is not pinned exactly: ${selector}`);
  }
}

const resolvedPackages = new Set(Object.keys(lock.packages ?? {}));
for (const selector of exactAllowlist) {
  if (!resolvedPackages.has(selector)) {
    throw new Error(`allowlisted native dependency is not locked: ${selector}`);
  }
}

const unapproved = Object.entries(lock.snapshots ?? {})
  .filter(([, snapshot]) => snapshot?.requiresBuild === true)
  .map(([selector]) => selector)
  .filter((selector) => !exactAllowlist.has(selector));

if (unapproved.length > 0) {
  throw new Error(`unapproved lifecycle builds in lockfile: ${unapproved.join(', ')}`);
}

console.log(
  `Native lifecycle allowlist verified: ${[...exactAllowlist].join(', ')}.`,
);
