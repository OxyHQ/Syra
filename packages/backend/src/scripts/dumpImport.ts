/**
 * The shared machinery behind every catalogue-dump import.
 *
 * Three importers read three different CC0 dumps — the MusicBrainz ISRC slice,
 * the MusicBrainz artist slice, the Discogs releases — and all three need the
 * same four things: a streaming reader for PostgreSQL `COPY` text, memory that
 * scales to tens of millions of rows, a checkpoint that survives an interrupted
 * run, and a CLI that refuses to resume against the wrong dump. This is that,
 * once, so the three stay one pipeline concept rather than three bespoke ones
 * that drift.
 *
 * Nothing here knows what a recording or an artist is. Each importer owns its
 * own column layout, because the column ORDER is the part that is specific and
 * the part that silently imports the wrong field when it is wrong.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

// ── PostgreSQL COPY text format ─────────────────────────────────────────────

const NULL_MARKER = '\\N';

/**
 * Undo PostgreSQL's `COPY … TO` escaping.
 *
 * Returns `undefined` for `\N`. The fast path matters: this runs on the order of
 * 10^8 field reads across a full import, and the overwhelming majority of values
 * contain no backslash at all.
 */
export function unescapeCopyValue(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === NULL_MARKER) return undefined;
  if (!raw.includes('\\')) return raw;

  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') {
      out += raw[i];
      continue;
    }
    i += 1;
    switch (raw[i]) {
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      default: out += raw[i] ?? ''; break;
    }
  }
  return out;
}

/** Stream a dump table line by line. Throws when the table is missing. */
export async function* readDumpTable(dumpDir: string, table: string): AsyncGenerator<string[]> {
  const filePath = path.join(dumpDir, table);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Dump table not found: ${filePath}. Extract the dump and point --dump-dir at the directory holding its tables.`,
    );
  }
  const stream = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of stream) {
    if (line.length === 0) continue;
    yield line.split('\t');
  }
}

// ── Growable typed arrays keyed by dump row id ──────────────────────────────

/**
 * Row ids in these dumps run to tens of millions and are dense, so a typed array
 * indexed by id costs a fixed 1 or 4 bytes per id where a `Map` would cost ~50.
 * They grow by doubling because a dump does not declare its maximum id.
 */
export class IdBitmap {
  private bits: Uint8Array = new Uint8Array(1 << 20);

  set(id: number): void {
    this.grow(id);
    this.bits[id] = 1;
  }

  has(id: number): boolean {
    return id < this.bits.length && this.bits[id] === 1;
  }

  private grow(id: number): void {
    if (id < this.bits.length) return;
    let size = this.bits.length;
    while (size <= id) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bits);
    this.bits = grown;
  }
}

export class IdCounter {
  private counts: Int32Array = new Int32Array(1 << 20);

  increment(id: number): void {
    this.grow(id);
    this.counts[id] += 1;
  }

  get(id: number): number {
    return id < this.counts.length ? this.counts[id] : 0;
  }

  private grow(id: number): void {
    if (id < this.counts.length) return;
    let size = this.counts.length;
    while (size <= id) size *= 2;
    const grown = new Int32Array(size);
    grown.set(this.counts);
    this.counts = grown;
  }
}

// ── Checkpoint ──────────────────────────────────────────────────────────────

export interface Checkpoint {
  /** The dump's own TIMESTAMP, so a resume cannot cross dumps. */
  dumpTimestamp: string;
  /** How many rows of the driving table have been committed. */
  committedRows: number;
}

/**
 * Read the dump's identity.
 *
 * MusicBrainz ships a `TIMESTAMP` file beside `mbdump/`; a dump directory
 * without one cannot be resumed safely, because a row offset means something
 * different in a different dump.
 */
export function readDumpTimestamp(dumpDir: string): string {
  for (const candidate of [
    path.join(dumpDir, 'TIMESTAMP'),
    path.join(path.dirname(dumpDir), 'TIMESTAMP'),
  ]) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8').trim();
  }
  throw new Error(
    `No TIMESTAMP file found next to ${dumpDir}. It identifies the dump; without it a resume could silently continue against different data.`,
  );
}

export function loadCheckpoint(checkpointPath: string, dumpTimestamp: string): number {
  if (!fs.existsSync(checkpointPath)) return 0;
  const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as Checkpoint;
  if (parsed.dumpTimestamp !== dumpTimestamp) {
    throw new Error(
      `Checkpoint ${checkpointPath} belongs to dump ${parsed.dumpTimestamp} but --dump-dir is ${dumpTimestamp}. ` +
        'Row offsets are not comparable across dumps — delete the checkpoint to start this dump from the beginning.',
    );
  }
  return parsed.committedRows;
}

export function writeCheckpoint(checkpointPath: string, checkpoint: Checkpoint): void {
  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`, 'utf8');
}

// ── Write sizing ────────────────────────────────────────────────────────────

/**
 * The most bind parameters one Postgres statement can carry.
 *
 * The wire protocol's Bind message counts parameters in an Int16, so 65535 is a
 * hard protocol ceiling — not a tunable, and not something a bigger server or a
 * different driver relaxes.
 *
 * This matters here and nowhere else in the codebase because these importers are
 * the only writers that build a multi-row `INSERT` whose row count comes from a
 * CLI flag. Everything else inserts a bounded handful of rows.
 */
const MAX_BIND_PARAMS = 65535;

/**
 * Split `rows` into statement-sized chunks that cannot exceed {@link MAX_BIND_PARAMS}.
 *
 * `--batch-size` is the CHECKPOINT granularity — how many dump rows are covered
 * by one committed advance — and its default of 5000 predates Postgres. It is
 * not a safe statement size, and the difference is not academic: `drizzle` sends
 * one parameter per column per row PLUS one for the client-minted `id`
 * (`generatedId` is `$defaultFn(() => uuidv7())`, so the id is a bind parameter,
 * not a server default), so a 5000-row `musicbrainz_artists` upsert asks for
 * 75001 parameters and the statement is rejected outright. `isrc_registry` at
 * 8 per row survives 5000 by accident, not by design.
 *
 * So the two sizes are separated: the caller keeps its checkpoint cadence, and
 * this decides how many rows may ride in a single statement. Callers pass the
 * WORST-CASE parameter count per row — a row that omits an optional column emits
 * a literal `default` rather than a parameter, so counting every column is the
 * safe direction to be wrong in.
 */
export function chunkForBindParams<T>(rows: readonly T[], paramsPerRow: number): T[][] {
  if (!Number.isInteger(paramsPerRow) || paramsPerRow <= 0) {
    throw new Error(`paramsPerRow must be a positive integer, got ${paramsPerRow}`);
  }

  /**
   * One parameter is reserved because drizzle appends the `updated_at`
   * `$onUpdate` value to the conflict `SET` clause — once per STATEMENT, not per
   * row. Reserving it keeps the arithmetic honest at the boundary instead of
   * putting the ceiling one parameter out of reach.
   */
  const rowsPerStatement = Math.floor((MAX_BIND_PARAMS - 1) / paramsPerRow);
  if (rowsPerStatement === 0) {
    throw new Error(
      `A single row needs ${paramsPerRow} bind parameters, which exceeds the ${MAX_BIND_PARAMS} ceiling.`,
    );
  }

  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += rowsPerStatement) {
    chunks.push(rows.slice(index, index + rowsPerStatement));
  }
  return chunks;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface DumpImportOptions {
  dumpDir: string;
  checkpointPath: string;
  batchSize: number;
}

export interface DumpArgSpec {
  /** Script name, for the usage line. */
  script: string;
  defaultCheckpoint: string;
}

/**
 * Parse `--dump-dir`, `--checkpoint`, `--batch-size` and any bare flags.
 *
 * Returns the flags alongside the options so an importer can read its own
 * (`--skip-release-counts`) without a second parser.
 */
export function parseDumpArgs(
  argv: string[],
  spec: DumpArgSpec,
): DumpImportOptions & { flags: ReadonlySet<string> } {
  const named = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      named.set(key, next);
      i += 1;
    } else {
      flags.add(key);
    }
  }

  const dumpDir = named.get('dump-dir');
  if (!dumpDir) {
    throw new Error(
      `Usage: bun run src/scripts/${spec.script}.ts --dump-dir <path to the extracted dump> ` +
        '[--checkpoint <file>] [--batch-size <n>]',
    );
  }

  const batchSizeRaw = named.get('batch-size');
  const batchSize = batchSizeRaw === undefined ? 5000 : Number(batchSizeRaw);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`--batch-size must be a positive integer, got ${batchSizeRaw}`);
  }

  return {
    dumpDir: path.resolve(dumpDir),
    checkpointPath: path.resolve(named.get('checkpoint') ?? spec.defaultCheckpoint),
    batchSize,
    flags,
  };
}
