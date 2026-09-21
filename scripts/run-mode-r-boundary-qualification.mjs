import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const modes = new Set([
  '--run-development', '--audit-development', '--run', '--audit',
]);
const mode = process.argv[2];
assert.ok(modes.has(mode), 'expected --run-development, --audit-development, --run, or --audit');
const development = mode.endsWith('development');
const runMode = mode.startsWith('--run');
const evidenceRoot = development
  ? 'evidence/mode-r-boundary-qualification-v1-development-attempt-3'
  : 'evidence/mode-r-boundary-qualification-v1';
const receiptPath = join(evidenceRoot, 'receipt.json');
const protocolPath = 'protocols/mode-r-boundary-qualification.v1.json';
const graphV1Path = 'protocols/mode-r-authority-graph.v1.json';
const graphV2Path = 'protocols/mode-r-authority-graph.v2.json';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256')
  .update(readFileSync(path)).digest('hex')}`;
const command = (program, args, options = {}) => execFileSync(program, args, {
  encoding: 'utf8', timeout: 30_000, ...options,
}).trim();
const git = (...args) => command('git', args);
const protocol = read(protocolPath);
const graphV1 = read(graphV1Path);
const graphV2 = read(graphV2Path);
const processes = {
  ...graphV1.processes,
  ...graphV2.addedProcesses,
};
const processNames = Object.keys(processes).sort();
const networkNames = [...new Set(
  Object.values(processes).flatMap((process) => process.networks),
)].sort();
const expectedMounts = Object.fromEntries(processNames.map((name) => [
  name,
  Object.entries(protocol.mountPolicy)
    .filter(([, owners]) => owners.includes(name))
    .map(([mount]) => mount)
    .sort(),
]));
const expectedKeyDomain = (name) => protocol.keyDomainPolicy[name] ?? null;
const serverSource = [
  "const net=require('node:net')",
  "net.createServer(s=>{s.on('error',()=>{});s.end(process.env.ALD_PROCESS_NAME)}).listen(4318,'0.0.0.0')",
  'setInterval(()=>{},1<<30)',
].join(';');
const probeBatchSource = [
  "const net=require('node:net')",
  'const targets=JSON.parse(process.argv[1])',
  "const probe=target=>new Promise(resolve=>{let socket,timer,response='',done=false",
  "const finish=(outcome,responder=null)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve({target,outcome,responder})}",
  "socket=net.createConnection({host:target,port:4318})",
  "socket.setEncoding('utf8')",
  "timer=setTimeout(()=>finish('denied'),750)",
  "socket.on('data',chunk=>{response+=chunk})",
  "socket.on('end',()=>finish(response===target?'reachable':'wrong-responder',response||null))",
  "socket.on('error',()=>finish('denied'))})",
  "Promise.all(targets.map(probe)).then(results=>process.stdout.write(JSON.stringify({marker:'ald-mode-r-probe-v1',results})))",
].join(';');

function inspect(name) {
  return JSON.parse(command('docker', ['inspect', name]))[0];
}

function probeBatch(container, targets) {
  const result = spawnSync('docker', [
    'exec', container, 'node', '-e', probeBatchSource, JSON.stringify(targets),
  ], { encoding: 'utf8', timeout: 30_000 });
  const incomplete = (reason) => targets.map((target) => ({
    target, outcome: 'incomplete', responder: null, reason,
  }));
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    return incomplete(result.error?.code ?? result.signal ?? `exit-${String(result.status)}`);
  }
  try {
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.marker, 'ald-mode-r-probe-v1');
    assert.deepEqual(payload.results.map((entry) => entry.target), targets);
    for (const entry of payload.results) {
      assert.ok(['reachable', 'denied', 'wrong-responder'].includes(entry.outcome));
    }
    return payload.results;
  } catch (error) {
    return incomplete(`invalid-output:${error instanceof Error ? error.message : String(error)}`);
  }
}

function audit(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, development
    ? 'development-only-container-boundary-qualification'
    : 'selected-container-boundary-qualification');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.externalSpendingUsd, 0);
  assert.equal(receipt.protocolSha256, sha256(protocolPath));
  assert.equal(receipt.executionCommit.length, 40);
  assert.equal(receipt.image.id, protocol.executionImage.localImageId);
  assert.deepEqual(receipt.processNames, processNames);
  assert.deepEqual(receipt.networkNames, networkNames);
  assert.equal(receipt.observations.processes.length, protocol.acceptance.processCount);
  assert.equal(receipt.observations.routes.length, processNames.length * (processNames.length - 1));
  assert.equal(receipt.summary.networkMismatchCount, 0);
  assert.equal(receipt.summary.mountMismatchCount, 0);
  assert.equal(receipt.summary.keyDomainMismatchCount, 0);
  assert.equal(receipt.summary.notRunningProcessCount, 0);
  assert.equal(receipt.summary.incompleteProbeCount, 0);
  assert.equal(receipt.summary.wrongResponderCount, 0);
  assert.equal(receipt.summary.duplicateContainerIdCount, 0);
  assert.equal(receipt.summary.duplicateHostPidCount, 0);
  assert.equal(receipt.summary.unexpectedExternalNetworkCount, 0);
  assert.equal(receipt.passed, true);
  for (const observation of receipt.observations.processes) {
    assert.deepEqual(observation.declaredNetworks, processes[observation.name].networks);
    assert.deepEqual(observation.qualificationMounts, expectedMounts[observation.name]);
    assert.equal(observation.keyDomain, expectedKeyDomain(observation.name));
    assert.equal(observation.running, true);
  }
  for (const route of receipt.observations.routes) {
    const shared = processes[route.from].networks.some((network) =>
      processes[route.to].networks.includes(network));
    assert.equal(route.expectedReachable, shared);
    assert.equal(route.observedReachable, shared);
    assert.equal(route.probeCompleted, true);
    assert.equal(route.probeOutcome, shared ? 'reachable' : 'denied');
    assert.equal(route.responderIdentity, shared ? route.to : null);
  }
  return receipt;
}

if (!runMode) {
  assert.ok(existsSync(receiptPath), `missing receipt: ${receiptPath}`);
  audit(read(receiptPath));
  console.log(`${development ? 'development' : 'selected'} Mode R boundary receipt valid; bounded topology evidence only`);
  process.exit(0);
}

assert.equal(git('status', '--porcelain'), '', 'boundary collection requires a clean source commit');
assert.equal(existsSync(evidenceRoot), false, 'boundary evidence is single-use');
assert.equal(protocol.status, 'design-locked-not-executed');
assert.equal(protocol.researchFinding, false);
assert.equal(protocol.b12Closed, false);
assert.equal(protocol.externalSpendingUsd, 0);
assert.equal(processNames.length, protocol.acceptance.processCount);
assert.equal(command('docker', ['image', 'inspect', protocol.executionImage.reference,
  '--format', '{{.Id}}']), protocol.executionImage.localImageId);

const suffix = randomBytes(5).toString('hex');
const prefix = `ald-mr-boundary-${development ? 'dev' : 'run'}-${suffix}`;
const workspace = resolve(evidenceRoot, 'workspace');
const containers = [];
const networks = [];
let receipt;
let failure = null;
const executionCommit = git('rev-parse', 'HEAD');
mkdirSync(workspace, { recursive: true, mode: 0o700 });
for (const mount of Object.keys(protocol.mountPolicy)) {
  mkdirSync(join(workspace, mount), { mode: 0o700 });
}

try {
  for (const network of networkNames) {
    const dockerName = `${prefix}-${network}`;
    command('docker', ['network', 'create', '--internal', '--label',
      `ald.qualification=${prefix}`, dockerName]);
    networks.push(dockerName);
  }
  for (const name of processNames) {
    const container = `${prefix}-${name}`;
    const declaredNetworks = processes[name].networks;
    const args = ['run', '-d', '--name', container, '--hostname', name,
      '--label', `ald.qualification=${prefix}`, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '32',
      '--env', `ALD_PROCESS_NAME=${name}`];
    if (declaredNetworks.length === 0) {
      args.push('--network', 'none');
    } else {
      args.push('--network', `${prefix}-${declaredNetworks[0]}`);
    }
    const keyDomain = expectedKeyDomain(name);
    if (keyDomain !== null) args.push('--env', `ALD_KEY_DOMAIN=${keyDomain}`);
    for (const mount of expectedMounts[name]) {
      args.push('--mount', `type=bind,source=${join(workspace, mount)},target=/qualification/${mount}`);
    }
    args.push(protocol.executionImage.reference, 'node', '-e', serverSource);
    command('docker', args);
    containers.push(container);
    for (const network of declaredNetworks.slice(1)) {
      command('docker', ['network', 'connect', `${prefix}-${network}`, container]);
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = processNames.filter((name) => processes[name].networks.length > 0)
      .every((name) => probeBatch(`${prefix}-${name}`, [name])[0]?.outcome === 'reachable');
    if (ready) break;
    assert.notEqual(attempt, 19, 'network probe listeners did not become ready');
  }

  const processObservations = processNames.map((name) => {
    const details = inspect(`${prefix}-${name}`);
    const actualNetworks = Object.keys(details.NetworkSettings.Networks)
      .filter((network) => network !== 'none')
      .map((network) => network.replace(`${prefix}-`, '')).sort();
    const mounts = details.Mounts
      .filter((mount) => mount.Destination.startsWith('/qualification/'))
      .map((mount) => mount.Destination.slice('/qualification/'.length)).sort();
    const key = details.Config.Env.find((value) => value.startsWith('ALD_KEY_DOMAIN='));
    return {
      name,
      containerId: details.Id,
      hostPid: details.State.Pid,
      running: details.State.Running,
      declaredNetworks: processes[name].networks,
      observedNetworks: actualNetworks,
      qualificationMounts: mounts,
      keyDomain: key?.slice('ALD_KEY_DOMAIN='.length) ?? null,
    };
  });
  const routes = [];
  for (const from of processNames) {
    const targets = processNames.filter((to) => from !== to);
    const probed = new Map(probeBatch(`${prefix}-${from}`, targets)
      .map((observation) => [observation.target, observation]));
    for (const to of processNames) {
      if (from === to) continue;
      const expectedReachable = processes[from].networks.some((network) =>
        processes[to].networks.includes(network));
      const observation = probed.get(to);
      const probeCompleted = observation?.outcome !== 'incomplete';
      routes.push({
        from,
        to,
        expectedReachable,
        observedReachable: observation?.outcome === 'reachable',
        probeCompleted,
        probeOutcome: observation?.outcome ?? 'incomplete',
        responderIdentity: observation?.responder ?? null,
        incompleteReason: probeCompleted ? null : observation?.reason ?? 'missing-result',
      });
    }
  }
  const networkMismatchCount = routes.filter((route) =>
    route.expectedReachable !== route.observedReachable).length;
  const mountMismatchCount = processObservations.filter((observation) =>
    JSON.stringify(observation.qualificationMounts) !==
      JSON.stringify(expectedMounts[observation.name])).length;
  const keyDomainMismatchCount = processObservations.filter((observation) =>
    observation.keyDomain !== expectedKeyDomain(observation.name)).length;
  const notRunningProcessCount = processObservations.filter((observation) =>
    !observation.running).length;
  const incompleteProbeCount = routes.filter((route) => !route.probeCompleted).length;
  const wrongResponderCount = routes.filter((route) =>
    route.probeOutcome === 'wrong-responder').length;
  const duplicateContainerIdCount = processObservations.length -
    new Set(processObservations.map((observation) => observation.containerId)).size;
  const duplicateHostPidCount = processObservations.length -
    new Set(processObservations.map((observation) => observation.hostPid)).size;
  const unexpectedExternalNetworkCount = processObservations.filter((observation) =>
    JSON.stringify(observation.observedNetworks) !==
      JSON.stringify([...observation.declaredNetworks].sort())).length;
  const summary = {
    networkMismatchCount,
    mountMismatchCount,
    keyDomainMismatchCount,
    notRunningProcessCount,
    incompleteProbeCount,
    wrongResponderCount,
    duplicateContainerIdCount,
    duplicateHostPidCount,
    unexpectedExternalNetworkCount,
  };
  const passed = Object.values(summary).every((value) => value === 0);
  receipt = {
    schemaVersion: 1,
    classification: development
      ? 'development-only-container-boundary-qualification'
      : 'selected-container-boundary-qualification',
    researchFinding: false,
    b12Closed: false,
    externalSpendingUsd: 0,
    executionCommit,
    protocolSha256: sha256(protocolPath),
    image: {
      reference: protocol.executionImage.reference,
      id: protocol.executionImage.localImageId,
    },
    processNames,
    networkNames,
    observations: { processes: processObservations, routes },
    summary,
    passed,
    failure: passed ? null : `boundary mismatches: ${JSON.stringify(summary)}`,
    collectedAt: new Date().toISOString(),
  };
  failure = receipt.failure;
} catch (error) {
  failure = `${error instanceof Error ? error.name : 'Error'}: ${
    error instanceof Error ? error.message : String(error)}`;
} finally {
  for (const container of containers.reverse()) {
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8', timeout: 30_000 });
  }
  for (const network of networks.reverse()) {
    spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8', timeout: 30_000 });
  }
  rmSync(workspace, { recursive: true, force: true });
}

mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
receipt ??= {
  schemaVersion: 1,
  classification: development
    ? 'development-only-container-boundary-qualification'
    : 'selected-container-boundary-qualification',
  researchFinding: false,
  b12Closed: false,
  externalSpendingUsd: 0,
  executionCommit,
  protocolSha256: sha256(protocolPath),
  image: {
    reference: protocol.executionImage.reference,
    id: protocol.executionImage.localImageId,
  },
  processNames,
  networkNames,
  observations: { processes: [], routes: [] },
  summary: null,
  passed: false,
  failure,
  collectedAt: new Date().toISOString(),
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
if (failure !== null) throw new Error(failure);
audit(receipt);
console.log(`${development ? 'development' : 'selected'} Mode R boundary collection passed; bounded topology evidence only`);
