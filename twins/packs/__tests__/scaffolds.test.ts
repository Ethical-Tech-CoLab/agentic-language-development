import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import BabyAPack, {
  BABY_A_ROUTE_PATTERNS,
} from '../baby-a/behavior/pack.js';
import BabyBPack, {
  BABY_B_ROUTE_PATTERNS,
} from '../baby-b/behavior/pack.js';
import NurseryPack, {
  NURSERY_ROUTE_PATTERNS,
} from '../nursery/behavior/pack.js';
import type {
  BehaviorPack,
  BehaviorPackContext,
  TwinRequest,
} from '@ald/types';

interface TwinManifest {
  metadata: { name: string };
  behaviorPack: { entrypoint: string };
}

const packs = [
  {
    name: 'baby-a',
    Pack: BabyAPack,
    routePatterns: BABY_A_ROUTE_PATTERNS,
  },
  {
    name: 'baby-b',
    Pack: BabyBPack,
    routePatterns: BABY_B_ROUTE_PATTERNS,
  },
  {
    name: 'nursery',
    Pack: NurseryPack,
    routePatterns: NURSERY_ROUTE_PATTERNS,
  },
] as const;

function emulateDtsfDispatch(
  externalPath: string,
): { twinName: string; wildcard: string; request: TwinRequest } {
  const [twinName, ...pathParts] = externalPath.split('/').filter(Boolean);
  if (!twinName || pathParts.length === 0) {
    throw new Error(`Invalid DTSF external path: ${externalPath}`);
  }

  const wildcard = pathParts.join('/');
  return {
    twinName,
    wildcard,
    request: {
      method: 'GET',
      path: `/${wildcard}`,
      headers: {},
      query: {},
      body: undefined,
    },
  };
}

async function initialize(pack: BehaviorPack, twinName: string): Promise<void> {
  const state = new Map<string, unknown>();
  const context: BehaviorPackContext = {
    twinName,
    seed: 1,
    state,
  };
  await pack.init(context);
}

describe('DTSF twin pack scaffolds', () => {
  it.each(packs)('loads the $name manifest and pack', async ({ name, Pack }) => {
    const manifestPath = fileURLToPath(
      new URL(`../${name}/twin.yaml`, import.meta.url),
    );
    const manifest = parse(
      await readFile(manifestPath, 'utf8'),
    ) as TwinManifest;
    const pack = new Pack();

    await initialize(pack, name);

    expect(manifest.metadata.name).toBe(name);
    expect(manifest.behaviorPack.entrypoint).toBe('./behavior/pack.ts');
    expect(pack.describeCapabilities()).toContain('scaffold');
  });

  it.each(packs)(
    'registers only unprefixed $name routes',
    ({ name, routePatterns }) => {
      expect(routePatterns.length).toBeGreaterThan(0);
      for (const pattern of routePatterns) {
        expect(pattern.startsWith('/')).toBe(true);
        expect(pattern.startsWith(`/${name}`)).toBe(false);
      }
    },
  );

  it.each(packs)(
    'dispatches /$name/placeholder as an unprefixed handler path',
    async ({ name, Pack }) => {
      const dispatch = emulateDtsfDispatch(`/${name}/placeholder`);
      const pack = new Pack();
      await initialize(pack, name);

      const result = await pack.handleRequest(dispatch.request, new Map());

      expect(dispatch.twinName).toBe(name);
      expect(dispatch.wildcard).toBe('placeholder');
      expect(dispatch.request.path).toBe('/placeholder');
      expect(result.response.status).toBe(501);
    },
  );
});
