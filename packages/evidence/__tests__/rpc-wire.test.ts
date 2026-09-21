import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEvidenceRpcServer } from '../src/rpc-wire.js';

describe('private RPC socket lifecycle', () => {
  it('never reclaims a socket that still accepts connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-rpc-live-socket-'));
    const socketPath = join(directory, 'service.sock');
    const server = await createEvidenceRpcServer(
      socketPath,
      'run-live-socket',
      'test-v1',
      [],
      () => false,
      () => null,
    );
    try {
      await expect(createEvidenceRpcServer(
        socketPath,
        'run-live-socket',
        'test-v1',
        [],
        () => false,
        () => null,
      )).rejects.toThrow('already accepts connections');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
