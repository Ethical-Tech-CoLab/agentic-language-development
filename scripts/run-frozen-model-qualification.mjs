#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { canonicalJson } from '@ald/hashing';
import {
  OpenAiCompatibleLocalClient,
  probeLlamaServer,
  runFrozenModelQualification,
} from '@ald/learners';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'qwen3-4b-q4-k-m' },
    weights: { type: 'string' },
    quantization: { type: 'string', default: 'Q4_K_M' },
    runtime: { type: 'string', default: 'llama-server' },
    episodes: { type: 'string', default: '2' },
    'context-length': { type: 'string', default: '4096' },
    'max-output-tokens': { type: 'string', default: '192' },
    'turn-response-budget-ms': { type: 'string', default: '300000' },
    'baby-a-port': { type: 'string', default: '19091' },
    'baby-b-port': { type: 'string', default: '19092' },
    out: {
      type: 'string',
      default: 'reports/qualification/frozen-model-qwen3-4b-q4-k-m.json',
    },
    'log-dir': {
      type: 'string',
      default: 'evidence/qualification/frozen-model-servers',
    },
  },
});

if (values.weights === undefined) throw new Error('--weights is required');
const episodes = positiveInteger(values.episodes, '--episodes');
if (episodes < 2) throw new Error('--episodes must be at least two');
const contextLength = positiveInteger(values['context-length'], '--context-length');
const maxOutputTokens = positiveInteger(
  values['max-output-tokens'],
  '--max-output-tokens',
);
const turnResponseBudgetMs = positiveInteger(
  values['turn-response-budget-ms'],
  '--turn-response-budget-ms',
);
const ports = {
  'baby-a': validPort(values['baby-a-port'], '--baby-a-port'),
  'baby-b': validPort(values['baby-b-port'], '--baby-b-port'),
};
if (ports['baby-a'] === ports['baby-b']) {
  throw new Error('role server ports must be distinct');
}

const weightsPath = resolve(values.weights);
const weightsStat = statSync(weightsPath);
if (!weightsStat.isFile() || weightsStat.size === 0) {
  throw new Error('--weights must identify a non-empty regular file');
}
if ((weightsStat.mode & 0o222) !== 0) {
  throw new Error('the qualification weights file must be read-only');
}

const runtimePath = realpathSync(
  execFileSync('which', [values.runtime], { encoding: 'utf8' }).trim(),
);
const runtimeVersion = spawnSync(runtimePath, ['--version'], {
  encoding: 'utf8',
});
if (runtimeVersion.status !== 0) {
  throw new Error('llama-server --version failed');
}
const runtimeVersionOutput = `${runtimeVersion.stdout}${runtimeVersion.stderr}`.trim();
const buildMatch = runtimeVersionOutput.match(
  /version:\s*([^\s]+).*build\s+(\d+),\s*commit\s+([0-9a-f]+)/su,
);
if (buildMatch === null) {
  throw new Error('could not parse llama-server --version output');
}
const [, formulaVersion, buildNumber, runtimeCommit] = buildMatch;
const runtimeHash = await hashFile(runtimePath);
const weightsHash = await hashFile(weightsPath);
const brewInfo = JSON.parse(
  execFileSync('brew', ['info', '--json=v2', 'llama.cpp'], {
    encoding: 'utf8',
  }),
);
const formula = brewInfo.formulae?.[0];
const bottleSha = formula?.bottle?.stable?.files?.x86_64_linux?.sha256;
if (formula?.versions?.stable !== formulaVersion || typeof bottleSha !== 'string') {
  throw new Error('Homebrew formula provenance does not match the runtime');
}

const logDir = resolve(values['log-dir']);
await mkdir(logDir, { recursive: true });
const endpoint = (role) => `http://127.0.0.1:${ports[role]}`;
const launch = {
  host: '127.0.0.1',
  contextLength,
  parallelSlots: 1,
  promptCacheEnabled: false,
  temperature: 0,
  maxOutputTokens,
  turnResponseBudgetMs,
  thinkingDisabled: true,
  toolChoice: 'required',
};

let activeServer;
let serverSequence = 0;
try {
  const before = await attestAndReplay('before-reset');
  const after = await attestAndReplay('after-reset');
  const beforeProbes = before.probes;
  const afterProbes = after.probes;
  assertStableProbes(beforeProbes, afterProbes);
  const expectedBuildInfo = `b${buildNumber}-${runtimeCommit}`;
  if (
    Object.values(afterProbes).some(
      (probe) => probe.buildInfo !== expectedBuildInfo,
    )
  ) {
    throw new Error('live server build does not match the hashed runtime executable');
  }
  const clients = await createManagedClients();
  const reset = {
    strategy: 'clean-process-restart',
    roles: Object.fromEntries(
      ['baby-a', 'baby-b'].map((role) => {
        const beforeResponseHash = before.responses[role];
        const afterResponseHash = after.responses[role];
        if (beforeResponseHash !== afterResponseHash) {
          throw new Error(`${role} response changed after a clean process restart`);
        }
        return [
          role,
          { beforeResponseHash, afterResponseHash, matched: true },
        ];
      }),
    ),
  };

  const softwareCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const report = await runFrozenModelQualification({
    clients,
    softwareCommit,
    executedAt: new Date().toISOString(),
    runtime: {
      id: `llama.cpp-${formulaVersion}-b${buildNumber}-${runtimeCommit}`,
      artifactHash: runtimeHash,
      installationManager: 'homebrew',
      formula: 'llama.cpp',
      formulaVersion,
      bottleSha256: `sha256:${bottleSha}`,
    },
    launch,
    servers: afterProbes,
    reset,
    episodes,
  });

  if (
    (await hashFile(weightsPath)) !== weightsHash ||
    (await hashFile(runtimePath)) !== runtimeHash
  ) {
    throw new Error('model weights or runtime executable changed during qualification');
  }
  const outputPath = resolve(values.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputPath}`);
  console.log(`model=${report.model.modelId}`);
  console.log(`weightsHash=${report.model.weightsHash}`);
  console.log(`runtime=${report.runtime.id}@${report.runtime.artifactHash}`);
  console.log(
    `episodes=${String(report.episodes)} proposals=${String(report.proposals)} liveCalls=${String(report.toolBoundary.liveCalls)}`,
  );
  console.log(report.claimBoundary);
} finally {
  await stopActiveServer();
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function validPort(value, label) {
  const parsed = positiveInteger(value, label);
  if (parsed > 65_535) throw new Error(`${label} must be at most 65535`);
  return parsed;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function startRoleServer(role, stage) {
  await stopActiveServer();
  serverSequence += 1;
  const logPath = resolve(
    logDir,
    `${String(serverSequence).padStart(2, '0')}-${stage}-${role}.log`,
  );
  const logFd = openSync(logPath, 'w');
  const child = spawn(
    runtimePath,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(ports[role]),
      '--model',
      weightsPath,
      '--alias',
      values.model,
      '--ctx-size',
      String(contextLength),
      '--parallel',
      '1',
      '--seed',
      '1701',
      '--temp',
      '0',
      '--no-cache-prompt',
      '--jinja',
      '--no-webui',
    ],
    { stdio: ['ignore', logFd, logFd] },
  );
  activeServer = { role, child, logFd, logPath };
  try {
    await waitUntilHealthy(role, activeServer);
  } catch (error) {
    await stopActiveServer();
    throw error;
  }
}

async function waitUntilHealthy(role, process) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) {
      throw new Error(`${role} server exited; inspect ${process.logPath}`);
    }
    try {
      const response = await fetch(`${endpoint(role)}/health`);
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch {
      // Loading is expected to refuse connections until the model is ready.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`${role} server did not become healthy within 180 seconds`);
}

async function stopActiveServer() {
  const process = activeServer;
  if (process === undefined) return;
  activeServer = undefined;
  if (process.child.exitCode === null) process.child.kill('SIGTERM');
  await new Promise((resolveExit) => {
    if (process.child.exitCode !== null) return resolveExit();
    const timer = setTimeout(() => {
      if (process.child.exitCode === null) process.child.kill('SIGKILL');
    }, 30_000);
    process.child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  closeSync(process.logFd);
}

async function createTransportClients() {
  return Object.fromEntries(
    await Promise.all(
      ['baby-a', 'baby-b'].map(async (role) => [
        role,
        await OpenAiCompatibleLocalClient.create({
          endpoint: endpoint(role),
          modelId: values.model,
          weightsHash,
          quantization: values.quantization,
          contextLength,
          disableThinking: true,
        }),
      ]),
    ),
  );
}

async function createManagedClients() {
  const transports = await createTransportClients();
  return Object.fromEntries(
    ['baby-a', 'baby-b'].map((role) => [
      role,
      {
        describe: () => transports[role].describe(),
        complete: async (request) => {
          if (activeServer?.role !== role) {
            await startRoleServer(role, 'qualification');
          }
          return transports[role].complete(request);
        },
      },
    ]),
  );
}

async function attestAndReplay(stage) {
  const transports = await createTransportClients();
  const probes = {};
  const responses = {};
  for (const role of ['baby-a', 'baby-b']) {
    await startRoleServer(role, stage);
    probes[role] = await probeLlamaServer({
      endpoint: endpoint(role),
      modelId: values.model,
    });
    responses[role] = await replay(transports[role], role);
    await stopActiveServer();
  }
  return { probes, responses };
}

async function replay(client, role) {
  const response = await client.complete({
    systemPrompt: 'Call the required tool and emit no text.',
    observation: { candidates: [[0], [1]], targetIndex: 0 },
    memoryDigest: {
      version: 'frozen-llm-memory-v1',
      turns: 0,
      symbolsTracked: 0,
      entries: [],
    },
    tools: [
      {
        name: 'emit_symbols',
        parameters: {
          type: 'object',
          properties: {
            symbols: {
              type: 'array',
              items: { type: 'string', enum: ['S00', 'S01'] },
              minItems: 1,
              maxItems: 1,
            },
          },
          required: ['symbols'],
          additionalProperties: false,
        },
      },
    ],
    maxOutputTokens,
    temperature: 0,
    samplingSeed: 1701,
    timeBudgetMs: 120_000,
  });
  if (
    response.raw.trim() !== '' ||
    response.toolCall?.name !== 'emit_symbols' ||
    typeof response.toolCall.arguments !== 'object' ||
    response.toolCall.arguments === null
  ) {
    throw new Error(`${role} did not return a tool-only replay response`);
  }
  const digest = createHash('sha256')
    .update(canonicalJson(response))
    .digest('hex');
  return `sha256:${digest}`;
}

function assertStableProbes(before, after) {
  for (const role of ['baby-a', 'baby-b']) {
    if (canonicalJson(before[role]) !== canonicalJson(after[role])) {
      throw new Error(`${role} live server attestation changed across restart`);
    }
  }
}
