import { HASH_DOMAINS } from '@ald/types';

import { sha256Bytes, uint64BE } from './sha256.js';

/**
 * Deterministic, dependency-free PRNG: SHA-256 in counter mode over a
 * domain-separated key derived from a string seed. Every consumer that needs
 * randomness (scenario generation, gateway control substitution, learner
 * sampling) derives its own labeled stream so runs replay exactly from
 * `RunConfig.randomSeed` (SPEC §14.3).
 *
 * Not a cryptographic RNG for key material; keys use `node:crypto`.
 */
export class SeededPrng {
  private readonly key: Buffer;
  private counter = 0;
  private block: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(public readonly seed: string) {
    this.key = sha256Bytes(
      Buffer.from(HASH_DOMAINS.seed, 'utf8'),
      Buffer.from([0]),
      Buffer.from(seed, 'utf8'),
    );
  }

  /** Independent child stream; the same label always yields the same stream. */
  derive(label: string): SeededPrng {
    return new SeededPrng(`${this.key.toString('hex')}/${label}`);
  }

  private refill(): void {
    this.block = sha256Bytes(this.key, uint64BE(this.counter));
    this.counter += 1;
    this.offset = 0;
  }

  nextUint32(): number {
    if (this.offset + 4 > this.block.length) {
      this.refill();
    }
    const value = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  /** Uniform float in [0, 1) with 53 bits of precision. */
  nextFloat(): number {
    const high = this.nextUint32() >>> 5;
    const low = this.nextUint32() >>> 6;
    return (high * 67108864 + low) / 9007199254740992;
  }

  /** Uniform integer in [0, maxExclusive) by rejection sampling. */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error('maxExclusive must be a positive integer');
    }
    const range = 0x1_0000_0000;
    const limit = range - (range % maxExclusive);
    let value = this.nextUint32();
    while (value >= limit) {
      value = this.nextUint32();
    }
    return value % maxExclusive;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from an empty list');
    }
    return items[this.nextInt(items.length)] as T;
  }

  /** Fisher-Yates shuffle of a copy; the input is not mutated. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = this.nextInt(index + 1);
      const held = copy[index] as T;
      copy[index] = copy[swap] as T;
      copy[swap] = held;
    }
    return copy;
  }

  /** Sample an index proportionally to non-negative weights. */
  sampleIndex(weights: readonly number[]): number {
    let total = 0;
    for (const weight of weights) {
      if (!(weight >= 0)) {
        throw new Error('weights must be non-negative numbers');
      }
      total += weight;
    }
    if (total <= 0) {
      return this.nextInt(weights.length);
    }
    let threshold = this.nextFloat() * total;
    for (let index = 0; index < weights.length; index += 1) {
      threshold -= weights[index] as number;
      if (threshold < 0) {
        return index;
      }
    }
    return weights.length - 1;
  }
}

/**
 * RESEARCH.md Appendix D seed derivation: lowercase hex SHA-256 of the parts
 * joined by a single 0x00 byte, e.g. `deriveSeedHex('ald-e03-v1', '7')`.
 */
export function deriveSeedHex(...parts: string[]): string {
  const buffers: Buffer[] = [];
  parts.forEach((part, index) => {
    if (index > 0) {
      buffers.push(Buffer.from([0]));
    }
    buffers.push(Buffer.from(part, 'utf8'));
  });
  return sha256Bytes(...buffers).toString('hex');
}
