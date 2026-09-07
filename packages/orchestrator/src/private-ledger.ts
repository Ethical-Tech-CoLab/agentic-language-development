/**
 * The `append_private_ledger_entry` tool seam (SPEC §6.3, §12.7).
 *
 * A learner adapter never receives the Evidence Writer. It receives one of
 * these clients, bound at `init` to its own authenticated Baby identity and
 * to the runtime's current-turn getter, so a Baby can neither address the
 * other Baby's ledger nor backdate an event to another turn (SPEC §4.2 trust
 * boundary; §8.2 "the Gateway authenticates the receiver identity").
 */
import type {
  BabyId,
  EvidenceWriter,
  LedgerEvent,
  LedgerEventDraft,
  PrivateLedgerClient,
  Sha256Hash,
} from '@ald/types';

export class RuntimePrivateLedgerClient implements PrivateLedgerClient {
  constructor(
    private readonly writer: EvidenceWriter,
    private readonly runId: string,
    private readonly babyId: BabyId,
    /** Read at call time: the turn the Nursery Controller is executing. */
    private readonly currentTurn: () => number,
  ) {}

  append(
    draft: LedgerEventDraft,
    options?: { channelEventHash?: Sha256Hash },
  ): Promise<LedgerEvent> {
    const channelEventHash = options?.channelEventHash;
    return this.writer.appendLedgerEvent({
      runId: this.runId,
      babyId: this.babyId,
      turn: this.currentTurn(),
      draft,
      ...(channelEventHash === undefined ? {} : { channelEventHash }),
    });
  }
}
