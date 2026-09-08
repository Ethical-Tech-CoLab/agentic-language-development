#!/usr/bin/env node
/**
 * Learner host entry point (SPEC §4.1 item 5, §5.2; ALD-055).
 *
 * Launched by `@ald/isolation`'s process transport under Node's permission
 * model, and by `deploy/mode-r/Dockerfile` as a container's TCP server. It
 * deliberately does nothing but hand argv to `runLearnerHostCli`: every read
 * this process is allowed to make is the module graph below, so the file must
 * stay a one-liner that adds no capability of its own.
 *
 * It loads the built package (`dist/`), not the TypeScript sources: a child
 * running under `--permission` cannot be given a loader, so `tsc --build
 * packages/isolation` is a prerequisite for the process transport.
 */
import { runLearnerHostCli } from '../dist/host.js';

await runLearnerHostCli(process.argv.slice(2));
