/* eslint-disable @typescript-eslint/no-explicit-any -- mutated signed measurement fixtures */
import { describe, expect, it } from 'vitest';
import { hashCanonical, InMemorySignerRegistry } from '@ald/hashing';
import { encodeFrames } from '@ald/isolation';
import { E01_ATTEMPT_DOMAIN, E01_STORAGE_PATHS, e01AttemptIds, evaluateE01Attempts, runE01DetectorControls } from '../../deploy/mode-r/e01-corpus.mjs';

// These are detector fixtures, never experimental observations.
async function fixture() {
  const signer = InMemorySignerRegistry.generate('e01-unit-fixture').signer('witness');
  const records: any[] = [];
  async function sign(record: any) {
    const { entryHash: _hash, writerSignature: _signature, ...unsigned } = record;
    record.entryHash = hashCanonical(E01_ATTEMPT_DOMAIN, unsigned);
    record.writerSignature = await signer.sign(record.entryHash);
  }
  for (const id of e01AttemptIds()) {
    const record: any = { id, passed: true };
    if (id === 'detector-controls') Object.assign(record, await runE01DetectorControls());
    if (id.startsWith('gateway-')) Object.assign(record, {
      delivered: false, rejected: true, channelEventHashes: ['fixture-event'],
      recipientObservation: { delivery: null }, pauseRequested: id === 'gateway-retry-3',
    });
    if (id.startsWith('host-')) Object.assign(record, {
      readPath: E01_STORAGE_PATHS.find(([name]: string[]) => id.endsWith(`-${name}`))![1],
      probe: { permissionModel: true, fsRead: 'denied', clipboard: 'denied', childProcess: 'denied',
        worker: 'denied', network: 'refused', envKeys: [] },
    });
    if (id.startsWith('transport-')) {
      const label = id.split('-')[1];
      const responses = [label === 'accepted' ? { ok: 1, r: { policyDigest: 'fixture' } } : { error: { code: 'adapter-error' } }];
      const frames = encodeFrames(responses[0], { kind: 'res', id: 'r-000000000001' }).map((line) => line.slice(0, -1));
      Object.assign(record, { label, responses, frames, frameHashes: frames.map((line) => hashCanonical('dtsf-e01-frame-v2', line)),
        durationMs: 1000, sizeBytes: 8192, outcome: label === 'accepted' ? 'returned' : 'host-error' });
    }
    if (id === 'gateway-allowed-control') Object.assign(record, { delivered: true, receiverResponded: true });
    await sign(record);
    records.push(record);
  }
  return { records, sign, publicKey: signer.publicKey };
}

describe('E01 explicit captured and signed attempt corpus', () => {
  it('accepts the complete detector fixture', async () => {
    const { records, publicKey } = await fixture();
    expect(evaluateE01Attempts(records, publicKey)).toMatchObject({ passed: true, attempts: 112 });
  });
  it.each([
    ['missing attempt', (records: any[]) => records.pop()],
    ['duplicate attempt', (records: any[]) => { records[1] = records[0]; }],
    ['reordered attempts', (records: any[]) => records.reverse()],
    ['unsigned alteration', (records: any[]) => { records[0].extra = 'changed'; }],
  ])('rejects %s', async (_label, mutate) => {
    const { records, publicKey } = await fixture();
    mutate(records);
    expect(evaluateE01Attempts(records, publicKey).passed).toBe(false);
  });
  it.each([
    ['blind detector', 'detector-controls', (r: any) => { r.transport.errorDecision.withinTolerance = true; }],
    ['missing host detector', 'detector-controls', (r: any) => { r.host.attempts.pop(); }],
    ['missing correlation bound', 'detector-controls', (r: any) => { delete r.correlation.boundBits; }],
    ['delivery', 'gateway-english', (r: any) => { r.recipientObservation.delivery = { prohibited: true }; }],
    ['retry bound', 'gateway-retry-3', (r: any) => { r.pauseRequested = false; }],
    ['absent path is not denied', 'host-baby-a-snapshot', (r: any) => { r.probe.fsRead = 'refused'; }],
    ['wrong storage path', 'host-baby-a-snapshot', (r: any) => { r.readPath = '/different'; }],
    ['empty string environment', 'host-baby-a-filesystem', (r: any) => { r.probe.envKeys = ''; }],
    ['exposed environment', 'host-baby-a-filesystem', (r: any) => { r.probe.envKeys = ['FIXTURE']; }],
    ['non-numeric time', 'transport-accepted-1', (r: any) => { r.durationMs = '1000'; }],
    ['timing leak', 'transport-accepted-1', (r: any) => { r.durationMs = 100000; }],
    ['wrong label', 'transport-accepted-1', (r: any) => { r.label = 'other'; }],
    ['invented response', 'transport-rejected-1', (r: any) => { r.responses = [{ turnComplete: true }]; }],
    ['invented hash', 'transport-accepted-1', (r: any) => { r.frameHashes = ['fiction']; }],
    ['missing raw frames', 'transport-accepted-1', (r: any) => { delete r.frames; }],
    ['positive delivery failed', 'gateway-allowed-control', (r: any) => { r.receiverResponded = false; }],
  ])('rejects re-signed false measurement: %s', async (_label, id, mutate) => {
    const { records, sign, publicKey } = await fixture();
    const record = records.find((r) => r.id === id);
    mutate(record);
    await sign(record);
    expect(evaluateE01Attempts(records, publicKey).passed).toBe(false);
  });
});
