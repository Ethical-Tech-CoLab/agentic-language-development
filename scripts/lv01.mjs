import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stages = new Set(['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
const root = resolve('.');

function fail(message) {
  throw new Error(`LV01: ${message}`);
}

function run(script) {
  execFileSync(process.execPath, [script], { cwd: root, stdio: 'inherit' });
}

function parse(command, specification) {
  const argumentsByName = new Map();
  const values = process.argv.slice(3);
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!specification.has(name) || argumentsByName.has(name)) fail(`unknown or repeated option ${name ?? '<missing>'}`);
    const takesValue = specification.get(name);
    const value = takesValue ? values[++index] : true;
    if (takesValue && (value === undefined || value.startsWith('--'))) fail(`option ${name} requires a value`);
    argumentsByName.set(name, value);
  }
  for (const [name, takesValue] of specification) {
    if (!argumentsByName.has(name)) fail(`missing required option ${name}`);
    if (!takesValue && argumentsByName.get(name) !== true) fail(`option ${name} does not take a value`);
  }
  return argumentsByName;
}

function stageArguments(command) {
  const flags = command === 'qualify-topology' || command === 'collect'
    ? new Map([['--stage', true], ['--version', true], ['--run', false]])
    : new Map([['--stage', true], ['--version', true], ['--write', false]]);
  const options = parse(command, flags);
  const stage = options.get('--stage');
  const version = Number(options.get('--version'));
  if (!stages.has(stage)) fail(`unsupported stage ${stage}`);
  if (!Number.isInteger(version) || version < 1) fail('version must be a positive integer');
  return { stage, version };
}

function receipt(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

function status() {
  run('scripts/check-lv01-design.mjs');
  run('scripts/check-lv01-power-qualification.mjs');
  const topology = receipt('reports/research/lv01-topology-qualification.v1.json');
  const report = {
    schemaVersion: 1,
    studyId: 'LV01',
    executionReadiness: topology?.passed === true ? 'unresolved' : 'blocked',
    attemptStatus: 'unstarted',
    scientificDisposition: 'not-tested',
    evidence: {
      design: 'verified',
      numericalQualification: 'verified',
      topologyQualification: topology?.passed === true ? 'present-but-not-admitted' : 'missing',
      registration: 'missing',
      resourceAllocation: 'missing',
    },
    claimBoundary: 'Current source checks only. No stage registration, topology qualification, collection, or scientific result is implied.',
  };
  console.log(JSON.stringify(report, null, 2));
}

function requirePrerequisites(stage, version) {
  run('scripts/check-lv01-design.mjs');
  run('scripts/check-lv01-power-qualification.mjs');
  const topologyPath = `reports/research/lv01-topology-qualification.v${version}.json`;
  const topology = receipt(topologyPath);
  if (topology?.passed !== true) fail(`${stage} v${version} is blocked: missing passed topology qualification ${topologyPath}`);
  const allocation = `protocols/lv01-${stage}-resource-allocation.v${version}.json`;
  if (!existsSync(resolve(root, allocation))) fail(`${stage} v${version} is blocked: missing resource allocation ${allocation}`);
  const registration = `protocols/lv01-${stage}-registration.v${version}.json`;
  const binding = `protocols/lv01-${stage}-registration-binding.v${version}.json`;
  if (!existsSync(resolve(root, registration)) || !existsSync(resolve(root, binding))) {
    fail(`${stage} v${version} is blocked: missing prospective registration or binding`);
  }
}

const command = process.argv[2];
if (!command) fail('usage: node scripts/lv01.mjs <command> [strict options]');

switch (command) {
  case 'check-design':
    parse(command, new Map());
    run('scripts/check-lv01-design.mjs');
    break;
  case 'qualify-numerics':
    parse(command, new Map([['--write', false]]));
    if (existsSync(resolve(root, 'reports/research/lv01-power-qualification.v1.json'))) {
      fail('numerical qualification receipt is immutable; use check-package or audit:lv01-power-qualification');
    }
    fail('numerical qualification writer is unavailable without a fresh source-bound qualification target');
    break;
  case 'status':
    parse(command, new Map([['--live-evidence', false]]));
    status();
    break;
  case 'check-package':
    parse(command, new Map());
    status();
    break;
  case 'allocate': {
    const { stage, version } = stageArguments(command);
    if (stage !== 'development') fail(`${stage} v${version} allocation is blocked until topology qualification and measured resources exist`);
    const allocation = `protocols/lv01-development-resource-allocation.v${version}.json`;
    if (!existsSync(resolve(root, allocation))) fail(`development v${version} allocation requires the bounded allocation packet; no blank packet is created`);
    run('scripts/check-lv01-development-allocation.mjs', '--version', version);
    fail(`development v${version} allocation is immutable at ${allocation}; no overwrite is permitted`);
    break;
  }
  case 'qualify-topology': {
    const { stage, version } = stageArguments(command);
    if (stage !== 'development') fail('topology qualification is development-only');
    const allocation = `protocols/lv01-development-resource-allocation.v${version}.json`;
    if (!existsSync(resolve(root, allocation))) fail(`development v${version} topology qualification is blocked: allocation packet is absent`);
    run('scripts/check-lv01-development-allocation.mjs');
    fail(`development v${version} topology qualification is blocked: the live LV01 runner and matrix receipt are not implemented`);
    break;
  }
  case 'audit-topology': {
    const options = parse(command, new Map([['--version', true], ['--live-evidence', false]]));
    const version = Number(options.get('--version'));
    if (!Number.isInteger(version) || version < 1) fail('version must be a positive integer');
    const topology = `reports/research/lv01-topology-qualification.v${version}.json`;
    if (!existsSync(resolve(root, topology))) fail(`topology audit is unresolved: missing ${topology}`);
    console.log(`LV01 topology receipt is present at ${topology}`);
    break;
  }
  case 'compile':
  case 'bind': {
    const { stage, version } = stageArguments(command);
    requirePrerequisites(stage, version);
    fail(`${command} is intentionally unavailable until the stage packet schema is implemented`);
    break;
  }
  case 'admit':
  case 'audit': {
    const options = parse(command, new Map([['--stage', true], ['--version', true], ['--live-evidence', false]]));
    const stage = options.get('--stage');
    const version = Number(options.get('--version'));
    if (!stages.has(stage) || !Number.isInteger(version) || version < 1) fail('invalid stage or version');
    requirePrerequisites(stage, version);
    fail(`${command} is intentionally unavailable until immutable admission receipts are implemented`);
    break;
  }
  case 'collect': {
    const { stage, version } = stageArguments(command);
    requirePrerequisites(stage, version);
    fail(`collection is unavailable: ${stage} v${version} has no admitted immutable receipt`);
    break;
  }
  case 'reduce-pilot': {
    const options = parse(command, new Map([['--version', true], ['--write', false]]));
    fail(`pilot reduction v${options.get('--version')} is blocked: no complete pilot evidence exists`);
    break;
  }
  case 'lock-design': {
    const options = parse(command, new Map([['--pilot-version', true], ['--write', false]]));
    fail(`design lock is blocked: pilot v${options.get('--pilot-version')} has no reduction receipt`);
    break;
  }
  default:
    fail(`unknown command ${command}`);
}
