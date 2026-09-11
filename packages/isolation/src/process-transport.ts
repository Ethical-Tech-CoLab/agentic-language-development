/**
 * Separate-process transport: one learner host per Baby, launched under
 * Node's permission model (SPEC §5.2, §5.3, §10.3; ALD-055).
 *
 * What the launch actually denies, and how:
 *
 * - `--permission` with **no** `--allow-child-process`, `--allow-worker`,
 *   `--allow-wasi`, `--allow-addons`, `--allow-inspector` and **no**
 *   `--allow-fs-write` at all: the host cannot spawn a process, start a
 *   worker, load a native addon, open an inspector, or write a single file.
 * - `--allow-fs-read` naming *only* the module graph the host needs: this
 *   package's `bin`/`dist`, the workspace packages' `dist` directories,
 *   `package.json` manifests, pnpm package-local dependency links, and the
 *   root `node_modules`. The dependency links are required for ESM package
 *   resolution under pnpm; their targets remain the installed module graph.
 *   The evidence
 *   database, the key store, the scenario bundles, `contracts/`, and the
 *   repository sources are all outside the list — see the fs-denial test,
 *   which hands the host the evidence path as a decoy and asserts `denied`.
 * - an empty environment and a fresh empty working directory: no
 *   `ALD_*` variable, no peer address, no database URL, no `PATH`. A host
 *   therefore has no *name* for anything outside itself, which is the other
 *   half of "no in-memory object reference is shared" (ALD-055 criterion 2):
 *   there is no handle and no address to reach for.
 * - `stdio: ['pipe', 'pipe', 'ignore']`: stderr is discarded, because an
 *   adapter's error text is model-influenced content and a distinguishable
 *   error body is precisely the error-message side channel of SPEC §10.3.
 *   `stderr: 'count'` is available for operators who want a fault *count*
 *   without content; it counts bytes and lines and stores neither.
 *
 * What this transport does **not** do: it does not close the network. Node's
 * permission model has no network dimension, so a hosted adapter can still
 * open a socket. Denying the Baby-to-Baby route is the container transport's
 * job (`deploy/mode-r/docker-compose.yml`, internal networks) and the README
 * states that boundary explicitly rather than implying process isolation
 * covers it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IsolationError, type IsolationErrorCode } from './errors.js';
import type { FrameChannel } from './channel.js';

/** Absolute path of this package's root, resolved from the module itself. */
export function isolationPackageRoot(): string {
  return fileURLToPath(new URL('../', import.meta.url));
}

/** Absolute path of the workspace root that holds `packages/` and `node_modules/`. */
export function workspaceRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/** Default child entry point: the package's `bin` script. */
export function defaultHostEntry(): string {
  return join(isolationPackageRoot(), 'bin', 'ald-learner-host.js');
}

/**
 * The read allowlist: the module graph and nothing else.
 *
 * Enumerated rather than globbed so the list is auditable in a test and so a
 * new package directory cannot silently widen it.
 */
export function defaultReadAllowList(hostEntry = defaultHostEntry()): string[] {
  const root = workspaceRoot();
  const allow = new Set<string>([
    dirname(hostEntry),
    join(isolationPackageRoot(), 'dist'),
    join(root, 'node_modules'),
    join(root, 'package.json'),
  ]);
  const packagesDir = join(root, 'packages');
  let entries: string[] = [];
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const dist = join(packagesDir, name, 'dist');
    if (existsSync(dist)) {
      allow.add(dist);
    }
    const manifest = join(packagesDir, name, 'package.json');
    if (existsSync(manifest)) {
      allow.add(manifest);
    }
    const dependencies = join(packagesDir, name, 'node_modules');
    if (existsSync(dependencies)) {
      allow.add(dependencies);
    }
  }
  return [...allow].sort();
}

export interface NodePermissionOptions {
  /** Turn the permission model off. Only for diagnosing a launch failure. */
  permissionModel?: boolean;
  /** Overrides the computed read allowlist entirely. */
  allowFsRead?: readonly string[];
}

/**
 * Node CLI flags for a locked-down host.
 *
 * Every `--allow-*` flag Node 24 offers is listed in the comment above; the
 * ones that are absent here are absent on purpose, and a test asserts that
 * this function never emits them.
 */
export function nodePermissionArgs(options: NodePermissionOptions = {}): string[] {
  if (options.permissionModel === false) {
    return [];
  }
  const allow = options.allowFsRead ?? defaultReadAllowList();
  return ['--permission', ...allow.map((path) => `--allow-fs-read=${path}`)];
}

export interface ProcessTransportOptions extends NodePermissionOptions {
  /** Child entry module. Defaults to this package's `bin` script. */
  hostEntry?: string;
  /** Node binary. Defaults to the runtime's own `process.execPath`. */
  nodeExecPath?: string;
  /** Extra arguments appended after the entry path. */
  hostArgs?: readonly string[];
  /** Environment for the child. Defaults to `{}` — nothing at all. */
  env?: Readonly<Record<string, string>>;
  /** Working directory. Defaults to a fresh empty temporary directory. */
  cwd?: string;
  /** `ignore` discards stderr (default); `count` counts it without storing it. */
  stderr?: 'ignore' | 'count';
  /** Operator label recorded in the `IsolationDescriptor`. Never Baby-visible. */
  hostLabel?: string;
}

/** Counters an operator may read; never content (SPEC §10.3, §14.1). */
export interface HostDiagnostics {
  stderrBytes: number;
  stderrLines: number;
  exitCode: number | null;
  signal: string | null;
}

/**
 * A learner host's stdio as a {@link FrameChannel}.
 *
 * The whole frame sequence of one message is written in a single `write`
 * call, which is what makes non-interleaved framing a property of the
 * transport rather than an assumption.
 */
export class ProcessHostChannel implements FrameChannel {
  readonly kind = 'process' as const;

  readonly diagnostics: HostDiagnostics = {
    stderrBytes: 0,
    stderrLines: 0,
    exitCode: null,
    signal: null,
  };

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly temporaryCwd: string | undefined;
  private lineHandler: ((line: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private closed = false;

  constructor(options: ProcessTransportOptions = {}) {
    const hostEntry = options.hostEntry ?? defaultHostEntry();
    if (!existsSync(hostEntry)) {
      throw new IsolationError('configuration');
    }
    this.temporaryCwd =
      options.cwd === undefined
        ? mkdtempSync(join(tmpdir(), 'ald-learner-host-'))
        : undefined;
    const cwd = options.cwd ?? (this.temporaryCwd as string);
    const args = [
      ...nodePermissionArgs(options),
      hostEntry,
      ...(options.hostArgs ?? []),
    ];

    try {
      this.child = spawn(options.nodeExecPath ?? process.execPath, args, {
        cwd,
        env: { ...(options.env ?? {}) },
        stdio: ['pipe', 'pipe', options.stderr === 'count' ? 'pipe' : 'ignore'],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (cause) {
      this.cleanupCwd();
      throw new IsolationError('spawn-failed', { cause });
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.lineHandler?.(chunk);
    });
    this.child.stdout.on('error', () => {
      this.settle();
    });
    this.child.stdin.on('error', () => {
      this.settle();
    });
    if (options.stderr === 'count' && this.child.stderr !== null) {
      this.child.stderr.on('data', (chunk: Buffer) => {
        // Counted, never stored: an adapter's stderr is model-influenced text.
        this.diagnostics.stderrBytes += chunk.byteLength;
        this.diagnostics.stderrLines += chunk
          .toString('utf8')
          .split('\n').length - 1;
      });
    }
    this.child.on('error', () => {
      this.settle();
    });
    this.child.on('exit', (code, signal) => {
      this.diagnostics.exitCode = code;
      this.diagnostics.signal = signal;
      this.settle();
    });
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  /** Whether the child is still running. */
  get alive(): boolean {
    return !this.closed && this.child.exitCode === null && !this.child.killed;
  }

  write(lines: readonly string[]): void {
    if (this.closed) {
      throw new IsolationError('host-unavailable');
    }
    for (const line of lines) {
      this.child.stdin.write(line);
    }
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closed) {
      handler();
    }
  }

  closeCode(): IsolationErrorCode {
    return this.diagnostics.exitCode !== null || this.diagnostics.signal !== null
      ? 'host-exited'
      : 'host-unavailable';
  }

  close(): void {
    if (!this.closed) {
      this.child.stdin.end();
    }
    this.settle();
  }

  /** SIGKILL: used by the ALD-055 criterion 3 test and by `dispose`. */
  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    try {
      this.child.kill(signal);
    } catch {
      // Already gone; `exit` has fired or will fire.
    }
  }

  /** Resolves once the child has exited. */
  async waitForExit(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => {
        resolve();
      });
    });
  }

  private settle(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cleanupCwd();
    this.closeHandler?.();
  }

  private cleanupCwd(): void {
    if (this.temporaryCwd === undefined) {
      return;
    }
    try {
      rmSync(this.temporaryCwd, { recursive: true, force: true });
    } catch {
      // A leftover empty temp directory is not worth failing a run over.
    }
  }
}
