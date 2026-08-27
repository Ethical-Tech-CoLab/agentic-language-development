import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ald/config': fileURLToPath(
        new URL('./packages/config/src/index.ts', import.meta.url),
      ),
      '@ald/evidence': fileURLToPath(
        new URL('./packages/evidence/src/index.ts', import.meta.url),
      ),
      '@ald/types': fileURLToPath(
        new URL('./packages/types/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'packages/**/__tests__/**/*.test.ts',
      'twins/**/__tests__/**/*.test.ts',
    ],
  },
});
