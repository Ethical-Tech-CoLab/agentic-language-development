#!/usr/bin/env node
/**
 * `ald-verify` entry point (BACKLOG ALD-015). Run `pnpm run build` in the
 * repository root, or `tsc --build packages/verifier`, before invoking it.
 */
import { runCli } from '../dist/cli.js';

const exitCode = await runCli(process.argv.slice(2));
process.exit(exitCode);
