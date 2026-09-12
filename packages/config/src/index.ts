export type DeploymentMode = 'prototype' | 'research-grade';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeEnvironment {
  dtsfPort: number;
  twinPacksDir: string;
  deploymentMode: DeploymentMode;
  evidenceDir: string;
  databasePath: string;
  signerSeedsFile?: string;
  logLevel: LogLevel;
  anchorClass: 'simulated' | 'public-chain';
  baseNetwork: 'base-sepolia' | 'base-mainnet';
  baseRpcUrlFile?: string;
  anchorKeyFile?: string;
}

type EnvironmentSource = Record<string, string | undefined>;

function parseInteger(
  source: EnvironmentSource,
  name: string,
  defaultValue: number,
): number {
  const value = source[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseEnum<const T extends readonly string[]>(
  source: EnvironmentSource,
  name: string,
  values: T,
  defaultValue: T[number],
): T[number] {
  const value = source[name] ?? defaultValue;
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }

  return value;
}

function requireValue(source: EnvironmentSource, name: string): string {
  const value = source[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required in research-grade mode`);
  }
  return value;
}

export function loadRuntimeEnvironment(
  source: EnvironmentSource = process.env,
): RuntimeEnvironment {
  for (const forbidden of [
    'ALD_RUN_SIGNER_SEEDS_JSON',
    'ALD_BASE_RPC_URL',
    'ALD_ANCHOR_KEY',
  ]) {
    if (source[forbidden] !== undefined) {
      throw new Error(
        `${forbidden} is a direct secret value; use si fort --mode files`,
      );
    }
  }
  const deploymentMode = parseEnum(
    source,
    'ALD_DEPLOYMENT_MODE',
    ['prototype', 'research-grade'] as const,
    'prototype',
  );
  const evidenceDir = source.ALD_EVIDENCE_DIR ?? './evidence';
  const signerSeedsFile =
    deploymentMode === 'research-grade'
      ? requireValue(source, 'ALD_RUN_SIGNER_SEEDS_JSON_FILE')
      : source.ALD_RUN_SIGNER_SEEDS_JSON_FILE;

  return {
    dtsfPort: parseInteger(source, 'DTSF_PORT', 8080),
    twinPacksDir: source.DTSF_TWIN_PACKS_DIR ?? './twins/packs',
    deploymentMode,
    evidenceDir,
    databasePath: source.ALD_DATABASE_PATH ?? `${evidenceDir}/ald.sqlite`,
    signerSeedsFile,
    logLevel: parseEnum(
      source,
      'ALD_LOG_LEVEL',
      ['debug', 'info', 'warn', 'error'] as const,
      'info',
    ),
    anchorClass: parseEnum(
      source,
      'ALD_ANCHOR_CLASS',
      ['simulated', 'public-chain'] as const,
      'simulated',
    ),
    baseNetwork: parseEnum(
      source,
      'ALD_BASE_NETWORK',
      ['base-sepolia', 'base-mainnet'] as const,
      'base-sepolia',
    ),
    baseRpcUrlFile: source.ALD_BASE_RPC_URL_FILE || undefined,
    anchorKeyFile: source.ALD_ANCHOR_KEY_FILE || undefined,
  };
}
