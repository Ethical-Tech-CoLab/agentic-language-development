import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Service = { command?: string[]; cpus?: number; mem_limit?: string; memswap_limit?: string };
type Compose = { services: Record<string, Service> };

const overlay = parse(readFileSync('deploy/mode-r/docker-compose.lv01.v1.yml', 'utf8')) as Compose;
const selectedServices = [
  'audit-interpreter', 'baby-a', 'baby-b', 'checkpoint', 'controller-scenario',
  'evidence-writer', 'gateway', 'model-adapter-a', 'model-adapter-b', 'offline-verifier',
  'signer-affect', 'signer-audit', 'signer-baby-a-ledger', 'signer-baby-b-ledger',
  'signer-channel', 'simulated-anchor', 'witness-signer',
];

describe('LV01 selected topology overlay', () => {
  it('constrains every selected service without changing the authority graph', () => {
    expect(Object.keys(overlay.services).sort()).toEqual(selectedServices);
    for (const service of Object.values(overlay.services)) {
      expect(service.cpus).toBeGreaterThan(0);
      expect(service.mem_limit).toMatch(/^\d+m$/u);
      expect(service.memswap_limit).toBe(service.mem_limit);
    }
  });

  it('selects scratch learners only at the four learner-facing processes', () => {
    for (const name of ['model-adapter-a', 'model-adapter-b', 'baby-a', 'baby-b']) {
      expect(overlay.services[name]?.command).toContain('--track=scratch-rl');
    }
    expect(Object.values(overlay.services).filter((service) =>
      service.command?.some((argument) => argument.startsWith('--track=')))).toHaveLength(4);
  });
});
