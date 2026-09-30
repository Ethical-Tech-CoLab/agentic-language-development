import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stages = new Set(['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
const partitions = new Set(['dev', 'within-support', 'novel-composition']);
const root = resolve('.');

function fail(message) {
  throw new Error(`LV01: ${message}`);
}

function run(script, ...args) {
  execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
}

/**
 * Chain versions advance faster than frozen design versions: v1 chains run
 * the v1 design, v2 and later chains run the frozen v2 design until a v3
 * design is registered (which extends this mapping explicitly).
 */
function designVersion(chainVersion) {
  return chainVersion >= 2 ? 2 : 1;
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
  const flags = command === 'qualify-topology'
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
  // F-R05-1 document branch: status/check-package surface v1 checks only;
  // v2 readiness has no surface here (see claimBoundary). Parameterizing
  // awaits v2 topology/registration evidence, which does not exist yet.
  run('scripts/check-lv01-design.mjs', '--version', '1');
  run('scripts/check-lv01-power-qualification.mjs');
  const topology = receipt('reports/research/lv01-topology-qualification.v1.json');
  const report = {
    schemaVersion: 1,
    studyId: 'LV01',
    designVersion: 1,
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
    claimBoundary: 'Current source checks only, v1 design checks only; v2 readiness is not surfaced here. No stage registration, topology qualification, collection, or scientific result is implied.',
  };
  console.log(JSON.stringify(report, null, 2));
}

function requireDesign(chainVersion) {
  run('scripts/check-lv01-design.mjs', '--version', String(designVersion(chainVersion)));
  run('scripts/check-lv01-power-qualification.mjs', '--design-version', String(designVersion(chainVersion)));
}

function requireTopology(stage, version) {
  const topologyPath = `reports/research/lv01-topology-qualification.v${version}.json`;
  const topology = receipt(topologyPath);
  if (topology?.passed !== true) fail(`${stage} v${version} is blocked: missing passed topology qualification ${topologyPath}`);
}

function requireAllocation(stage, version) {
  const allocation = `protocols/lv01-${stage}-resource-allocation.v${version}.json`;
  if (!existsSync(resolve(root, allocation))) fail(`${stage} v${version} is blocked: missing resource allocation ${allocation}`);
  return allocation;
}

/** Compile needs design, qualifications, and allocation — never its own outputs. */
function requireCompileGate(stage, version) {
  requireDesign(version);
  requireTopology(stage, version);
  requireAllocation(stage, version);
  if (stage === 'confirmatory' || stage === 'replication') {
    const lock = `reports/research/lv01-design-lock.v${version}.json`;
    if (!existsSync(resolve(root, lock))) fail(`${stage} v${version} is blocked: main stages require a locked design receipt ${lock}`);
  }
}

function requirePacket(stage, version) {
  requireCompileGate(stage, version);
  const registration = `protocols/lv01-${stage}-registration.v${version}.json`;
  if (!existsSync(resolve(root, registration))) fail(`${stage} v${version} is blocked: missing prospective registration ${registration}`);
}

function requireBinding(stage, version) {
  requirePacket(stage, version);
  const binding = `protocols/lv01-${stage}-registration-binding.v${version}.json`;
  if (!existsSync(resolve(root, binding))) fail(`${stage} v${version} is blocked: missing prospective binding ${binding}`);
}

function requireAdmission(stage, version) {
  requireBinding(stage, version);
  const gate = `reports/research/lv01-${stage}-gate-receipt.v${version}.json`;
  if (receipt(gate)?.status !== 'ready') fail(`${stage} v${version} is blocked: missing admitted ready receipt ${gate}`);
}

function requireCollection(stage, version, evidenceDir) {
  const journal = `${evidenceDir}/lv01/${stage}-v${version}/journal.jsonl`;
  if (!existsSync(resolve(root, journal))) fail(`${stage} v${version} is blocked: missing collection journal ${journal}`);
}

const command = process.argv[2];
if (!command) fail('usage: node scripts/lv01.mjs <command> [strict options]');

switch (command) {
  case 'check-design': {
    const options = parse(command, new Map([['--version', true]]));
    run('scripts/check-lv01-design.mjs', '--version', options.get('--version'));
    break;
  }
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
    run('scripts/check-lv01-development-allocation.mjs', '--version', String(version));
    fail(`development v${version} allocation is immutable at ${allocation}; no overwrite is permitted`);
    break;
  }
  case 'qualify-topology': {
    const { stage, version } = stageArguments(command);
    if (stage !== 'development') fail('topology qualification is development-only');
    const allocation = `protocols/lv01-development-resource-allocation.v${version}.json`;
    if (!existsSync(resolve(root, allocation))) fail(`development v${version} topology qualification is blocked: allocation packet is absent`);
    run('scripts/check-lv01-development-allocation.mjs', '--version', String(version));
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
  case 'compile': {
    const { stage, version } = stageArguments(command);
    requireCompileGate(stage, version);
    run('scripts/compile-lv01-stage.mjs', '--stage', stage, '--version', String(version), '--write');
    break;
  }
  case 'bind': {
    const { stage, version } = stageArguments(command);
    requirePacket(stage, version);
    run('scripts/bind-lv01-stage.mjs', '--stage', stage, '--version', String(version), '--write');
    break;
  }
  case 'admit': {
    const options = parse(command, new Map([['--stage', true], ['--version', true], ['--live-evidence', false]]));
    const stage = options.get('--stage');
    const version = Number(options.get('--version'));
    if (!stages.has(stage) || !Number.isInteger(version) || version < 1) fail('invalid stage or version');
    requireBinding(stage, version);
    run('scripts/admit-lv01-stage.mjs', '--stage', stage, '--version', String(version), '--live-evidence');
    break;
  }
  case 'audit': {
    const options = parse(command, new Map([['--stage', true], ['--version', true], ['--live-evidence', false], ['--parent-bundle', true], ['--evidence-dir', true]]));
    const stage = options.get('--stage');
    const version = Number(options.get('--version'));
    if (!stages.has(stage) || !Number.isInteger(version) || version < 1) fail('invalid stage or version');
    requireBinding(stage, version);
    requireCollection(stage, version, options.get('--evidence-dir'));
    run('scripts/audit-lv01-stage.mjs', '--stage', stage, '--version', String(version), '--live-evidence', '--parent-bundle', options.get('--parent-bundle'), '--evidence-dir', options.get('--evidence-dir'));
    break;
  }
  case 'collect': {
    const options = parse(command, new Map([['--stage', true], ['--version', true], ['--run', false], ['--parent-bundle', true], ['--evidence-dir', true], ['--partition', true], ['--ordinary-id', true], ['--store-root', true], ['--database-path', true], ['--owner', true]]));
    const stage = options.get('--stage');
    const version = Number(options.get('--version'));
    if (!stages.has(stage) || !Number.isInteger(version) || version < 1) fail('invalid stage or version');
    if (!partitions.has(options.get('--partition'))) fail(`unsupported partition ${options.get('--partition')}`);
    requireAdmission(stage, version);
    run('scripts/collect-lv01-stage.mjs', '--stage', stage, '--version', String(version), '--run', '--parent-bundle', options.get('--parent-bundle'), '--evidence-dir', options.get('--evidence-dir'), '--partition', options.get('--partition'), '--ordinary-id', options.get('--ordinary-id'), '--store-root', options.get('--store-root'), '--database-path', options.get('--database-path'), '--owner', options.get('--owner'));
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
