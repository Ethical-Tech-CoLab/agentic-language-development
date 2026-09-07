/**
 * Protocol-module contract and registry (SPECIFICATION.md §9.1-§9.3,
 * ALD-030, ALD-034 criterion 3).
 *
 * The Gateway core knows nothing about symbols, strokes, or affect displays:
 * it routes, applies the §9.6 communication control, and commits evidence. A
 * carrier module owns exactly one `carrierMode` and answers three questions —
 * which proposal kinds it offers, whether a raw proposal is admissible, and
 * how to synthesise a valid artifact for the `constant` and `random`
 * controls. Registering the later ALD-031/ALD-033 modules therefore cannot
 * change the rejection event shape or the pause policy, which is what
 * ALD-034 criterion 3 requires.
 *
 * Modules see the *raw* proposal, not a zod-parsed one, because unknown-key
 * detection has to happen before a schema strips them (§11.3).
 */
import type { AgentActionProposal, GatewayRunContext, RunConfig } from '@ald/types';
import type { SeededPrng } from '@ald/hashing';

import { UnsupportedCarrierError } from './errors.js';
import { containsString, isPlainObject } from './inspect.js';
import type { GatewayReasonCode } from './reason-codes.js';

export type PublicArtifact = AgentActionProposal['publicArtifact'];
export type ActionKind = AgentActionProposal['kind'];

/** SPEC §9.1: the Gateway ceiling on message length, regardless of configuration. */
export const ABSOLUTE_MAX_SYMBOLS_PER_MESSAGE = 16;
/** SPEC §9.1 default `maxSymbolsPerMessage`. */
export const DEFAULT_MAX_SYMBOLS_PER_MESSAGE = 4;
/** SPEC §9.1 default `maxSymbolRepeats` (consecutive identical symbols). */
export const DEFAULT_MAX_SYMBOL_REPEATS = 3;

/** Effective length cap: the configured value clamped to the §9.1 ceiling. */
export function maxSymbolsFor(config: RunConfig): number {
  return Math.min(
    config.maxSymbolsPerMessage ?? DEFAULT_MAX_SYMBOLS_PER_MESSAGE,
    ABSOLUTE_MAX_SYMBOLS_PER_MESSAGE,
  );
}

/** Run-scoped inputs a module needs; it holds no per-run state of its own. */
export interface CarrierContext {
  readonly runContext: GatewayRunContext;
  readonly maxSymbolRepeats: number;
}

export type CarrierValidationResult =
  | { ok: true; artifact: PublicArtifact }
  | { ok: false; reasonCode: GatewayReasonCode; detail: string };

export interface CarrierModule {
  readonly carrier: RunConfig['carrierMode'];
  readonly allowedKinds: readonly ActionKind[];
  /**
   * Validates a raw `{ kind, publicArtifact }` object. `kind` membership is
   * checked by the Gateway before this call; a module only judges the
   * artifact and any unexpected proposal-level fields. On success it returns
   * the normalized artifact that will be hashed and delivered.
   *
   * `detail` is an internal diagnostic: it MUST NOT contain any part of the
   * submitted payload (SPEC §9.4).
   */
  validate(proposal: unknown, context: CarrierContext): CarrierValidationResult;
  /** SPEC §9.6 `random`: a valid artifact drawn from a seeded stream. */
  randomArtifact(prng: SeededPrng, context: CarrierContext): PublicArtifact;
  /** SPEC §9.6 `constant`: the module's default pre-registered artifact. */
  constantArtifact(context: CarrierContext): PublicArtifact;
}

function fail(
  reasonCode: GatewayReasonCode,
  detail: string,
): CarrierValidationResult {
  return { ok: false, reasonCode, detail };
}

/**
 * An extra field is a free-text carrier when it holds a string anywhere, and
 * a plain schema violation otherwise (SPEC §9.1: "any accompanying free
 * text ... is rejected").
 */
function extraFieldFailure(
  container: Record<string, unknown>,
  extraKeys: readonly string[],
  where: string,
): CarrierValidationResult {
  const carriesText = extraKeys.some((key) => containsString(container[key]));
  return fail(
    carriesText ? 'free-text-present' : 'unexpected-artifact-field',
    `${where} has ${extraKeys.length} unexpected field(s)`,
  );
}

/**
 * Shape of a bare inventory token: one to three letters followed by one to
 * three digits (`S01`, `S256`, `G07`). Applied only to symbols that are *not*
 * in the declared inventory, so a run may declare any inventory it likes and
 * the allowlist stays the primary control (SPEC §9.1, resolves Q6). A
 * non-inventory string that does not even have token shape — prose, a URL,
 * padded whitespace, Unicode look-alikes — is reported as free text rather
 * than as an allowlist miss.
 */
const BARE_TOKEN_PATTERN = /^[A-Za-z]{1,3}[0-9]{1,3}$/u;

function trailingRepeats(symbols: readonly string[], candidate: string): number {
  let count = 0;
  for (let index = symbols.length - 1; index >= 0; index -= 1) {
    if (symbols[index] !== candidate) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * SPEC §9.1 fixed-token protocol (ALD-030). The default and only carrier
 * registered out of the box.
 *
 * Validation order is fixed so the reason code for a given payload is
 * deterministic: proposal fields, artifact fields, `symbols` shape, length,
 * allowlist/free-text per symbol, then consecutive repeats.
 */
export const fixedTokenModule: CarrierModule = {
  carrier: 'fixed-token',
  allowedKinds: ['emit_symbols'],

  validate(proposal, context) {
    if (!isPlainObject(proposal)) {
      return fail('invalid-envelope', 'proposal is not an object');
    }

    const extraProposalKeys = Object.keys(proposal).filter(
      (key) => key !== 'kind' && key !== 'publicArtifact',
    );
    if (extraProposalKeys.length > 0) {
      return extraFieldFailure(proposal, extraProposalKeys, 'proposal');
    }

    const artifact = proposal.publicArtifact;
    if (!isPlainObject(artifact)) {
      return fail('invalid-envelope', 'publicArtifact is not an object');
    }

    const extraArtifactKeys = Object.keys(artifact).filter(
      (key) => key !== 'symbols',
    );
    if (extraArtifactKeys.length > 0) {
      return extraFieldFailure(artifact, extraArtifactKeys, 'publicArtifact');
    }

    const symbols = artifact.symbols;
    if (!Array.isArray(symbols)) {
      return fail('invalid-envelope', 'publicArtifact.symbols is not an array');
    }
    if (symbols.length === 0) {
      return fail('empty-message', 'publicArtifact.symbols is empty');
    }

    const cap = maxSymbolsFor(context.runContext.config);
    if (symbols.length > cap) {
      return fail(
        'message-too-long',
        `message carries ${symbols.length} symbols; the cap is ${cap}`,
      );
    }

    const inventory = new Set(context.runContext.symbolInventory);
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol: unknown = symbols[index];
      if (typeof symbol !== 'string') {
        return fail('invalid-envelope', `symbol at index ${index} is not a string`);
      }
      if (inventory.has(symbol)) {
        continue;
      }
      if (!BARE_TOKEN_PATTERN.test(symbol)) {
        return fail(
          'free-text-present',
          `symbol at index ${index} is not a bare inventory token`,
        );
      }
      return fail(
        'symbol-not-in-inventory',
        `symbol at index ${index} is not in the declared inventory`,
      );
    }

    const accepted = symbols as string[];
    let run = 1;
    for (let index = 1; index < accepted.length; index += 1) {
      run = accepted[index] === accepted[index - 1] ? run + 1 : 1;
      if (run > context.maxSymbolRepeats) {
        return fail(
          'symbol-repeat-limit',
          `more than ${context.maxSymbolRepeats} consecutive identical symbols ending at index ${index}`,
        );
      }
    }

    return { ok: true, artifact: { symbols: [...accepted] } };
  },

  /**
   * Uniform length in `[1, maxSymbolsPerMessage]` and uniform symbols, with
   * candidates that would break the consecutive-repeat limit resampled so the
   * result is always an artifact the same module accepts. Length is drawn
   * first, then one symbol per position, so the stream stays comparable across
   * runs that share a seed but differ in inventory size (RESEARCH.md
   * Appendix D.5 condition 3).
   */
  randomArtifact(prng, context) {
    const inventory = context.runContext.symbolInventory;
    const cap = maxSymbolsFor(context.runContext.config);
    const length = 1 + prng.nextInt(cap);
    const symbols: string[] = [];
    while (symbols.length < length) {
      const candidate = inventory[prng.nextInt(inventory.length)] as string;
      if (trailingRepeats(symbols, candidate) >= context.maxSymbolRepeats) {
        continue;
      }
      symbols.push(candidate);
    }
    return { symbols };
  },

  /** The first inventory symbol, unless the run pre-registers another artifact. */
  constantArtifact(context) {
    return { symbols: [context.runContext.symbolInventory[0] as string] };
  },
};

const BUILT_IN_MODULES: readonly CarrierModule[] = [fixedTokenModule];

const modules = new Map<RunConfig['carrierMode'], CarrierModule>(
  BUILT_IN_MODULES.map((module) => [module.carrier, module]),
);

/**
 * Registers a protocol module for its carrier, replacing any previous
 * registration. ALD-031/ALD-033 modules register here; nothing else in the
 * Gateway changes.
 */
export function registerCarrierModule(module: CarrierModule): void {
  modules.set(module.carrier, module);
}

/** The module for `carrier`, or {@link UnsupportedCarrierError}. */
export function carrierModule(
  carrier: RunConfig['carrierMode'],
): CarrierModule {
  const module = modules.get(carrier);
  if (!module) {
    throw new UnsupportedCarrierError(carrier);
  }
  return module;
}

export function registeredCarriers(): RunConfig['carrierMode'][] {
  return [...modules.keys()].sort();
}

/** Test helper: drop every registration and restore the built-in modules. */
export function resetCarrierModules(): void {
  modules.clear();
  for (const module of BUILT_IN_MODULES) {
    modules.set(module.carrier, module);
  }
}
