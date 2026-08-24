/**
 * Attempt one ingest-ticket claim from a SEPARATE OS PROCESS, and print the
 * answer.
 *
 * Spawned by `routes/podcastIngest.test.ts`. It exists because the property that
 * decides where the ticket's single-use state may live cannot be tested inside
 * the process that consumed it: a fresh connection, or even a fresh pool, still
 * shares every module-level variable, every closure and every cache with the
 * code that did the consuming. Only a different process shares nothing.
 *
 * This is the test of the choice recorded in `schema/podcasts.ts`: a nonce in
 * Redis would not survive an eviction, a failover or a deploy, and a nonce in
 * memory would not survive this script. What survives it is a committed row —
 * which is what the process below can see and this one cannot fake.
 *
 * Prints `CLAIM_RESULT=true` or `CLAIM_RESULT=false` on its own line. A MARKER
 * rather than the bare word, because `connectPostgres` logs to stdout too —
 * measured: the first version returned "…Connected to PostgreSQL successfully\ntrue"
 * and the assertion compared the log line.
 *
 * Usage: bun run src/test/claimIngestTicketOutOfProcess.ts <jti> <episodeId>
 */

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { claimIngestTicket } from '../db/podcasts/ingestTickets';

async function main(): Promise<void> {
  const [jti, episodeId] = process.argv.slice(2);
  if (!jti || !episodeId) {
    throw new Error('usage: claimIngestTicketOutOfProcess <jti> <episodeId>');
  }

  await connectPostgres();
  try {
    const claimed = await claimIngestTicket(getDb(), jti, episodeId);
    process.stdout.write(`\nCLAIM_RESULT=${claimed ? 'true' : 'false'}\n`);
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
