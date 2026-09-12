#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { compileRegistrationPacket } from '@ald/analysis';

const registrationPath = 'protocols/e01-registration.v1.json';
const bindingPath = 'protocols/e01-registration-binding.v1.json';
const evidenceRoot = 'evidence/qualification/e01-v1';
const receiptPath = 'reports/research/e01-isolation-qualification-receipt.json';
const composeFile = 'deploy/mode-r/docker-compose.yml';

function absent(path: string): void {
  try {
    accessSync(path);
  } catch {
    return;
  }
  throw new Error(`refusing to overwrite prior E01 attempt at ${path}`);
}

function command(commandName: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(commandName, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function requireSuccess(commandName: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): string {
  const result = command(commandName, args, options);
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${commandName} ${args.join(' ')} exited ${String(result.status)}`);
  }
  return result.stdout;
}

const status = requireSuccess('git', ['status', '--porcelain']).trim();
if (status !== '') throw new Error('E01 qualification requires an exact clean execution commit');
absent(evidenceRoot);
absent(receiptPath);

const registrationText = readFileSync(registrationPath, 'utf8');
const registration = JSON.parse(registrationText) as {
  preRegistrationHash: string;
  artifact: { experimentId: string; registrationClass: string; bindings: Array<{ key: string; content: unknown }> };
};
const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as {
  preRegistrationHash: string;
  preRunAnchor: { anchorClass: string; inputData: string; status: string };
};
const bindings = Object.fromEntries(
  registration.artifact.bindings.map((entry) => [entry.key, entry.content]),
) as Parameters<typeof compileRegistrationPacket>[0]['bindings'];
const reproduced = compileRegistrationPacket({
  experimentId: registration.artifact.experimentId,
  registrationClass: registration.artifact.registrationClass,
  bindings,
});
if (
  registration.artifact.experimentId !== 'E01' ||
  reproduced.preRegistrationHash !== registration.preRegistrationHash ||
  binding.preRegistrationHash !== registration.preRegistrationHash ||
  binding.preRunAnchor.anchorClass !== 'simulated' ||
  binding.preRunAnchor.status !== 'confirmed' ||
  binding.preRunAnchor.inputData !== `0x${registration.preRegistrationHash.slice(7)}`
) {
  throw new Error('E01 packet or simulated pre-run commitment is invalid');
}
const sourceHashes = bindings['analysisVersions'] as Array<{ path: string; sha256: string }>;
for (const source of sourceHashes) {
  const actual = createHash('sha256').update(readFileSync(source.path)).digest('hex');
  if (actual !== source.sha256) throw new Error(`registered source changed: ${source.path}`);
}
const seedBinding = bindings['selectedSeedPrefix'] as {
  primary: Array<{ slot: number; scenario: string }>;
};
if (seedBinding.primary.length !== 5) throw new Error('E01 requires five registered slots');

mkdirSync(evidenceRoot, { recursive: true });
const executionCommit = requireSuccess('git', ['rev-parse', 'HEAD']).trim();
const project = `ald-e01-${process.pid}`;
const base = ['compose', '--project-name', project, '--file', composeFile];
const slots: unknown[] = [];
let failure: string | null = null;
const started = performance.now();
try {
  requireSuccess('docker', [...base, 'build', 'baby-a', 'baby-b', 'nursery']);
  for (const selected of seedBinding.primary) {
    const slotEnvironment = { ALD_LEARNER_TRACK: 'no-learning' };
    requireSuccess(
      'docker',
      [...base, 'up', '--detach', '--force-recreate', 'baby-a', 'baby-b'],
      { env: slotEnvironment },
    );
    const result = command(
      'docker',
      [
        ...base,
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        '/usr/local/bin/node',
        'nursery',
        '/app/deploy/mode-r/run-e01-qualification.mjs',
        String(selected.slot),
        selected.scenario,
      ],
      { env: slotEnvironment },
    );
    const jsonLine = (result.stdout ?? '')
      .trim()
      .split('\n')
      .reverse()
      .find((line) => line.startsWith('{'));
    const slotPath = join(evidenceRoot, `slot-${String(selected.slot).padStart(2, '0')}.json`);
    if (jsonLine === undefined) {
      writeFileSync(slotPath.replace('.json', '.log'), `${result.stdout}${result.stderr}`);
      throw new Error(`E01 slot ${String(selected.slot)} emitted no JSON result`);
    }
    const parsed = JSON.parse(jsonLine) as { slot: number; scenarioSeed: string; passed: boolean };
    writeFileSync(slotPath, `${JSON.stringify(parsed, null, 2)}\n`);
    slots.push(parsed);
    if (
      result.status !== 0 ||
      parsed.slot !== selected.slot ||
      parsed.scenarioSeed !== selected.scenario ||
      !parsed.passed
    ) {
      throw new Error(`E01 slot ${String(selected.slot)} failed its registered gate`);
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  command('docker', [...base, 'down', '--volumes', '--remove-orphans']);
}

const receipt = {
  schemaVersion: 1,
  classification: 'prospectively-registered-software-qualification',
  researchFinding: false,
  experimentId: 'E01',
  registrationHash: registration.preRegistrationHash,
  registrationBinding: bindingPath,
  executionCommit,
  externalSpend: 0,
  publicChainTransaction: false,
  topologySlotsAttempted: slots.length,
  plannedTopologySlots: 5,
  wallMilliseconds: performance.now() - started,
  slots,
  passed: failure === null && slots.length === 5,
  failure,
  retainedEvidenceRoot: evidenceRoot,
  claimBoundary:
    'E01 software qualification on the registered local two-container topology only; no behavioral, public-chain, independent-review, or universal side-channel-resistance claim.',
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!receipt.passed) throw new Error(`E01 qualification failed; evidence retained: ${failure}`);
