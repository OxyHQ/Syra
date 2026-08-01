import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

/**
 * Does every optional input these services accept actually get SUPPLIED by
 * something on a real request path?
 *
 * ## Why this gate exists
 *
 * An audit of this feature found four defects that were all the same shape: a
 * value that exists at the call site and is never handed on. The acoustic
 * fingerprint was computed and dropped; the raw tag dump was parsed and dropped;
 * the relative path was known and dropped. In every case the receiving parameter
 * was OPTIONAL, and that is precisely why nothing caught them:
 *
 *  - `tsc` is satisfied, because omitting an optional parameter is legal.
 *  - the unit tests pass, because they supply the parameter themselves.
 *  - coverage is green, because the code runs — under test.
 *
 * So the mechanism is built, typed, tested and inert. The only question that
 * separates "optional because callers legitimately vary" from "optional because
 * nobody ever wired it" is: does a PRODUCTION call site pass it? That is the
 * question this file asks, and it is the only gate we have that can.
 *
 * ## Two traps this scan is built to avoid — both were hit while writing it
 *
 * 1. **`server.ts` lives OUTSIDE `src/`.** A scan rooted at `src` reports
 *    `startIngestWorker` and `startExpirySweeper` as having zero callers — i.e.
 *    "the ingest worker and the retention sweeper never run". Both are wired, at
 *    `server.ts:462` and `:468`. {@link productionFiles} therefore includes
 *    `server.ts` explicitly. Do not "tidy" that away.
 * 2. **`\b` stops at a prefix.** Searching `purgeLockerCopies` finds nothing,
 *    because the export is `purgeLockerCopiesOfTrack`. Any negative result from
 *    a name search has to be confirmed by a second method before it is believed.
 *
 * Both are the same defect as the code being audited: a check that reports
 * absence when it was looking in the wrong place. That is why this file carries
 * a vacuity floor — a scan that finds nothing must FAIL, not pass.
 */

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const SERVICE_DIRS = ['src/services/uploads', 'src/services/compliance', 'src/services/ingest'];

/**
 * Interfaces whose optional fields are dependency-injection seams.
 *
 * A `*Deps` field is SUPPOSED to be absent in production — the parameter default
 * IS the real implementation, and only tests pass a substitute. Flagging them
 * would make this gate cry wolf on sixteen correct designs, and a gate that
 * cries wolf gets disabled by whoever hits it next.
 */
const isInjectionSeam = (interfaceName: string): boolean => /Deps$/.test(interfaceName);

/**
 * Optional inputs that are KNOWN to be unsupplied, with an owner.
 *
 * This list is the visible debt, not an excuse: the test fails if something NOT
 * on it becomes unwired (a new regression), AND if something ON it becomes
 * wired (a stale entry). The second direction is what stops the list rotting —
 * whoever fixes one is told to delete its line.
 */
const EXPECTED_UNWIRED: Array<{ key: string; owner: string; note: string }> = [
  /**
   * The two below are the case this gate exists to tell APART from the ones
   * above: optional because a caller legitimately cannot answer, not because
   * somebody forgot. Kept listed rather than exempted, so the reason stays
   * attached and a future caller that CAN answer is noticed.
   */
  {
    key: 'AlbumResolutionInput.totalDurationSec',
    owner: 'uploads-api — CORRECT AS-IS',
    note:
      'Deliberately not passed (uploads.controller.ts:753). It means the running time of the ' +
      'whole RELEASE, which a single-file upload cannot know. Passing the track duration ' +
      'classified a 12-track album as an `ep`, because the classifier reads "under thirty ' +
      'minutes" as EP-shaped. Only a grouped multi-file upload can answer it.',
  },
  {
    key: 'ContributedAlbumInput.totalDurationSec',
    owner: 'uploads-api — CORRECT AS-IS',
    note: 'Same field, same reason, on the creation side.',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__' && entry.name !== 'node_modules') walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every file that can run in production — INCLUDING `server.ts`, which is not under `src/`. */
function productionFiles(): string[] {
  return [...walk(path.join(BACKEND_ROOT, 'src')), path.join(BACKEND_ROOT, 'server.ts')];
}

interface OptionalInput {
  file: string;
  interfaceName: string;
  field: string;
  key: string;
}

/** Optional fields of the exported input shapes these services accept. */
function scanOptionalInputs(): OptionalInput[] {
  const found: OptionalInput[] = [];

  for (const dir of SERVICE_DIRS) {
    for (const file of walk(path.join(BACKEND_ROOT, dir))) {
      const source = fs.readFileSync(file, 'utf8');

      for (const block of source.matchAll(/export interface (\w+)\s*\{([\s\S]*?)\n\}/g)) {
        const interfaceName = block[1] ?? '';
        const body = block[2] ?? '';
        // Only shapes a CALLER constructs. A result or a report is an output.
        if (!/(Input|Context|Options|Candidate|Deps)$/.test(interfaceName)) continue;
        if (isInjectionSeam(interfaceName)) continue;

        for (const field of body.matchAll(/^\s*(\w+)\?:/gm)) {
          const name = field[1] ?? '';
          /**
           * A field the public signature `Omit`s is not caller-suppliable at
           * all — `collectProvenanceSignals` resolves `isrcRegistryMatch`
           * itself. Detected rather than listed by hand, so the exemption
           * cannot outlive the `Omit` that justifies it.
           */
          if (new RegExp(`Omit<\\s*${interfaceName}\\s*,[^>]*['"]${name}['"]`).test(source)) continue;

          found.push({ file, interfaceName, field: name, key: `${interfaceName}.${name}` });
        }
      }
    }
  }

  return found;
}

/** Is this field named as an object property anywhere in production, outside its own module? */
function isSuppliedInProduction(input: OptionalInput, files: string[]): boolean {
  const asProperty = new RegExp(`\\b${input.field}\\s*[:,]`);
  return files.some(
    (file) => file !== input.file && asProperty.test(fs.readFileSync(file, 'utf8')),
  );
}

describe('optional service inputs are supplied by a production call site', () => {
  const inputs = scanOptionalInputs();
  const files = productionFiles();

  it('the scan itself is not vacuous', () => {
    // Every assertion below is "nothing unexpected was found". A scan that
    // walked the wrong directory, or whose regex stopped matching, would report
    // exactly that — so the floor has to prove the scan can still SEE.
    expect(inputs.length).toBeGreaterThan(25);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith('server.ts'))).toBe(true);

    const keys = inputs.map((input) => input.key);
    expect(keys).toContain('ArtistResolutionInput.fingerprintMatch');
    expect(keys).toContain('ProvenanceContext.foreignFingerprintMatch');
  });

  it('detects a known-WIRED input as wired', () => {
    // The other half of the floor. Without this, a search that always returned
    // `false` would report every input as unwired, and a search that always
    // returned `true` would report the whole feature as healthy.
    const wired = inputs.filter((input) =>
      ['ArtistResolutionInput.isrc', 'AlbumResolutionInput.upc', 'MatchCandidate.fingerprint'].includes(
        input.key,
      ),
    );
    expect(wired.length).toBeGreaterThan(0);
    for (const input of wired) {
      expect(isSuppliedInProduction(input, files)).toBe(true);
    }
  });

  it('every optional input is supplied, or is a KNOWN gap with a named owner', () => {
    const expected = new Map(EXPECTED_UNWIRED.map((entry) => [entry.key, entry]));
    const unexpected: string[] = [];

    for (const input of inputs) {
      if (isSuppliedInProduction(input, files)) continue;
      if (expected.has(input.key)) continue;
      unexpected.push(
        `${path.relative(BACKEND_ROOT, input.file)} — ${input.key} is accepted and never supplied ` +
          'by any production call site. Either wire it, or add it to EXPECTED_UNWIRED with an owner.',
      );
    }

    expect(unexpected).toEqual([]);
  });

  it('EXPECTED_UNWIRED has no stale entries', () => {
    // Forces the debt list to shrink. When somebody wires one of these, this
    // fails and tells them to delete the line — otherwise the list silently
    // becomes a record of problems that were fixed years ago.
    const stillUnwired = new Set(
      inputs.filter((input) => !isSuppliedInProduction(input, files)).map((input) => input.key),
    );

    const fixed = EXPECTED_UNWIRED.filter((entry) => !stillUnwired.has(entry.key)).map(
      (entry) => `${entry.key} is now supplied (owner: ${entry.owner}) — delete it from EXPECTED_UNWIRED.`,
    );

    expect(fixed).toEqual([]);
  });
});

/**
 * The same defect in its output form: a value that is produced and never stored.
 *
 * `rawTags` is the DMCA evidence chain — the record of what the file actually
 * declared, kept so a dispute can be audited. It is built by `extractMetadata`,
 * both schemas hold it, and nothing writes it. Called out by name rather than
 * left to a generic scan because the cost of it being absent is only discovered
 * during a legal dispute, which is the worst possible moment.
 */
describe('rawTags reaches storage', () => {
  it('is persisted by a production write, not only extracted', () => {
    const writers = productionFiles()
      .filter((file) => {
        if (file.includes(`${path.sep}models${path.sep}`)) return false;
        if (file.endsWith('extractMetadata.ts')) return false; // produces it
        return /rawTags/.test(fs.readFileSync(file, 'utf8'));
      })
      .map((file) => path.relative(BACKEND_ROOT, file));

    expect(
      writers,
      'rawTags is extracted and stored nowhere: the DMCA evidence chain does not exist. ' +
        'Owner: uploads-api — persist it on the UserUpload and on the ContributionAttestation.',
    ).not.toEqual([]);
  });
});
