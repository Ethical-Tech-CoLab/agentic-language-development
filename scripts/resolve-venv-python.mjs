#!/usr/bin/env node
// Resolve the repository-local interpreter for the independent statistics
// programs (scripts/*.py). Anchored at this file's location, so it works no
// matter which directory the caller runs from. No absolute $HOME paths.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function venvPython() {
  const relative =
    process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const absolute = resolve(repoRoot, relative);
  if (!existsSync(absolute)) {
    throw new Error(
      `missing ${relative}; create it with: uv venv --python 3.13 && ` +
        'uv pip install --python .venv/bin/python -r requirements.txt ' +
        '(see CONFIGURATION.md)',
    );
  }
  return absolute;
}
