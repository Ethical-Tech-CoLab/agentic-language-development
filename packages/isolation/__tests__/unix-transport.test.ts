import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FrameConnection,
  connectUnixFrameChannel,
  createUnixFrameServer,
} from '../src/index.js';

describe('private Unix frame transport', () => {
  it('serves one framed connection on a mode-0600 socket', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-unix-frame-'));
    const socketPath = join(directory, 'learner.sock');
    let host: FrameConnection | undefined;
    const server = await createUnixFrameServer({
      socketPath,
      onChannel: (channel) => {
        host = new FrameConnection({
          channel,
          originator: 'h',
          handler: async (method, params) => ({ method, params }),
        });
      },
    });
    const firstChannel = await connectUnixFrameChannel({ socketPath });
    const first = new FrameConnection({ channel: firstChannel, originator: 'r' });

    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      await expect(first.request('probe', { value: 7 })).resolves.toEqual({
        method: 'probe',
        params: { value: 7 },
      });

      const secondChannel = await connectUnixFrameChannel({ socketPath });
      const second = new FrameConnection({ channel: secondChannel, originator: 'r' });
      await expect(second.request('probe', {})).rejects.toMatchObject({
        code: 'host-unavailable',
      });
      second.close();
      expect(host).toBeDefined();
    } finally {
      first.close();
      host?.close();
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a socket directory accessible to other users', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-unix-frame-open-'));
    const socketPath = join(directory, 'learner.sock');
    chmodSync(directory, 0o755);
    try {
      await expect(createUnixFrameServer({
        socketPath,
        onChannel: () => undefined,
      })).rejects.toMatchObject({ code: 'configuration' });
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
