import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Every workspace package under packages/<name> is importable in tests as
// @ald/<name> straight from source, so tests never depend on build output.
const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));
const alias = Object.fromEntries(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [
      `@ald/${entry.name}`,
      `${packagesDir}${entry.name}/src/index.ts`,
    ]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: [
      'packages/**/__tests__/**/*.test.ts',
      'book/**/__tests__/**/*.test.ts',
      'twins/**/__tests__/**/*.test.ts',
    ],
    testTimeout: 60_000,
  },
});
