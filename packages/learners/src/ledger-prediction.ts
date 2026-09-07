/**
 * Ledger-to-prediction functions for the tabular `scratch-rl` track
 * (RESEARCH.md §6.8).
 *
 * Before a confirmatory run, each track must provide a versioned
 * ledger-to-prediction function at a locked code commit that converts ledger
 * state and an intervention into a directional prediction *without observing
 * the intervention outcome*. These functions are that artifact for the tabular
 * track: they are pure, deterministic, and read nothing but an exported policy
 * checkpoint — the same agent-native state the adapter's `intention.recorded`
 * and `interpretation.recorded` events summarize. They perform no sampling, so
 * they return the policy's argmax rather than the action the adapter would
 * draw from its private PRNG.
 */
import { LearnerStateError } from './errors.js';
import { argmaxIndex, roundAll, softmax } from './game.js';
import {
  POLICY_DECIMALS,
  parseExportedTabularPolicy,
  tabularPolicyShape,
} from './policy.js';

export interface ReceiverChoicePrediction {
  /** Index into `candidateTypeCodes` the policy scores highest. */
  index: number;
  /** Softmax distribution over the candidates, rounded for stability. */
  distribution: number[];
}

export interface SenderSymbolPrediction {
  index: number;
  symbol: string;
  distribution: number[];
}

function symbolIndexOf(
  symbol: string,
  symbolInventory: readonly string[],
  symbolCount: number,
): number {
  const index = symbolInventory.indexOf(symbol);
  if (index < 0) {
    throw new LearnerStateError(`Symbol ${symbol} is not in the inventory`);
  }
  if (index >= symbolCount) {
    throw new LearnerStateError(
      `Symbol ${symbol} is outside the policy's symbol table`,
    );
  }
  return index;
}

/**
 * Deterministic prediction of which candidate the receiver policy prefers,
 * given the received symbols and the candidates' type codes in the receiver's
 * own candidate order. Ties resolve to the lowest index.
 */
export function predictReceiverChoice(
  policy: unknown,
  symbols: readonly string[],
  symbolInventory: readonly string[],
  candidateTypeCodes: readonly number[],
): ReceiverChoicePrediction {
  const parsed = parseExportedTabularPolicy(policy);
  const shape = tabularPolicyShape(parsed);

  if (symbols.length !== shape.messageLength) {
    throw new LearnerStateError(
      `Expected ${shape.messageLength} symbol(s), received ${symbols.length}`,
    );
  }
  if (candidateTypeCodes.length === 0) {
    throw new LearnerStateError('candidateTypeCodes must not be empty');
  }

  const scores = candidateTypeCodes.map((typeCode) => {
    if (!Number.isInteger(typeCode) || typeCode < 0 || typeCode >= shape.typeCount) {
      throw new LearnerStateError(
        `Type code ${typeCode} is outside [0, ${shape.typeCount})`,
      );
    }
    let score = 0;
    symbols.forEach((symbol, position) => {
      const symbolIndex = symbolIndexOf(symbol, symbolInventory, shape.symbolCount);
      const table = parsed.thetaReceiver[position] as number[][];
      score += (table[symbolIndex] as number[])[typeCode] as number;
    });
    return score;
  });

  const distribution = softmax(scores, parsed.options.temperature);
  return {
    index: argmaxIndex(scores),
    distribution: roundAll(distribution, POLICY_DECIMALS),
  };
}

/**
 * Deterministic prediction of which symbol the sender policy prefers for a
 * given object type code.
 */
export function predictSenderSymbol(
  policy: unknown,
  typeCode: number,
  symbolInventory: readonly string[],
): SenderSymbolPrediction {
  const parsed = parseExportedTabularPolicy(policy);
  const shape = tabularPolicyShape(parsed);

  if (!Number.isInteger(typeCode) || typeCode < 0 || typeCode >= shape.typeCount) {
    throw new LearnerStateError(
      `Type code ${typeCode} is outside [0, ${shape.typeCount})`,
    );
  }
  if (symbolInventory.length < shape.symbolCount) {
    throw new LearnerStateError(
      'symbolInventory is smaller than the policy symbol table',
    );
  }

  const logits = parsed.thetaSender[typeCode] as number[];
  const distribution = softmax(logits, parsed.options.temperature);
  const index = argmaxIndex(logits);
  return {
    index,
    symbol: symbolInventory[index] as string,
    distribution: roundAll(distribution, POLICY_DECIMALS),
  };
}
