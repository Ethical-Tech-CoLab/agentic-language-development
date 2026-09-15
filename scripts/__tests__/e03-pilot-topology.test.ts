import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('registered E03 Prototype-Mode collector source contract', () => {
  it('constructs in-process adapters and records one Nursery trust process', () => {
    const slot = read('deploy/mode-r/run-e03-pilot-slot.mjs');
    expect(slot).not.toContain('createIsolatedAdapterFactory');
    expect(slot).not.toContain('adapterFactoryFor:');
    expect(slot).toContain("topology.adapterTransport, 'in-process'");
    expect(slot).toContain('externalLearnerContainerCount: 0');
    expect(slot).toContain('nurseryContainerId: process.env.HOSTNAME');
  });

  it('launches only the Nursery and rejects reused Prototype containers', () => {
    const collector = read('scripts/run-e03-registered-pilot.mjs');
    expect(collector).toContain("'build', 'nursery-study'");
    expect(collector).not.toContain("'up', '--detach'");
    expect(collector).not.toContain('captureLearnerResources');
    expect(collector).toContain('original pilot Nursery container was reused');
    expect(collector).toContain('learnerResourceSha256: null');
  });
});
