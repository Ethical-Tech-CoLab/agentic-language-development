/**
 * ALD-011 crash harness child. Registers one run and commits turns in a tight
 * loop until the parent SIGKILLs it, so the parent can prove the WAL store
 * recovers to a consistent last-committed state with no torn turn.
 *
 * Run as: node --import tsx crash-writer.ts <database-path>
 */
import { InMemorySignerRegistry } from '@ald/hashing';

import { openEvidenceDatabase } from '../../src/database.js';
import { SqliteEvidenceWriter } from '../../src/writer.js';
import { intentionDraft, proposal, runConfig } from './support.js';

async function main(): Promise<void> {
  const databasePath = process.argv[2];
  if (databasePath === undefined) {
    throw new Error('usage: crash-writer.ts <database-path>');
  }

  const config = runConfig();
  const evidence = openEvidenceDatabase(databasePath);
  const writer = new SqliteEvidenceWriter({
    database: evidence,
    signers: InMemorySignerRegistry.generate(config.runId),
  });
  writer.registerRun(config);

  // Signal readiness only after the first turn is committed, so every trial
  // kills the child in the middle of the commit loop rather than before it.
  for (let turn = 1; turn <= 10_000; turn += 1) {
    await writer.commitTurn({
      runId: config.runId,
      turn,
      sender: 'baby-a',
      recipient: 'baby-b',
      carrier: 'fixed-token',
      communicationCondition: 'normal',
      proposal,
      intentionDraft: intentionDraft({ blindingNonce: `nonce-${turn}` }),
      deliveredArtifact: proposal.publicArtifact,
    });
    if (turn === 1) {
      process.stdout.write('ready\n');
    }
  }

  evidence.close();
}

await main();
