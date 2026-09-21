#!/usr/bin/env node
/** Distinct Baby-process entry point for the process-development topology. */
import { runBabyHostCli } from '../dist/baby-host.js';

await runBabyHostCli(process.argv.slice(2));
