import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

const repositoryRoot = resolve(process.argv[2] ?? process.cwd());
const protectedRoots = [
  join(repositoryRoot, 'packages', 'hashing'),
  join(repositoryRoot, 'packages', 'anchor'),
];
const forbidden = /(?:@ald\/crypto-research|packages\/crypto-research|crypto-research\/src)/u;

async function filesUnder(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:ts|js|mjs|cjs|json)$/u.test(entry.name)) files.push(path);
    }
  }
  await walk(root);
  return files;
}

const violations = [];
for (const root of protectedRoots) {
  for (const file of await filesUnder(root)) {
    const text = await readFile(file, 'utf8');
    if (forbidden.test(text)) violations.push(relative(repositoryRoot, file));
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Cryptographic research boundary violation:\n${violations.map((file) => `- ${file}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('lint-crypto-boundary: production hashing and anchoring are isolated\n');
}
