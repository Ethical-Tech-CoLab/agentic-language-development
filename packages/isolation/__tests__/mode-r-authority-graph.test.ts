import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Process = { zone: string; networks: string[]; keyDomains: string[]; writableState: string[] };
type Call = { from: string; to: string; transport: string; purpose: string };
type Graph = {
  schemaVersion: number;
  status: string;
  b12Closed: boolean;
  processes: Record<string, Process>;
  calls: Call[];
  gate: { selectedImplementationQualified: boolean; mustVerify: string[] };
};

const graph = JSON.parse(readFileSync('protocols/mode-r-authority-graph.v1.json', 'utf8')) as Graph;

type WriterCapability = {
  caller: string;
  endpoint: string;
  mountOnlyIn: string[];
  methods: string[];
};
type Amendment = {
  schemaVersion: number;
  status: string;
  b12Closed: boolean;
  baseGraph: { path: string; sha256: string };
  callUpdates: Array<{ from: string; to: string; capability?: string }>;
  callAdditions: Array<{ from: string; to: string; capability?: string }>;
  addedProcesses: Record<string, Process>;
  writerCapabilities: Record<string, WriterCapability>;
  endpointPolicy: { singleWriterProcess: boolean; sqliteMountOnlyIn: string[] };
};
const amendment = JSON.parse(
  readFileSync('protocols/mode-r-authority-graph.v2.json', 'utf8'),
) as Amendment;

type GatewayServiceAmendment = {
  schemaVersion: number;
  status: string;
  b12Closed: boolean;
  predecessors: Array<{ path: string; sha256: string }>;
  gatewayService: {
    caller: string;
    server: string;
    endpoint: string;
    mountOnlyIn: string[];
    methods: string[];
    describeResult: string[];
    replyStatus: string[];
    clientRules: string[];
  };
  authorityRules: string[];
  qualificationRequired: string[];
};
const gatewayServiceAmendment = JSON.parse(
  readFileSync('protocols/mode-r-authority-graph.v3.json', 'utf8'),
) as GatewayServiceAmendment;

type GatewayRecoveryAmendment = {
  schemaVersion: number;
  status: string;
  b12Closed: boolean;
  predecessor: { path: string; sha256: string };
  gatewayServiceDelta: {
    protocol: string;
    removeMethods: string[];
    addMethods: string[];
    restoreRequest: Record<string, string[]>;
    restoreRules: string[];
  };
  qualificationRequired: string[];
};
const gatewayRecoveryAmendment = JSON.parse(
  readFileSync('protocols/mode-r-authority-graph.v4.json', 'utf8'),
) as GatewayRecoveryAmendment;

type GatewayBabyRelayAmendment = {
  schemaVersion: number;
  status: string;
  researchFinding: boolean;
  b12Closed: boolean;
  predecessor: { path: string; sha256: string };
  controllerGatewayBabyRelays: Record<string, {
    controllerEndpoint: string;
    mountOnlyIn: string[];
    gatewayDestination: string;
    destinationNetwork: string;
    runRoleBinding: string;
  }>;
  forwardMethods: string[];
  reverseMethodPolicy: Record<string, {
    forwardToController: boolean;
    handledBy: string;
    writerCapability: string;
  }>;
  authorityRules: string[];
  qualificationRequired: string[];
};
const gatewayBabyRelayAmendment = JSON.parse(
  readFileSync('protocols/mode-r-authority-graph.v5.json', 'utf8'),
) as GatewayBabyRelayAmendment;

type WitnessSigningAmendment = {
  schemaVersion: number;
  status: string;
  researchFinding: boolean;
  b12Closed: boolean;
  predecessor: { path: string; sha256: string };
  witnessSigner: {
    keyOwner: string;
    endpoint: string;
    mountOnlyIn: string[];
    method: string;
    input: string;
    runBinding: string;
    domainBinding: string;
    authorizedCallers: Record<string, string>;
  };
  authorityRules: string[];
  qualificationRequired: string[];
};
const witnessSigningAmendment = JSON.parse(
  readFileSync('protocols/mode-r-authority-graph.v6.json', 'utf8'),
) as WitnessSigningAmendment;

type BoundaryQualification = {
  schemaVersion: number;
  status: string;
  b12Closed: boolean;
  externalSpendingUsd: number;
  authoritySources: Array<{ path: string; sha256: string }>;
  executionImage: { reference: string; localImageId: string; networkPullPermitted: boolean };
  scope: { included: string[]; excluded: string[] };
  mountPolicy: Record<string, string[]>;
  keyDomainPolicy: Record<string, string>;
  acceptance: Record<string, number>;
};
const boundaryQualification = JSON.parse(
  readFileSync('protocols/mode-r-boundary-qualification.v1.json', 'utf8'),
) as BoundaryQualification;

type BabyModelBoundaryQualification = {
  schemaVersion: number;
  status: string;
  researchFinding: boolean;
  b12Closed: boolean;
  authorityBindings: Array<{ path: string; sha256: string }>;
  requiredChecks: string[];
  exclusions: string[];
};
const babyModelBoundaryQualification = JSON.parse(
  readFileSync(
    'protocols/mode-r-baby-model-boundary-qualification.v1.json',
    'utf8',
  ),
) as BabyModelBoundaryQualification;

describe('prospective Mode R authority graph', () => {
  it('prospectively authorizes both required witness-domain hash callers', () => {
    expect(witnessSigningAmendment.schemaVersion).toBe(6);
    expect(witnessSigningAmendment.status).toBe('design-locked-not-implemented');
    expect(witnessSigningAmendment.researchFinding).toBe(false);
    expect(witnessSigningAmendment.b12Closed).toBe(false);
    expect(witnessSigningAmendment.predecessor.path)
      .toBe('protocols/mode-r-authority-graph.v5.json');
    expect(createHash('sha256')
      .update(readFileSync(witnessSigningAmendment.predecessor.path))
      .digest('hex')).toBe(witnessSigningAmendment.predecessor.sha256);
    expect(witnessSigningAmendment.witnessSigner).toMatchObject({
      keyOwner: 'witness-signer',
      endpoint: '/run/ald-mode-r/signer-witness/signer.sock',
      mountOnlyIn: ['witness-signer', 'evidence-writer', 'checkpoint'],
      method: 'sign',
      input: 'sha256-hash-only',
      runBinding: 'registered-run-id',
      domainBinding: 'witness',
      authorizedCallers: {
        'evidence-writer': 'canonical-turn-record-entry-hash',
        checkpoint: 'canonical-checkpoint-manifest-hash',
      },
    });
    expect(witnessSigningAmendment.authorityRules).toContain(
      'witness-private-key-remains-only-in-witness-signer',
    );
    expect(witnessSigningAmendment.qualificationRequired).toContain(
      'witness-signer-death-prevents-later-turn-and-checkpoint-commit',
    );
  });

  it('freezes Gateway-hosted role-specific Baby relays before selected Compose', () => {
    expect(gatewayBabyRelayAmendment.schemaVersion).toBe(5);
    expect(gatewayBabyRelayAmendment.status).toBe('design-locked-not-implemented');
    expect(gatewayBabyRelayAmendment.researchFinding).toBe(false);
    expect(gatewayBabyRelayAmendment.b12Closed).toBe(false);
    expect(gatewayBabyRelayAmendment.predecessor.path)
      .toBe('protocols/mode-r-authority-graph.v4.json');
    expect(createHash('sha256')
      .update(readFileSync(gatewayBabyRelayAmendment.predecessor.path))
      .digest('hex')).toBe(gatewayBabyRelayAmendment.predecessor.sha256);
    const relays = gatewayBabyRelayAmendment.controllerGatewayBabyRelays;
    expect(Object.keys(relays).sort()).toEqual(['baby-a', 'baby-b']);
    for (const role of ['baby-a', 'baby-b']) {
      expect(relays[role]?.mountOnlyIn).toEqual(['controller-scenario', 'gateway']);
      expect(relays[role]?.runRoleBinding).toBe(role);
      expect(relays[role]?.destinationNetwork).toBe(`${role}-gateway`);
      expect(relays[role]?.gatewayDestination).toBe(`${role}:4318`);
    }
    expect(gatewayBabyRelayAmendment.forwardMethods).toContain('act');
    expect(gatewayBabyRelayAmendment.forwardMethods).toContain('describe_isolation');
    expect(gatewayBabyRelayAmendment.reverseMethodPolicy.ledger_append)
      .toEqual(expect.objectContaining({
        forwardToController: false,
        handledBy: 'gateway',
        writerCapability: 'gateway-writer.appendLedgerEvent',
      }));
    expect(gatewayBabyRelayAmendment.authorityRules).toContain(
      'controller-connects-to-role-specific-gateway-relay-sockets-not-baby-networks',
    );
    expect(gatewayBabyRelayAmendment.qualificationRequired).toContain(
      'controller-to-baby-direct-route-denial',
    );
  });

  it('freezes the Baby/model process qualification without closing B12', () => {
    expect(babyModelBoundaryQualification.schemaVersion).toBe(1);
    expect(babyModelBoundaryQualification.status).toBe('design-locked-not-executed');
    expect(babyModelBoundaryQualification.researchFinding).toBe(false);
    expect(babyModelBoundaryQualification.b12Closed).toBe(false);
    for (const source of babyModelBoundaryQualification.authorityBindings) {
      expect(createHash('sha256').update(readFileSync(source.path)).digest('hex'))
        .toBe(source.sha256);
    }
    expect(babyModelBoundaryQualification.requiredChecks).toContain(
      'the outer Baby is the sole normalized turn-deadline authority',
    );
    expect(babyModelBoundaryQualification.exclusions).toContain(
      'selected container topology',
    );
    expect(babyModelBoundaryQualification.exclusions).toContain(
      'scientific or behavioral findings',
    );
    const collector = readFileSync(
      'scripts/run-mode-r-baby-model-qualification.mjs',
      'utf8',
    );
    expect(collector).toContain("git('status', '--porcelain')");
    expect(collector).toContain("existsSync(evidenceRoot), false");
    expect(collector).toContain("timing: 'normalized'");
    expect(collector).toContain("deadlineMs: 1_000");
    expect(collector).toContain('liveAfterDispose');
    expect(collector).toContain('researchFinding: false');
    expect(collector).toContain('b12Closed: false');
  });

  it('prospectively freezes a bounded zero-spend container qualification', () => {
    expect(boundaryQualification.schemaVersion).toBe(1);
    expect(boundaryQualification.status).toBe('design-locked-not-executed');
    expect(boundaryQualification.b12Closed).toBe(false);
    expect(boundaryQualification.externalSpendingUsd).toBe(0);
    for (const source of boundaryQualification.authoritySources) {
      expect(createHash('sha256').update(readFileSync(source.path)).digest('hex'))
        .toBe(source.sha256);
    }
    expect(boundaryQualification.executionImage).toEqual({
      reference: 'node:24.20.0-alpine',
      localImageId: 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf',
      networkPullPermitted: false,
    });
    expect(boundaryQualification.scope.excluded).toContain('b12-closure');
    expect(boundaryQualification.scope.excluded)
      .toContain('application-service-execution');
    expect(boundaryQualification.mountPolicy['sqlite-event-store'])
      .toEqual(['evidence-writer']);
    expect(boundaryQualification.mountPolicy['gateway-controller'])
      .toEqual(['controller-scenario', 'gateway']);
    expect(Object.keys(boundaryQualification.keyDomainPolicy)).toHaveLength(6);
    expect(boundaryQualification.acceptance).toMatchObject({
      processCount: 17,
      networkMismatchCount: 0,
      mountMismatchCount: 0,
      keyDomainMismatchCount: 0,
    });
  });

  it('keeps the boundary collector single-use, exhaustive, and scoped', () => {
    const collector = readFileSync(
      'scripts/run-mode-r-boundary-qualification.mjs',
      'utf8',
    );
    expect(collector).toContain("git('status', '--porcelain')");
    expect(collector).toContain("assert.equal(existsSync(evidenceRoot), false");
    expect(collector).toContain('for (const from of processNames)');
    expect(collector).toContain('for (const to of processNames)');
    expect(collector).toContain("'--network', 'none'");
    expect(collector).toContain("spawnSync('docker', ['rm', '-f', container]");
    expect(collector).toContain('ALD_PROCESS_NAME=');
    expect(collector).toContain("marker:'ald-mode-r-probe-v1'");
    expect(collector).toContain('result.error !== undefined');
    expect(collector).toContain('incompleteProbeCount');
    expect(collector).toContain('wrongResponderCount');
    expect(collector).toContain('notRunningProcessCount');
    expect(collector).toContain('researchFinding: false');
    expect(collector).toContain('b12Closed: false');
  });

  it('prospectively binds fail-closed Gateway recovery to unchanged v3', () => {
    expect(gatewayRecoveryAmendment.schemaVersion).toBe(4);
    expect(gatewayRecoveryAmendment.status).toBe('design-locked-not-implemented');
    expect(gatewayRecoveryAmendment.b12Closed).toBe(false);
    expect(gatewayRecoveryAmendment.predecessor.path)
      .toBe('protocols/mode-r-authority-graph.v3.json');
    expect(createHash('sha256')
      .update(readFileSync(gatewayRecoveryAmendment.predecessor.path))
      .digest('hex')).toBe(gatewayRecoveryAmendment.predecessor.sha256);

    const delta = gatewayRecoveryAmendment.gatewayServiceDelta;
    expect(delta.protocol).toBe('symbol-gateway-v2');
    expect(delta.removeMethods).toEqual(['discardShuffledBatchAfterRecovery']);
    expect(delta.addMethods).toEqual(['restoreAfterVerifiedPrefix']);
    expect(delta.restoreRequest).toEqual({
      verifiedChannelHead: ['size', 'lastEntryHash'],
      operationalState: ['consecutiveRejections'],
    });
    expect(delta.restoreRules).toContain(
      'missing-or-malformed-latest-resume-channel-head-refuses-recovery',
    );
    expect(gatewayRecoveryAmendment.qualificationRequired).toContain(
      'fresh-remote-gateway-restart-preserves-rejection-streak',
    );
  });

  it('binds the prospective Gateway service to unchanged v1 and v2 graphs', () => {
    expect(gatewayServiceAmendment.schemaVersion).toBe(3);
    expect(gatewayServiceAmendment.status).toBe('design-locked-not-implemented');
    expect(gatewayServiceAmendment.b12Closed).toBe(false);
    expect(gatewayServiceAmendment.predecessors.map(({ path }) => path)).toEqual([
      'protocols/mode-r-authority-graph.v1.json',
      'protocols/mode-r-authority-graph.v2.json',
    ]);
    for (const predecessor of gatewayServiceAmendment.predecessors) {
      expect(createHash('sha256').update(readFileSync(predecessor.path))
        .digest('hex')).toBe(predecessor.sha256);
    }
  });

  it('freezes one fail-closed Controller-to-Gateway service capability', () => {
    const service = gatewayServiceAmendment.gatewayService;
    expect(service.caller).toBe('controller-scenario');
    expect(service.server).toBe('gateway');
    expect(service.mountOnlyIn).toEqual(['controller-scenario', 'gateway']);
    expect(service.endpoint).toBe('/run/ald-mode-r/gateway-controller/gateway.sock');
    expect(service.methods).toEqual([
      'describe', 'submitProposal', 'beginShuffledBatch',
      'preflightShuffledProposal', 'sealShuffledBatch',
      'submitPreparedShuffledProposal', 'discardShuffledBatchAfterRecovery',
      'rejectForTimeout', 'submitControlArtifact', 'submitInterpretation',
      'submitReceiverTaskAction', 'appendLifecycleLedgerEvent', 'submitAffect',
      'recordDerivedAffect', 'resetRejectionCounter',
    ]);
    expect(service.describeResult).toContain('configurationHash');
    expect(service.replyStatus).toEqual([
      'consecutiveRejections', 'evidenceWriteQuarantined',
    ]);
    expect(service.clientRules).toContain('never-retry-an-unconfirmed-mutating-call');
    expect(service.clientRules).toContain('set-evidence-write-quarantined-on-unconfirmed-call');
    expect(gatewayServiceAmendment.authorityRules)
      .toContain('controller-cannot-call-gateway-writer-capability');
    expect(gatewayServiceAmendment.qualificationRequired)
      .toContain('complete-selected-lifecycle-and-independent-bundle-audit');
  });

  it('binds the v2 capability amendment to unchanged v1 and one writer owner', () => {
    expect(amendment.schemaVersion).toBe(2);
    expect(amendment.status).toBe('design-locked-not-implemented');
    expect(amendment.b12Closed).toBe(false);
    expect(amendment.baseGraph.path).toBe('protocols/mode-r-authority-graph.v1.json');
    expect(createHash('sha256').update(readFileSync(amendment.baseGraph.path))
      .digest('hex')).toBe(amendment.baseGraph.sha256);
    expect(amendment.endpointPolicy.singleWriterProcess).toBe(true);
    expect(amendment.endpointPolicy.sqliteMountOnlyIn).toEqual(['evidence-writer']);
    expect(Object.keys(amendment.addedProcesses)).toEqual(['audit-interpreter']);
    expect(amendment.addedProcesses['audit-interpreter']!.keyDomains).toEqual([]);
    expect(amendment.addedProcesses['audit-interpreter']!.writableState).toEqual([]);
    for (const update of amendment.callUpdates) {
      expect(graph.calls.filter((call) => call.from === update.from && call.to === update.to))
        .toHaveLength(1);
      if (update.capability !== undefined) {
        expect(amendment.writerCapabilities[update.capability]?.caller).toBe(update.from);
      }
    }
    for (const addition of amendment.callAdditions) {
      expect(graph.calls.some((call) => call.from === addition.from &&
        call.to === addition.to)).toBe(false);
      expect({ ...graph.processes, ...amendment.addedProcesses }[addition.from]).toBeDefined();
      expect({ ...graph.processes, ...amendment.addedProcesses }[addition.to]).toBeDefined();
      if (addition.capability !== undefined) {
        expect(amendment.writerCapabilities[addition.capability]?.caller).toBe(addition.from);
      }
    }
  });

  it('separates writer method sets and mounts by exact caller', () => {
    const capabilities = amendment.writerCapabilities;
    const expected: Record<string, string[]> = {
      'gateway-writer': [
        'commitTurn', 'commitRejection', 'commitControlArtifact',
        'appendLedgerEvent', 'appendInterventionEvent', 'appendAffectEvent',
      ],
      'controller-writer': [
        'registerRun', 'readRunMetadata', 'chainHead', 'readEvents',
        'readCheckpoints', 'readAnchorReceipts', 'readExperimentRecords',
        'readAnalysisAttachments', 'readRunSigners', 'readForkArtifacts',
        'appendTurnRecord', 'appendInterventionEvent',
        'appendAnalysisAttachment', 'appendExperimentRecord', 'recover',
      ],
      'checkpoint-writer': [
        'readRunMetadata', 'readCheckpoints', 'readEvents',
        'insertCheckpointManifest',
      ],
      'anchor-writer': [
        'listRuns', 'readCheckpoints', 'readAnchorReceipts',
        'insertAnchorReceipt',
      ],
      'audit-writer': ['readEvents', 'appendAuditLedgerEntry'],
    };
    expect(Object.keys(capabilities).sort()).toEqual(Object.keys(expected).sort());
    const endpoints = new Set<string>();
    for (const [name, methods] of Object.entries(expected)) {
      const capability = capabilities[name]!;
      expect(capability.methods).toEqual(methods);
      expect(capability.mountOnlyIn).toEqual([capability.caller, 'evidence-writer']);
      expect(capability.endpoint.startsWith('/run/ald-mode-r/')).toBe(true);
      expect(endpoints.has(capability.endpoint)).toBe(false);
      endpoints.add(capability.endpoint);
    }
    expect(capabilities['controller-writer']!.methods).not.toContain('appendLedgerEvent');
    expect(capabilities['controller-writer']!.methods).not.toContain('commitTurn');
    expect(capabilities['checkpoint-writer']!.methods).not.toContain('appendTurnRecord');
    expect(capabilities['anchor-writer']!.methods).not.toContain('appendTurnRecord');
    expect(capabilities['controller-writer']!.methods).not.toContain('appendAuditLedgerEntry');
  });

  it('makes the Gateway the only Baby network peer', () => {
    expect(graph.schemaVersion).toBe(1);
    expect(graph.status).toBe('design-locked-not-implemented');
    expect(graph.b12Closed).toBe(false);
    expect(graph.gate.selectedImplementationQualified).toBe(false);
    for (const role of ['a', 'b'] as const) {
      const baby = graph.processes[`baby-${role}`]!;
      const peer = graph.processes[`baby-${role === 'a' ? 'b' : 'a'}`]!;
      expect(baby.networks).toEqual([`baby-${role}-gateway`]);
      expect(peer.networks).not.toContain(baby.networks[0]);
      expect(Object.entries(graph.processes)
        .filter(([, process]) => process.networks.includes(baby.networks[0]!))
        .map(([name]) => name).sort()).toEqual([`baby-${role}`, 'gateway']);
      expect(baby.keyDomains).toEqual([]);
      expect(baby.writableState).toEqual([`baby-${role}-private`]);
      expect(graph.calls.filter((call) => call.from === `baby-${role}` &&
        call.transport.includes('network')).map((call) => call.to)).toEqual(['gateway']);
    }
  });

  it('assigns each signer one exclusive key domain and one caller', () => {
    const signers = Object.entries(graph.processes)
      .filter(([, process]) => process.keyDomains.length > 0);
    expect(signers).toHaveLength(6);
    expect(new Set(signers.flatMap(([, process]) => process.keyDomains)).size).toBe(6);
    for (const [name, process] of signers) {
      expect(process.networks).toEqual([]);
      expect(process.keyDomains).toHaveLength(1);
      expect(process.writableState).toEqual([]);
      const callers = graph.calls.filter((call) => call.to === name);
      expect(callers).toHaveLength(1);
      expect(callers[0]!.from).toBe(name === 'witness-signer'
        ? 'checkpoint' : 'evidence-writer');
      expect(callers[0]!.transport).toBe('private-unix-socket');
    }
  });

  it('keeps the event store single-owner and all calls within declared processes', () => {
    expect(Object.entries(graph.processes)
      .filter(([, process]) => process.writableState.includes('sqlite-event-store'))
      .map(([name]) => name)).toEqual(['evidence-writer']);
    expect(graph.processes['controller-scenario']!.networks).toEqual(['control-plane']);
    expect(graph.processes['gateway']!.writableState).toEqual([]);
    expect(graph.processes['offline-verifier']!.networks).toEqual([]);
    for (const call of graph.calls) {
      expect(graph.processes[call.from], `${call.from}: undeclared caller`).toBeDefined();
      expect(graph.processes[call.to], `${call.to}: undeclared destination`).toBeDefined();
      expect(call.from).not.toBe(call.to);
      expect(call.purpose.length).toBeGreaterThan(0);
    }
    expect(graph.calls.some((call) => call.from === 'baby-a' && call.to === 'baby-b')).toBe(false);
    expect(graph.calls.some((call) => call.from === 'baby-b' && call.to === 'baby-a')).toBe(false);
  });

  it('keeps the present adapter-host reference outside the selected gate', () => {
    const compose = readFileSync('deploy/mode-r/docker-compose.yml', 'utf8');
    expect(compose).toContain('nursery-study:');
    expect(compose).not.toMatch(/^  gateway:/mu);
    expect(compose).not.toMatch(/^  evidence-writer:/mu);
    expect(graph.gate.mustVerify).toContain('gateway-only-baby-network-routes');
    expect(graph.gate.mustVerify).toContain('complete-lifecycle-and-independent-bundle-audit');
  });

  it('keeps shuffled proposal validation inside the Gateway implementation', () => {
    const controller = readFileSync('packages/orchestrator/src/nursery-runtime.ts', 'utf8');
    expect(controller).toContain('preflightShuffledProposal(');
    expect(controller).toContain('submitPreparedShuffledProposal(');
    expect(controller).toContain('submitReceiverTaskAction(');
    expect(controller).toContain('appendLifecycleLedgerEvent(');
    expect(controller).not.toContain('run.writer.appendLedgerEvent(');
    expect(controller).not.toContain('run.writer.appendInterventionEvent(');
    expect(controller).not.toContain('run.writer.appendTurnRecord(');
    expect(controller).not.toContain('run.writer.appendAnalysisAttachment(');
    expect(controller).not.toContain('run.writer.appendExperimentRecord(');
    expect(controller).not.toContain('run.writer.recover(');
    expect(controller).not.toContain('writer.registerRun(runConfig)');
    expect(controller).toContain('run.controllerEvidence.appendInterventionEvent(');
    expect(controller).toContain('await controllerEvidence.registerRun(runConfig)');
    const receiverPath = controller.split('async #runReceiver(')[1]?.split('  #episodeIndex(')[0];
    expect(receiverPath).toBeDefined();
    expect(receiverPath).not.toContain('run.writer.appendLedgerEvent(');
    expect(controller).toContain('gateway: SymbolGateway;');
    expect(controller).not.toContain('gateway: SymbolGatewayImpl;');
    expect(controller).not.toContain('.carrierProtocol.validate(');
    expect(controller).not.toContain('.carrierContext');
    expect(controller).not.toContain('batchArtifacts');
  });
});
