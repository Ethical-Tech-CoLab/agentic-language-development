import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { canonicalJson, hashCanonical, parseCanonicalJson } from '@ald/hashing';

import { EvidenceWriteUncertainError, type GatewayEvidencePort } from './evidence-port.js';

type WriteMethod = keyof GatewayEvidencePort;

interface WriteIntent {
  version: 1;
  runId: string;
  id: string;
  method: WriteMethod;
  requestHash: string;
}

interface WriteConfirmation {
  version: 1;
  runId: string;
  id: string;
  responseHash: string;
}

const METHODS: readonly WriteMethod[] = [
  'commitTurn',
  'commitRejection',
  'commitControlArtifact',
  'appendLedgerEvent',
  'appendInterventionEvent',
  'appendAffectEvent',
];

/**
 * Durable client-side accounting for a writer request that may outlive its reply.
 * This is an operational journal, not signed research evidence or an RPC client.
 */
export class GatewayWriteIntentJournal {
  private quarantined = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly directory: string,
    readonly runId: string,
  ) {}

  /** A new process must inspect the existing journal before it obtains a port. */
  async openPort(port: GatewayEvidencePort): Promise<GatewayEvidencePort> {
    try {
      await this.ensurePrivateDirectory();
      if ((await this.unresolvedIntents()).length > 0) this.quarantined = true;
    } catch (error) {
      this.quarantined = true;
      throw error;
    }
    return {
      commitTurn: (request) => this.send('commitTurn', request, () => port.commitTurn(request)),
      commitRejection: (request) =>
        this.send('commitRejection', request, () => port.commitRejection(request)),
      commitControlArtifact: (request) =>
        this.send('commitControlArtifact', request, () => port.commitControlArtifact(request)),
      appendLedgerEvent: (request) =>
        this.send('appendLedgerEvent', request, () => port.appendLedgerEvent(request)),
      appendInterventionEvent: (request) =>
        this.send('appendInterventionEvent', request, () => port.appendInterventionEvent(request)),
      appendAffectEvent: (request) =>
        this.send('appendAffectEvent', request, () => port.appendAffectEvent(request)),
    };
  }

  isQuarantined(): boolean {
    return this.quarantined;
  }

  async unresolvedIntents(): Promise<WriteIntent[]> {
    const files = await readdir(this.directory);
    const names = new Set(files);
    const intents: WriteIntent[] = [];
    for (const file of files) {
      if (file.endsWith('.confirmed.json')) continue;
      if (!file.endsWith('.intent.json')) {
        throw new EvidenceWriteUncertainError();
      }
      const value = parseCanonicalJson<WriteIntent>(
        (await readFile(join(this.directory, file), 'utf8')).trimEnd(),
      );
      if (
        value.version !== 1 || value.runId !== this.runId ||
        `${value.id}.intent.json` !== file ||
        !METHODS.includes(value.method) ||
        !/^sha256:[a-f0-9]{64}$/.test(value.requestHash)
      ) {
        throw new EvidenceWriteUncertainError();
      }
      const confirmationFile = `${value.id}.confirmed.json`;
      if (!names.has(confirmationFile)) {
        intents.push(value);
        continue;
      }
      const confirmation = parseCanonicalJson<WriteConfirmation>(
        (await readFile(join(this.directory, confirmationFile), 'utf8')).trimEnd(),
      );
      if (
        confirmation.version !== 1 || confirmation.runId !== this.runId ||
        confirmation.id !== value.id ||
        !/^sha256:[a-f0-9]{64}$/.test(confirmation.responseHash)
      ) {
        throw new EvidenceWriteUncertainError();
      }
    }
    for (const file of files.filter((name) => name.endsWith('.confirmed.json'))) {
      if (!names.has(file.replace('.confirmed.json', '.intent.json'))) {
        throw new EvidenceWriteUncertainError();
      }
    }
    return intents;
  }

  private async send<T>(method: WriteMethod, request: unknown, call: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.pending;
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.quarantined) throw new EvidenceWriteUncertainError();
      if (
        typeof request !== 'object' || request === null ||
        !('runId' in request) || request.runId !== this.runId
      ) {
        throw new Error('Gateway evidence request has the wrong run id');
      }
      const id = randomUUID();
      const intent: WriteIntent = {
        version: 1,
        runId: this.runId,
        id,
        method,
        requestHash: hashCanonical('ald/gateway-write-request/v1', request),
      };
      try {
        await this.writeDurably(`${id}.intent.json`, intent);
      } catch (error) {
        this.quarantined = true;
        throw error;
      }
      try {
        const response = await call();
        await this.writeDurably(`${id}.confirmed.json`, {
          version: 1,
          runId: this.runId,
          id,
          responseHash: hashCanonical('ald/gateway-write-response/v1', response),
        } satisfies WriteConfirmation);
        return response;
      } catch {
        // After the intent is durable, even a missing reply before commit is
        // indistinguishable from a lost reply after commit.
        this.quarantined = true;
        throw new EvidenceWriteUncertainError();
      }
    } finally {
      release();
    }
  }

  private async ensurePrivateDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error('Gateway write-intent journal must be a private directory');
    }
    const parent = await open(dirname(this.directory), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  private async writeDurably(file: string, value: unknown): Promise<void> {
    const handle = await open(join(this.directory, file), 'wx', 0o600);
    try {
      await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
