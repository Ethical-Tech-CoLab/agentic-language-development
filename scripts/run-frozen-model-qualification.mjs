#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  OpenAiCompatibleLocalClient,
  runFrozenModelQualification,
} from '@ald/learners';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    model: { type: 'string' },
    weights: { type: 'string' },
    quantization: { type: 'string' },
    'runtime-id': { type: 'string' },
    'runtime-artifact-hash': { type: 'string' },
    episodes: { type: 'string', default: '2' },
    out: {
      type: 'string',
      default: 'reports/qualification/frozen-model.json',
    },
  },
});
for (const [name, value] of [
  ['--endpoint', values.endpoint],
  ['--model', values.model],
  ['--weights', values.weights],
  ['--runtime-id', values['runtime-id']],
  ['--runtime-artifact-hash', values['runtime-artifact-hash']],
]) {
  if (value === undefined) throw new Error(`${name} is required`);
}
const episodes = Number(values.episodes);
if (!Number.isInteger(episodes) || episodes < 2) {
  throw new Error('--episodes must be an integer of at least two');
}
const softwareCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const client = await OpenAiCompatibleLocalClient.create({
  endpoint: values.endpoint,
  modelId: values.model,
  weightsPath: resolve(values.weights),
  ...(values.quantization === undefined
    ? {}
    : { quantization: values.quantization }),
});
const report = await runFrozenModelQualification({
  client,
  softwareCommit,
  executedAt: new Date().toISOString(),
  runtime: {
    id: values['runtime-id'],
    artifactHash: values['runtime-artifact-hash'],
  },
  episodes,
});
const outputPath = resolve(values.out);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
console.log(`model=${report.model.modelId}`);
console.log(`weightsHash=${report.model.weightsHash}`);
console.log(`runtime=${report.runtime.id}@${report.runtime.artifactHash}`);
console.log(`episodes=${String(report.episodes)} proposals=${String(report.proposals)}`);
console.log(report.claimBoundary);
