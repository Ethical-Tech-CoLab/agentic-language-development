import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import {
  LearnerHost,
  createUnixFrameServer,
} from '@ald/isolation';

import { required } from './application-common.mjs';

const socketPath = required('ALD_MODE_R_DELAYED_MODEL_SOCKET');
const delayedMethod = required('ALD_MODE_R_DELAYED_MODEL_METHOD');
const delayMs = Number(required('ALD_MODE_R_DELAYED_MODEL_MS'));
const track = process.env.ALD_MODE_R_DELAYED_MODEL_TRACK ?? 'no-learning';
assert.ok(['observe', 'act', 'receive', 'on_outcome'].includes(delayedMethod));
assert.ok(Number.isSafeInteger(delayMs) && delayMs > 0);
assert.ok(['no-learning', 'scratch-rl'].includes(track));

const hosts = new Set();
const server = await createUnixFrameServer({
  socketPath,
  onChannel: (channel) => {
    const host = new LearnerHost({
      channel,
      boundary: 'separate-container',
      track,
      hostLabel: 'model-adapter-a',
      beforeDispatch: async (method) => {
        if (method === delayedMethod) await delay(delayMs);
      },
      onShutdown: () => {
        void host.close();
        hosts.delete(host);
      },
    });
    hosts.add(host);
    channel.onClose(() => hosts.delete(host));
  },
});

const stop = () => {
  void Promise.all([...hosts].map((host) => host.close()))
    .then(() => server.close())
    .then(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdout.write('ready\n');
await new Promise(() => {});
