/**
 * ALD-019 — the anchoring wallet key is stored separately from the per-run
 * event/witness keys, never logged, and rotating it leaves prior receipts
 * verifiable (LEDGER §11, SPEC §13.5).
 */
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FileKeyStore } from '@ald/hashing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ANCHOR_KEY_FILE_MODE,
  AnchorKeyFileError,
  BaseAnchorPublisher,
  FakeChainTransport,
  generateAnchorKey,
  loadAnchorKeyFile,
  verifyAnchorReceipt,
  writeAnchorKeyFile,
} from '../src/index.js';
import type { AnchorTestContext } from './support.js';
import {
  ANCHOR_ADDRESS,
  cleanupTemporaryDirectories,
  createAnchorContext,
  immediateSleep,
  temporaryDirectory,
} from './support.js';

const openContexts: AnchorTestContext[] = [];

afterAll(async () => {
  for (const open of openContexts.splice(0)) {
    open.close();
  }
  await cleanupTemporaryDirectories();
});

describe('anchor key files (ALD-019)', () => {
  it('writes 0600 and round-trips the key and address', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'keys', 'anchor.key');
    const generated = generateAnchorKey();

    const written = await writeAnchorKeyFile(path, generated.privateKey);
    expect(written).toEqual(generated);

    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(ANCHOR_KEY_FILE_MODE);

    const loaded = await loadAnchorKeyFile(path);
    expect(loaded.privateKey).toBe(generated.privateKey);
    expect(loaded.address).toBe(generated.address);
  });

  it('refuses a group/other-readable key file unless explicitly allowed', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'anchor.key');
    const key = generateAnchorKey();
    await writeAnchorKeyFile(path, key.privateKey);
    await chmod(path, 0o644);

    const failure = await loadAnchorKeyFile(path).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AnchorKeyFileError);
    expect((failure as AnchorKeyFileError).code).toBe('ANCHOR_KEY_FILE');
    // LEDGER §11: never log the key — not even inside an error message.
    expect((failure as Error).message).not.toContain(key.privateKey.slice(2));

    await expect(
      loadAnchorKeyFile(path, { allowInsecurePermissions: true }),
    ).resolves.toMatchObject({ address: key.address });
  });

  it('rejects malformed contents without echoing them', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'bad.key');
    await writeFile(path, 'not-a-key-0xdeadbeef\n', { mode: 0o600 });

    const failure = await loadAnchorKeyFile(path).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AnchorKeyFileError);
    expect((failure as Error).message).not.toContain('not-a-key');

    await expect(loadAnchorKeyFile(join(directory, 'missing.key'))).rejects.toBeInstanceOf(
      AnchorKeyFileError,
    );
  });

  it('accepts a trailing-whitespace key file and refuses to clobber it', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'anchor.key');
    const key = generateAnchorKey();
    await writeFile(path, `  ${key.privateKey}\n\n`, { mode: 0o600 });

    await expect(loadAnchorKeyFile(path)).resolves.toEqual(key);
    await expect(
      writeAnchorKeyFile(path, generateAnchorKey().privateKey),
    ).rejects.toBeInstanceOf(AnchorKeyFileError);
  });

  it('lives outside the per-run event signer key store', async () => {
    const directory = await temporaryDirectory();
    const keyStoreDir = join(directory, 'event-keys');
    const anchorKeyPath = join(directory, 'anchor', 'anchor.key');

    const store = new FileKeyStore(keyStoreDir);
    store.provisionRun('run-anchor-keys');
    const anchorKey = generateAnchorKey();
    await writeAnchorKeyFile(anchorKeyPath, anchorKey.privateKey);

    // The event/witness seeds and the wallet key share no file and no bytes.
    const runFiles = await readdir(join(keyStoreDir, 'run-anchor-keys'));
    expect(runFiles).not.toContain('anchor.key');
    const seedText = await readFile(
      store.seedFile('run-anchor-keys'),
      'utf8',
    );
    expect(seedText).not.toContain(anchorKey.privateKey.slice(2));
    expect(await readFile(anchorKeyPath, 'utf8')).not.toContain('ed25519');
  });

  it('rotates the wallet key without invalidating prior receipts', async () => {
    const ctx = await createAnchorContext('run-anchor-rotation');
    openContexts.push(ctx);
    const directory = await temporaryDirectory();

    const keyA = await writeAnchorKeyFile(
      join(directory, 'anchor-a.key'),
      generateAnchorKey().privateKey,
    );
    const keyB = await writeAnchorKeyFile(
      join(directory, 'anchor-b.key'),
      generateAnchorKey().privateKey,
    );
    expect(keyA.address).not.toBe(keyB.address);

    const anchorWith = async (
      from: string,
      manifestIndex: number,
    ): Promise<{ transport: FakeChainTransport; receipt: Awaited<ReturnType<BaseAnchorPublisher['submit']>> }> => {
      const manifest = ctx.manifests[manifestIndex];
      if (manifest === undefined) {
        throw new Error(`no manifest at index ${manifestIndex}`);
      }
      const transport = new FakeChainTransport({ from });
      const publisher = new BaseAnchorPublisher({
        transport,
        evidence: ctx.writer,
        clock: ctx.clock,
        anchorAddress: ANCHOR_ADDRESS,
        finalityPolicy: '1-confirmation',
        retry: { attempts: 2, initialBackoffMs: 1, sleep: immediateSleep },
      });
      const submitted = await publisher.submit(manifest);
      transport.mineBlock(1);
      return { transport, receipt: await publisher.awaitConfirmation(submitted) };
    };

    const first = await ctx.addCheckpoint();
    const beforeRotation = await anchorWith(keyA.address, 0);

    // Rotation: a new key file and a new publisher, no code change.
    const second = await ctx.addCheckpoint('event-interval');
    const afterRotation = await anchorWith(keyB.address, 1);

    expect(beforeRotation.receipt.from).toBe(keyA.address);
    expect(afterRotation.receipt.from).toBe(keyB.address);
    expect(beforeRotation.receipt.from).not.toBe(afterRotation.receipt.from);

    await expect(
      verifyAnchorReceipt(
        beforeRotation.receipt,
        first.checkpointHash,
        beforeRotation.transport,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyAnchorReceipt(
        afterRotation.receipt,
        second.checkpointHash,
        afterRotation.transport,
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(2);
  });
});
