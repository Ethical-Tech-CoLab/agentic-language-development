#!/usr/bin/env node
// A0 single host-job lease. Dependency-free: node builtins only. One lease at
// a time across all agents; a lease requires a fresh admitting preflight
// receipt and prints the exact systemd-run invocation (transient leaf inside
// aldresearch.slice with pinned properties). This script records; it never
// launches the job itself.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const DIR = '.artifacts/a0-leases';
const ACTIVE = `${DIR}/active.json`;
const MAX_PREFLIGHT_AGE_MS = 10 * 60 * 1000;

function fail(message) {
  console.error(JSON.stringify({ lease: 'error', reason: message }));
  process.exit(2);
}
const command = process.argv[2];
if (!['create', 'show', 'release'].includes(command)) {
  fail('usage: node scripts/a0-lease.mjs <create|show|release> [...]');
}
if (command === 'show') {
  if (!existsSync(ACTIVE)) fail('no active lease');
  console.log(readFileSync(ACTIVE, 'utf8'));
  process.exit(0);
}
if (command === 'release') {
  let values;
  try {
    values = parseArgs({
      args: process.argv.slice(3),
      options: { owner: { type: 'string' }, reason: { type: 'string', default: '' } },
    }).values;
  } catch {
    fail('release takes only --owner and --reason');
  }
  if (!existsSync(ACTIVE)) fail('no active lease to release');
  const active = JSON.parse(readFileSync(ACTIVE, 'utf8'));
  if (!values.owner || values.owner !== active.owner) fail('release requires the owning --owner');
  const stamp = new Date().toISOString().replaceAll(':', '-');
  renameSync(ACTIVE, `${DIR}/released-${stamp}.json`);
  console.log(JSON.stringify({ lease: 'released', id: active.id, reason: values.reason }));
  process.exit(0);
}
// create
let values;
try {
  values = parseArgs({
    args: process.argv.slice(3),
    options: {
      owner: { type: 'string' },
      task: { type: 'string' },
      command: { type: 'string' },
      preflight: { type: 'string' },
      timeout: { type: 'string' },
      'declared-peak-bytes': { type: 'string', default: '805306368' },
    },
  }).values;
} catch {
  fail('create takes only --owner, --task, --command, --preflight, --timeout, and --declared-peak-bytes');
}
for (const key of ['owner', 'task', 'command', 'preflight', 'timeout']) {
  if (!values[key]) fail(`create requires --${key}`);
}
if (existsSync(ACTIVE)) {
  const active = JSON.parse(readFileSync(ACTIVE, 'utf8'));
  fail(`a lease is already active (${active.id} ${active.task} owned by ${active.owner}); release it first`);
}
let receipt;
try {
  receipt = JSON.parse(readFileSync(values.preflight, 'utf8'));
} catch {
  fail(`preflight receipt ${values.preflight} is missing or invalid`);
}
if (receipt.admission !== 'admit') fail(`preflight receipt ${values.preflight} does not admit (${receipt.admission})`);
const age = Date.now() - Date.parse(receipt.at);
if (!Number.isFinite(age) || age < 0 || age > MAX_PREFLIGHT_AGE_MS) fail('preflight receipt is stale (older than 10 minutes)');
const id = `a0-${Date.now().toString(36)}`;
const unit = `aldresearch-job-${id}.scope`;
const lease = {
  id,
  unit,
  owner: values.owner,
  task: values.task,
  command: values.command,
  preflight: values.preflight,
  preflightAt: receipt.at,
  timeout: values.timeout,
  declaredPeakBytes: Number(values['declared-peak-bytes']),
  createdAt: new Date().toISOString(),
  // Pinned transient-leaf properties. Slice membership carries the aggregate
  // caps; Nice/IOSchedulingClass deprioritize; MemoryMax is the per-job
  // backstop under the aggregate budget. Slice must already be installed.
  run: [
    'systemd-run', '--user', '--scope', `--unit=${unit}`,
    '--slice=aldresearch.slice',
    '--property=Nice=15',
    '--property=IOSchedulingClass=idle',
    '--property=MemoryHigh=768M',
    '--property=MemoryMax=1G',
    '--property=TasksMax=64',
    '--property=TimeoutStopSec=10',
    '--', 'sh', '-c', values.command,
  ],
};
mkdirSync(DIR, { recursive: true });
writeFileSync(ACTIVE, `${JSON.stringify(lease, null, 2)}\n`);
console.log(JSON.stringify(lease, null, 2));
