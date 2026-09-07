/**
 * Referential-game arithmetic and fixed-token turn-protocol helpers shared by
 * every learner track.
 *
 * The observation format is the numeric-only encoding required by SPEC §10.1
 * and §11.2: `Observation.payload` is a matrix of rows, one row per candidate
 * object, in that recipient's private order. A sender row carries the
 * attribute codes plus a trailing target flag; a receiver row carries the
 * attribute codes only, and `TurnBudget.candidateRefs` supplies the opaque
 * `objectRef` for each row in the same order. Nothing in a row is a label:
 * attribute codes are opaque integers.
 */
import type {
  DeliveredChannelArtifact,
  TurnBudget,
} from '@ald/types';

import { LearnerConfigurationError, LearnerStateError } from './errors.js';

/** One recipient's private view of an episode's candidate objects. */
export interface ParsedObservation {
  /** Attribute-code rows in this recipient's own candidate order. */
  candidates: number[][];
  /** Derived type code per candidate row. */
  typeCodes: number[];
  /** Index of the target row, or `null` for a receiver view. */
  targetIndex: number | null;
  /** `'sender'` when the payload carried a target flag column. */
  view: 'sender' | 'receiver';
}

/**
 * Positional encoding of an attribute vector into a single object type code:
 * `sum(code_i * valuesPerAttribute^(k-1-i))`. Derived generically from the row
 * so the same adapters work for any `attributeCount`/`valuesPerAttribute`.
 */
export function typeCodeFromAttributes(
  codes: readonly number[],
  valuesPerAttribute: number,
): number {
  if (codes.length === 0) {
    throw new LearnerStateError('An attribute vector must have at least one code');
  }
  let code = 0;
  for (const value of codes) {
    if (!Number.isInteger(value) || value < 0 || value >= valuesPerAttribute) {
      throw new LearnerStateError(
        `Attribute code ${value} is outside [0, ${valuesPerAttribute})`,
      );
    }
    code = code * valuesPerAttribute + value;
  }
  return code;
}

/** Total number of distinct object type codes for this attribute space. */
export function typeCodeCount(
  attributeCount: number,
  valuesPerAttribute: number,
): number {
  return valuesPerAttribute ** attributeCount;
}

/**
 * Parse an `Observation.payload` into the adapter's private view. The column
 * count decides the view: `attributeCount + 1` columns is a sender view whose
 * last column is the target flag, `attributeCount` columns is a receiver view.
 */
export function parseObservationPayload(
  payload: number[] | number[][],
  attributeCount: number,
  valuesPerAttribute: number,
): ParsedObservation {
  const rows = payload as unknown[];
  if (rows.length === 0 || !Array.isArray(rows[0])) {
    throw new LearnerStateError(
      'Observation payload must be a non-empty matrix of candidate rows',
    );
  }

  const matrix = payload as number[][];
  const columns = (matrix[0] as number[]).length;
  let view: 'sender' | 'receiver';
  if (columns === attributeCount + 1) {
    view = 'sender';
  } else if (columns === attributeCount) {
    view = 'receiver';
  } else {
    throw new LearnerStateError(
      `Observation rows have ${columns} columns; expected ${attributeCount} or ${attributeCount + 1}`,
    );
  }

  const candidates: number[][] = [];
  const typeCodes: number[] = [];
  let targetIndex: number | null = null;

  matrix.forEach((row, index) => {
    if (row.length !== columns) {
      throw new LearnerStateError('Observation rows must all have the same width');
    }
    const attributes = row.slice(0, attributeCount);
    candidates.push(attributes);
    typeCodes.push(typeCodeFromAttributes(attributes, valuesPerAttribute));
    if (view === 'sender' && row[attributeCount] === 1) {
      if (targetIndex !== null) {
        throw new LearnerStateError('A sender observation must have one target row');
      }
      targetIndex = index;
    }
  });

  return { candidates, typeCodes, targetIndex, view };
}

/** Numerically stable softmax over `logits / temperature`. */
export function softmax(logits: readonly number[], temperature: number): number[] {
  if (!(temperature > 0)) {
    throw new LearnerConfigurationError('temperature must be a positive number');
  }
  let max = Number.NEGATIVE_INFINITY;
  for (const logit of logits) {
    const scaled = logit / temperature;
    if (scaled > max) {
      max = scaled;
    }
  }
  const weights = logits.map((logit) => Math.exp(logit / temperature - max));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

/** Round to `decimals` places so canonical JSON of a policy is stable. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundAll(values: readonly number[], decimals: number): number[] {
  return values.map((value) => roundTo(value, decimals));
}

export function roundMatrix(
  values: readonly number[][],
  decimals: number,
): number[][] {
  return values.map((row) => roundAll(row, decimals));
}

/** Lowest index holding the maximum value; `-1` for an empty list. */
export function argmaxIndex(values: readonly number[]): number {
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  values.forEach((value, index) => {
    if (value > bestValue) {
      bestValue = value;
      best = index;
    }
  });
  return best;
}

/** `rows x columns` matrix of zeros. */
export function zeroMatrix(rows: number, columns: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
}

/** Shape of the referential game an adapter is configured for. */
export interface GameShapeOptions {
  /** Distinct values each attribute may take (default `4`). */
  valuesPerAttribute?: number;
  /** Number of attributes per object (default `2`). */
  attributeCount?: number;
  /**
   * Symbols per message. E11's naming stage uses exactly one symbol, so the
   * default is `1`; it may never exceed `RunConfig.maxSymbolsPerMessage`
   * (SPEC §9.1).
   */
  messageLength?: number;
}

export interface ResolvedGameShape {
  valuesPerAttribute: number;
  attributeCount: number;
  messageLength: number;
  typeCount: number;
}

/**
 * Resolve the game shape from factory options, validating it against the run
 * configuration's protocol limits (SPEC §9.1). `attributeCount` and
 * `valuesPerAttribute` are not `RunConfig` fields — they belong to the
 * Scenario Engine's frozen bundle — so they arrive as factory options and are
 * recorded in the exported policy for reproducibility.
 */
export function resolveGameShape(
  options: GameShapeOptions,
  maxSymbolsPerMessage: number | undefined,
): ResolvedGameShape {
  const valuesPerAttribute = options.valuesPerAttribute ?? 4;
  const attributeCount = options.attributeCount ?? 2;
  const messageLength = options.messageLength ?? 1;

  for (const [name, value] of [
    ['valuesPerAttribute', valuesPerAttribute],
    ['attributeCount', attributeCount],
    ['messageLength', messageLength],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new LearnerConfigurationError(`${name} must be a positive integer`);
    }
  }

  if (maxSymbolsPerMessage !== undefined && messageLength > maxSymbolsPerMessage) {
    throw new LearnerConfigurationError(
      `messageLength ${messageLength} exceeds maxSymbolsPerMessage ${maxSymbolsPerMessage}`,
    );
  }

  return {
    valuesPerAttribute,
    attributeCount,
    messageLength,
    typeCount: typeCodeCount(attributeCount, valuesPerAttribute),
  };
}

/**
 * Inverse of `typeCodeFromAttributes`: the positional attribute vector for a
 * type code. Used by scenario generators and by the conformance harness.
 */
export function attributesFromTypeCode(
  typeCode: number,
  attributeCount: number,
  valuesPerAttribute: number,
): number[] {
  if (
    !Number.isInteger(typeCode) ||
    typeCode < 0 ||
    typeCode >= typeCodeCount(attributeCount, valuesPerAttribute)
  ) {
    throw new LearnerConfigurationError(
      `Type code ${typeCode} is outside the attribute space`,
    );
  }
  const codes = new Array<number>(attributeCount).fill(0);
  let remaining = typeCode;
  for (let index = attributeCount - 1; index >= 0; index -= 1) {
    codes[index] = remaining % valuesPerAttribute;
    remaining = Math.floor(remaining / valuesPerAttribute);
  }
  return codes;
}

/**
 * SPEC §6.3: a Baby may act only through the tools the runtime offers it on
 * this turn. Exactly one carrier family is available per run, and a task tool
 * only in the role that may use it.
 */
export function requireAction(
  turnBudget: TurnBudget,
  kind: 'emit_symbols' | 'select_object',
): void {
  if (!turnBudget.availableActions.includes(kind)) {
    throw new LearnerStateError(
      `Action ${kind} is not available on turn ${turnBudget.turn}`,
    );
  }
}

/** Read the symbol list out of a delivered fixed-token artifact (SPEC §9.1). */
export function extractSymbols(delivery: DeliveredChannelArtifact): string[] {
  const symbols = (delivery.publicArtifact as { symbols?: unknown }).symbols;
  if (
    !Array.isArray(symbols) ||
    symbols.length === 0 ||
    symbols.some((symbol) => typeof symbol !== 'string' || symbol.length === 0)
  ) {
    throw new LearnerStateError(
      'A delivered fixed-token artifact must carry a non-empty symbols array',
    );
  }
  return symbols as string[];
}
