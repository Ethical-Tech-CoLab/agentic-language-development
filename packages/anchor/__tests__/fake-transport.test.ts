import { describe, expect, it } from 'vitest';

import { FakeChainTransport } from '../src/index.js';

const TO = `0x${'33'.repeat(20)}`;

function checkpoint(tag: string) {
  return `sha256:${tag.repeat(32)}`;
}

describe('FakeChainTransport mining and seeding', () => {
  it('includes every pending transaction in the next block', async () => {
    // R10-C-M11 L6 kill: including only the first leaves the second pending.
    const transport = new FakeChainTransport();
    const first = await transport.sendAnchorTransaction({
      checkpointHash: checkpoint('aa'),
      to: TO,
    });
    const second = await transport.sendAnchorTransaction({
      checkpointHash: checkpoint('bb'),
      to: TO,
    });
    expect(transport.mineBlock(1)).toBe(1);
    await expect(
      transport.getTransactionReceipt(first.transactionHash),
    ).resolves.toMatchObject({ status: 'success', blockNumber: 1 });
    await expect(
      transport.getTransactionReceipt(second.transactionHash),
    ).resolves.toMatchObject({ status: 'success', blockNumber: 1 });
  });

  it('matches seeded transactions case-insensitively', async () => {
    // R10-C-M11 L8 kill: without normalization the lookup misses.
    const transport = new FakeChainTransport();
    const upper = `0x${'AB'.repeat(32)}`;
    transport.setTransaction(
      {
        hash: upper,
        from: `0x${'22'.repeat(20)}`,
        to: TO,
        input: `0x${'00'.repeat(32)}`,
        blockNumber: 7,
        blockHash: `0x${'44'.repeat(32)}`,
      },
      {
        status: 'success',
        blockNumber: 7,
        blockHash: `0x${'44'.repeat(32)}`,
      },
    );
    await expect(
      transport.getTransaction(upper.toLowerCase()),
    ).resolves.toMatchObject({ hash: upper });
    await expect(
      transport.getTransactionReceipt(upper.toLowerCase()),
    ).resolves.toMatchObject({ status: 'success', blockNumber: 7 });
  });
});
