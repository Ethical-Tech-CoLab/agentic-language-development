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

describe('prospective Mode R authority graph', () => {
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
    expect(controller).not.toContain('.carrierProtocol.validate(');
    expect(controller).not.toContain('.carrierContext');
    expect(controller).not.toContain('batchArtifacts');
  });
});
