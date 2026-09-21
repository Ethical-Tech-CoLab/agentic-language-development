import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Mount = { source: string; target: string; read_only?: boolean };
type Service = {
  command?: string[];
  entrypoint?: string[];
  network_mode?: string;
  networks?: string[] | Record<string, unknown>;
  tmpfs?: string[];
  volumes?: Mount[];
};
type Compose = {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
};

const compose = parse(readFileSync(
  'deploy/mode-r/docker-compose.application.v1.yml',
  'utf8',
)) as Compose;
const protocolV2 = JSON.parse(readFileSync(
  'protocols/mode-r-application-development.v2.json',
  'utf8',
)) as {
  schemaVersion: number;
  status: string;
  runId: string;
  predecessorFailure: {
    path: string;
    stage: string;
    applicationProcessesStarted: number;
  };
  compose: { path: string; sha256: string };
  correction: { scientificDesignChanged: boolean; thresholdChanged: boolean };
};
const protocolV3 = JSON.parse(readFileSync(
  'protocols/mode-r-application-development.v3.json',
  'utf8',
)) as typeof protocolV2;
const protocolV4 = JSON.parse(readFileSync(
  'protocols/mode-r-application-development.v4.json',
  'utf8',
)) as typeof protocolV3;
const protocolV5 = JSON.parse(readFileSync(
  'protocols/mode-r-application-development.v5.json',
  'utf8',
)) as typeof protocolV4;

const processes = [
  'audit-interpreter', 'baby-a', 'baby-b', 'checkpoint',
  'controller-scenario', 'evidence-writer', 'gateway', 'model-adapter-a',
  'model-adapter-b', 'offline-verifier', 'signer-affect', 'signer-audit',
  'signer-baby-a-ledger', 'signer-baby-b-ledger', 'signer-channel',
  'simulated-anchor', 'witness-signer',
];

function networks(service: Service): string[] {
  if (service.network_mode === 'none') return [];
  if (Array.isArray(service.networks)) return [...service.networks].sort();
  return Object.keys(service.networks ?? {}).sort();
}

function ownersOfTarget(target: string): string[] {
  return Object.entries(compose.services)
    .filter(([, service]) => service.volumes?.some((mount) => mount.target === target))
    .map(([name]) => name)
    .sort();
}

describe('selected Mode R application Compose', () => {
  it('uses a fresh v2 identity after preserving the pre-start v1 failure', () => {
    expect(protocolV2.schemaVersion).toBe(2);
    expect(protocolV2.status).toBe('design-locked-not-executed');
    expect(protocolV2.runId).toBe('mode-r-application-v2');
    expect(protocolV2.predecessorFailure).toEqual({
      path: 'reports/research/mode-r-application-development-v1-failure.json',
      stage: 'compose-container-creation',
      applicationProcessesStarted: 0,
    });
    expect(protocolV2.correction).toMatchObject({
      scientificDesignChanged: false,
      thresholdChanged: false,
    });
    expect(protocolV2.compose).toEqual({
      path: 'deploy/mode-r/docker-compose.application.v1.yml',
      sha256: 'b45400cf705c7ee20e11b4dbf6bc6a8afbe5682683e3ec99640e0b550c761474',
    });
  });

  it('uses a fresh v3 identity after preserving the v2 startup failure', () => {
    expect(protocolV3.schemaVersion).toBe(3);
    expect(protocolV3.status).toBe('design-locked-not-executed');
    expect(protocolV3.runId).toBe('mode-r-application-v3');
    expect(protocolV3.predecessorFailure.path)
      .toBe('reports/research/mode-r-application-development-v2-failure.json');
    expect(protocolV3.correction).toMatchObject({
      scientificDesignChanged: false,
      thresholdChanged: false,
    });
    expect(createHash('sha256').update(readFileSync(protocolV3.compose.path))
      .digest('hex')).toBe(protocolV3.compose.sha256);
  });

  it('uses a fresh v4 identity after preserving the v3 identity failure', () => {
    expect(protocolV4.schemaVersion).toBe(4);
    expect(protocolV4.status).toBe('design-locked-not-executed');
    expect(protocolV4.runId).toBe('mode-r-application-v4');
    expect(protocolV4.predecessorFailure.path)
      .toBe('reports/research/mode-r-application-development-v3-failure.json');
    expect(protocolV4.correction).toMatchObject({
      scientificDesignChanged: false,
      thresholdChanged: false,
    });
    expect(createHash('sha256').update(readFileSync(protocolV4.compose.path))
      .digest('hex')).toBe(protocolV4.compose.sha256);
  });

  it('uses a fresh v5 identity after preserving the v4 pre-execution stop', () => {
    expect(protocolV5.schemaVersion).toBe(5);
    expect(protocolV5.status).toBe('design-locked-not-executed');
    expect(protocolV5.runId).toBe('mode-r-application-v5');
    expect(protocolV5.predecessorFailure.path)
      .toBe('reports/research/mode-r-application-development-v4-pre-execution-failure.json');
    expect(protocolV5.correction).toMatchObject({
      scientificDesignChanged: false,
      thresholdChanged: false,
    });
    expect(createHash('sha256').update(readFileSync(protocolV5.compose.path))
      .digest('hex')).toBe(protocolV5.compose.sha256);
  });

  it('declares the exact 17-process graph and three internal networks', () => {
    expect(Object.keys(compose.services).sort()).toEqual(processes);
    expect(Object.keys(compose.networks).sort()).toEqual([
      'baby-a-gateway', 'baby-b-gateway', 'control-plane',
    ]);
    expect(Object.values(compose.networks).every((network) => network.internal))
      .toBe(true);
    expect(networks(compose.services['baby-a']!)).toEqual(['baby-a-gateway']);
    expect(networks(compose.services['baby-b']!)).toEqual(['baby-b-gateway']);
    expect(networks(compose.services.gateway!)).toEqual([
      'baby-a-gateway', 'baby-b-gateway', 'control-plane',
    ]);
    expect(networks(compose.services['controller-scenario']!))
      .toEqual(['control-plane']);
    for (const name of [
      'model-adapter-a', 'model-adapter-b', 'offline-verifier',
      'signer-affect', 'signer-audit', 'signer-baby-a-ledger',
      'signer-baby-b-ledger', 'signer-channel', 'witness-signer',
    ]) expect(networks(compose.services[name]!)).toEqual([]);
    for (const name of ['model-adapter-a', 'model-adapter-b', 'baby-a', 'baby-b']) {
      expect(compose.services[name]!.tmpfs).toEqual([
        '/tmp:noexec,nosuid,size=16m',
      ]);
    }
  });

  it('mounts each private application capability only in its two owners', () => {
    const expected: Record<string, string[]> = {
      '/run/ald-mode-r/evidence/controller': ['controller-scenario', 'evidence-writer'],
      '/run/ald-mode-r/evidence/gateway': ['evidence-writer', 'gateway'],
      '/run/ald-mode-r/evidence/checkpoint': ['checkpoint', 'evidence-writer'],
      '/run/ald-mode-r/evidence/anchor': ['evidence-writer', 'simulated-anchor'],
      '/run/ald-mode-r/evidence/audit': ['audit-interpreter', 'evidence-writer'],
      '/run/ald-mode-r/gateway-controller': ['controller-scenario', 'gateway'],
      '/run/ald-mode-r/gateway-baby-a': ['controller-scenario', 'gateway'],
      '/run/ald-mode-r/gateway-baby-b': ['controller-scenario', 'gateway'],
      '/run/ald-mode-r/checkpoint-service': ['checkpoint', 'controller-scenario'],
      '/run/ald-mode-r/anchor-service': ['controller-scenario', 'simulated-anchor'],
      '/run/ald-mode-r/audit-service': ['audit-interpreter', 'controller-scenario'],
      '/run/ald-mode-r/model-a': ['baby-a', 'model-adapter-a'],
      '/run/ald-mode-r/model-b': ['baby-b', 'model-adapter-b'],
    };
    for (const [target, owners] of Object.entries(expected)) {
      expect(ownersOfTarget(target), target).toEqual(owners.sort());
    }
    expect(compose.services['controller-scenario']!.volumes?.some((mount) =>
      mount.target.includes('evidence/gateway'))).toBe(false);
    expect(compose.services['controller-scenario']!.volumes?.some((mount) =>
      mount.target.includes('/signer-') || mount.target.endsWith('/signers'))).toBe(false);
  });

  it('keeps the selected file separate from historical collectors and fixtures', () => {
    const source = readFileSync(
      'deploy/mode-r/docker-compose.application.v1.yml',
      'utf8',
    );
    expect(source).not.toContain('__tests__/fixtures');
    expect(source).not.toContain('docker-compose.e02.yml');
    expect(source).toContain('application-controller.mjs');
    expect(source).toContain('application-offline-verifier.mjs');
    expect(source).toContain('condition: service_completed_successfully');
    const collector = readFileSync(
      'scripts/run-mode-r-application-development.mjs',
      'utf8',
    );
    expect(collector).toContain("command('git', ['status', '--porcelain'])");
    expect(collector).toContain("existsSync(evidenceRoot), false");
    expect(collector).toContain("compose('wait', 'controller-scenario')");
    expect(collector).toContain("compose('wait', 'offline-verifier')");
    expect(collector).toContain("compose('ps', '--all', '--quiet')");
    expect(collector).toContain('promptBundleHash: promptBundleHash(');
    expect(collector).toContain('tracks.map((track) => loadLearnerContract(track))');
    expect(collector).toContain('scenarioBundleHash: scenario.bundleHash');
    expect(collector.indexOf('const runConfig = {'))
      .toBeLessThan(collector.indexOf('const directories = ['));
    expect(collector).toContain("compose('down', '--remove-orphans')");
    expect(collector).toContain('researchFinding: false');
    expect(collector).toContain('b12Closed: false');
  });
});
