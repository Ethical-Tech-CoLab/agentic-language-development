/**
 * The `frozen-llm` track's private memory (BACKLOG ALD-044;
 * SPECIFICATION.md §6.1, §6.2, §10.4, §11.4).
 *
 * SPEC §6.1 defines this track as a frozen model that "adapts only via private
 * memory/ledger", and §10.4 records its `weightUpdatePath` as `none`. This
 * module is that memory: an in-adapter episodic store over the adapter's *own*
 * ledger drafts — one record per inventory symbol, holding how often the Baby
 * emitted and received it, the co-occurrence counts between the symbol and the
 * object type codes it acted on, the outcome bits of those turns, a bounded
 * list of opaque evidence references, and the current hypothesis reference.
 *
 * Three properties are load-bearing:
 *
 * - **it is agent-native.** Every stored string is an inventory symbol id, a
 *   `hyp:<symbol>:<version>` reference, or an opaque `channel:`/`proposal:`
 *   hash. No prose, no attribute name, no model output — so the digest can go
 *   into the prompt and the summary into the exported policy without carrying
 *   anything SPEC §11.4 or §10.1 forbids;
 * - **it is bounded.** A run of any length keeps at most
 *   `maxTrackedSymbols` records, each with at most
 *   `maxEvidenceRefsPerSymbol` references, and the prompt digest carries at
 *   most `maxDigestEntries` of them. Eviction is deterministic, so two runs
 *   from the same seed hold the same memory;
 * - **it holds no reward.** The only outcome information stored is the
 *   approved nonverbal outcome bit both Babies receive (SPEC §8.1 step 7).
 *   `OutcomeEvent.reward` is never read by this track, whose configured
 *   `learningSignal` is `none`.
 */
import { roundAll, roundTo } from './game.js';
import type { MemoryDigest, MemoryDigestEntry } from './llm-client.js';

/** Decimals kept in the digest and the exported summary. */
export const MEMORY_DECIMALS = 6;

export interface FrozenLlmMemoryOptions {
  /** Number of distinct object type codes in this run's attribute space. */
  typeCount: number;
  /** Symbol records retained; default `64`. */
  maxTrackedSymbols?: number;
  /** Records placed in the prompt digest; default `12`. */
  maxDigestEntries?: number;
  /** Evidence references kept per symbol; default `3`. */
  maxEvidenceRefsPerSymbol?: number;
}

interface SymbolRecord {
  symbol: string;
  emitted: number;
  received: number;
  /** Co-occurrence counts, indexed by object type code. */
  counts: number[];
  /** Turns folded in for this symbol. */
  turns: number;
  /** Turns whose approved outcome bit was 1. */
  successes: number;
  evidenceRefs: string[];
  /** `-1` until the symbol has co-occurrence evidence. */
  argmaxTypeCode: number;
}

/** One turn's evidence about one symbol. */
export interface MemoryObservation {
  symbol: string;
  /** The object type code this Baby acted on; `-1` when it had none. */
  typeCode: number;
  /** The approved nonverbal outcome bit (SPEC §8.1 step 7). */
  successBit: number;
  /** Opaque reference to the turn's own evidence. */
  evidenceRef: string;
}

/** The exported, canonicalizable memory summary (`exportPolicy().memory`). */
export interface ExportedFrozenLlmMemory {
  version: 'frozen-llm-memory-v1';
  turns: number;
  symbols: {
    symbol: string;
    emitted: number;
    received: number;
    counts: number[];
    turns: number;
    successes: number;
    hypothesisRef: string | null;
    argmaxTypeCode: number;
    evidenceRefs: string[];
  }[];
}

/** Current hypothesis state for one symbol. */
export interface HypothesisState {
  hypothesisRef: string;
  version: number;
  argmaxTypeCode: number;
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export class FrozenLlmMemory {
  private readonly records = new Map<string, SymbolRecord>();
  /**
   * Hypothesis version per symbol, kept *outside* the evictable records.
   *
   * A `hypothesis.revised` event must name a `priorHypothesisRef` that
   * resolves (LEDGER §5), so the version counter cannot be dropped by the
   * co-occurrence bound: an evicted-then-reappearing symbol would otherwise
   * re-issue `hyp:<symbol>:1` for a second, different hypothesis. This map is
   * bounded by the declared inventory instead, which `RunConfig.
   * symbolInventorySize` caps at 256.
   */
  private readonly hypotheses = new Map<
    string,
    { version: number; argmaxTypeCode: number }
  >();
  private readonly typeCount: number;
  private readonly maxTrackedSymbols: number;
  private readonly maxDigestEntries: number;
  private readonly maxEvidenceRefsPerSymbol: number;
  private turnsFolded = 0;

  constructor(options: FrozenLlmMemoryOptions) {
    this.typeCount = options.typeCount;
    this.maxTrackedSymbols = options.maxTrackedSymbols ?? 64;
    this.maxDigestEntries = options.maxDigestEntries ?? 12;
    this.maxEvidenceRefsPerSymbol = options.maxEvidenceRefsPerSymbol ?? 3;
  }

  /** Turns folded into the memory so far. */
  get turns(): number {
    return this.turnsFolded;
  }

  /** Symbols currently tracked. */
  get size(): number {
    return this.records.size;
  }

  /** Count one emission of `symbol` (this Baby's own tool call). */
  noteEmitted(symbol: string): void {
    this.record(symbol).emitted += 1;
    this.evict();
  }

  /** Count one delivery of `symbol` to this Baby, with its channel evidence. */
  noteReceived(symbol: string, evidenceRef: string): void {
    const record = this.record(symbol);
    record.received += 1;
    this.addEvidence(record, evidenceRef);
    this.evict();
  }

  /**
   * Fold one completed turn's evidence in. Called from `onOutcome`, once per
   * turn per symbol, so a SPEC §14.5 retry that re-delivers the same outcome
   * does not double-count (the adapter drops the turn's buffer first).
   */
  fold(observations: readonly MemoryObservation[]): void {
    if (observations.length === 0) {
      return;
    }
    this.turnsFolded += 1;
    for (const observation of observations) {
      const record = this.record(observation.symbol);
      record.turns += 1;
      record.successes += observation.successBit === 1 ? 1 : 0;
      if (
        Number.isInteger(observation.typeCode) &&
        observation.typeCode >= 0 &&
        observation.typeCode < this.typeCount
      ) {
        record.counts[observation.typeCode] =
          (record.counts[observation.typeCode] ?? 0) + 1;
        record.argmaxTypeCode = argmaxOf(record.counts);
      }
      this.addEvidence(record, observation.evidenceRef);
    }
    this.evict();
  }

  /**
   * Normalized co-occurrence distribution over type codes for `symbol`.
   * Exactly uniform when the symbol carries no evidence yet — no evidence, no
   * preference, which is what an initially ungrounded mark means.
   */
  distributionFor(symbol: string): number[] {
    const record = this.records.get(symbol);
    const uniform = 1 / this.typeCount;
    if (record === undefined) {
      return new Array<number>(this.typeCount).fill(uniform);
    }
    const total = record.counts.reduce((sum, count) => sum + count, 0);
    if (total === 0) {
      return new Array<number>(this.typeCount).fill(uniform);
    }
    return record.counts.map((count) => count / total);
  }

  /**
   * Score each candidate under a delivered message: the mean, over the
   * delivered symbols, of the mass that symbol's memory puts on the
   * candidate's type code. Used for the `interpretation.recorded` draft.
   */
  scoreCandidates(
    symbols: readonly string[],
    candidateTypeCodes: readonly number[],
  ): number[] {
    if (symbols.length === 0 || candidateTypeCodes.length === 0) {
      return candidateTypeCodes.map(() => 0);
    }
    const distributions = symbols.map((symbol) => this.distributionFor(symbol));
    return candidateTypeCodes.map((typeCode) => {
      let total = 0;
      for (const distribution of distributions) {
        total += distribution[typeCode] ?? 0;
      }
      return total / distributions.length;
    });
  }

  hypothesisFor(symbol: string): HypothesisState | undefined {
    const state = this.hypotheses.get(symbol);
    if (state === undefined) {
      return undefined;
    }
    return {
      hypothesisRef: `hyp:${symbol}:${state.version}`,
      version: state.version,
      argmaxTypeCode: state.argmaxTypeCode,
    };
  }

  /**
   * Record that a `hypothesis.created`/`revised` event is now durable. It
   * creates no co-occurrence record: the counts are the evictable part, the
   * version counter is not.
   */
  setHypothesis(symbol: string, version: number, argmaxTypeCode: number): void {
    this.hypotheses.set(symbol, { version, argmaxTypeCode });
  }

  /** `hyp:<symbol>:<version>` for `symbol`, or `null`. */
  private hypothesisRefFor(symbol: string): string | null {
    const state = this.hypotheses.get(symbol);
    return state === undefined ? null : `hyp:${symbol}:${state.version}`;
  }

  /** Highest-mass type code for `symbol`, or `-1` without evidence. */
  argmaxTypeCodeFor(symbol: string): number {
    return this.records.get(symbol)?.argmaxTypeCode ?? -1;
  }

  /** Mass the memory puts on `argmaxTypeCodeFor(symbol)`; `0` without evidence. */
  confidenceFor(symbol: string): number {
    const argmax = this.argmaxTypeCodeFor(symbol);
    if (argmax < 0) {
      return 0;
    }
    return this.distributionFor(symbol)[argmax] ?? 0;
  }

  /**
   * The bounded prompt digest: the highest-evidence records first, ties broken
   * by symbol id so the digest — and therefore the prompt, and therefore a
   * greedy model's output — is a deterministic function of the memory.
   */
  digest(): MemoryDigest {
    const ordered = [...this.records.values()].sort(
      (left, right) =>
        right.turns - left.turns ||
        right.emitted + right.received - (left.emitted + left.received) ||
        compareStrings(left.symbol, right.symbol),
    );
    const entries: MemoryDigestEntry[] = ordered
      .slice(0, this.maxDigestEntries)
      .map((record) => this.digestEntry(record));
    return {
      version: 'frozen-llm-memory-v1',
      turns: this.turnsFolded,
      symbolsTracked: this.records.size,
      entries,
    };
  }

  /** The canonicalizable export: every tracked record, in symbol order. */
  snapshot(): ExportedFrozenLlmMemory {
    return {
      version: 'frozen-llm-memory-v1',
      turns: this.turnsFolded,
      symbols: [...this.records.values()]
        .sort((left, right) => compareStrings(left.symbol, right.symbol))
        .map((record) => ({
          symbol: record.symbol,
          emitted: record.emitted,
          received: record.received,
          counts: [...record.counts],
          turns: record.turns,
          successes: record.successes,
          hypothesisRef: this.hypothesisRefFor(record.symbol),
          argmaxTypeCode: record.argmaxTypeCode,
          evidenceRefs: [...record.evidenceRefs],
        })),
    };
  }

  private digestEntry(record: SymbolRecord): MemoryDigestEntry {
    const distribution = this.distributionFor(record.symbol);
    const argmax = record.argmaxTypeCode;
    return {
      symbol: record.symbol,
      emitted: record.emitted,
      received: record.received,
      typeCodeDistribution: roundAll(distribution, MEMORY_DECIMALS),
      argmaxTypeCode: argmax,
      confidence: roundTo(
        argmax < 0 ? 0 : (distribution[argmax] ?? 0),
        MEMORY_DECIMALS,
      ),
      successRate: roundTo(
        record.turns === 0 ? 0 : record.successes / record.turns,
        MEMORY_DECIMALS,
      ),
      evidenceRefs: [...record.evidenceRefs],
      hypothesisRef: this.hypothesisRefFor(record.symbol),
    };
  }

  private record(symbol: string): SymbolRecord {
    const existing = this.records.get(symbol);
    if (existing !== undefined) {
      return existing;
    }
    const created: SymbolRecord = {
      symbol,
      emitted: 0,
      received: 0,
      counts: new Array<number>(this.typeCount).fill(0),
      turns: 0,
      successes: 0,
      evidenceRefs: [],
      argmaxTypeCode: -1,
    };
    this.records.set(symbol, created);
    return created;
  }

  /** Newest references win, oldest are dropped: the bound is per symbol. */
  private addEvidence(record: SymbolRecord, evidenceRef: string): void {
    if (record.evidenceRefs.includes(evidenceRef)) {
      return;
    }
    record.evidenceRefs.push(evidenceRef);
    while (record.evidenceRefs.length > this.maxEvidenceRefsPerSymbol) {
      record.evidenceRefs.shift();
    }
  }

  /**
   * Deterministic eviction: the least-evidenced record goes first, ties broken
   * by the *highest* symbol id, so the surviving set depends only on the
   * evidence and never on insertion order.
   */
  private evict(): void {
    while (this.records.size > this.maxTrackedSymbols) {
      let victim: SymbolRecord | undefined;
      for (const record of this.records.values()) {
        if (victim === undefined) {
          victim = record;
          continue;
        }
        const victimWeight = victim.turns + victim.emitted + victim.received;
        const weight = record.turns + record.emitted + record.received;
        if (
          weight < victimWeight ||
          (weight === victimWeight &&
            compareStrings(record.symbol, victim.symbol) > 0)
        ) {
          victim = record;
        }
      }
      if (victim === undefined) {
        return;
      }
      this.records.delete(victim.symbol);
    }
  }
}

function argmaxOf(counts: readonly number[]): number {
  let best = -1;
  let bestValue = 0;
  counts.forEach((count, index) => {
    if (count > bestValue) {
      bestValue = count;
      best = index;
    }
  });
  return best;
}
