import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { clear, connect, disconnect } from '../test/mongo';
import { DiscogsReleaseModel } from '../models/DiscogsRelease';
import {
  importDiscogsReleases,
  parseReleaseElement,
  readReleaseElements,
} from './importDiscogsReleases';

beforeAll(connect);
beforeEach(async () => {
  await DiscogsReleaseModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

/**
 * XML in Discogs' documented release shape.
 *
 * NOT taken from a real dump — the S3 bucket answers 403 from this environment,
 * which is stated at the top of the importer too. So these tests validate the
 * PARSER, not the assumption that the dump matches the documentation. That is a
 * real limit on what this file proves and it is better written down than left
 * for somebody to infer from a green run.
 */
const RELEASE_XML = `<release id="249504" status="Accepted">
  <artists><artist><id>1</id><name>Kestrel Lane</name><anv/><join/><role/></artist></artists>
  <title>The Longest Winter</title>
  <labels>
    <label catno="BRIDGE045CD" name="Bridgewater Recordings" id="99"/>
    <label catno="none" name="Bridgewater Recordings" id="99"/>
  </labels>
  <extraartists>
    <artist><id>7</id><name>Neil Frankland</name><anv/><join/><role>Producer, Mixed By</role><tracks/></artist>
    <artist><id>8</id><name>Sofia Kallio</name><anv/><join/><role>Engineer</role><tracks/></artist>
    <artist><id>9</id><name>No Role Given</name><anv/><join/><role/><tracks/></artist>
  </extraartists>
  <formats><format name="CD" qty="1" text=""><descriptions><description>Album</description></descriptions></format></formats>
  <country>UK</country>
  <released>1998-09-22</released>
  <identifiers>
    <identifier type="Barcode" value="5 016958 034528" description="Text"/>
    <identifier type="Matrix / Runout" value="BRIDGE045CD 01"/>
  </identifiers>
</release>`;

const NO_BARCODE_XML = `<release id="777" status="Accepted">
  <artists><artist><id>1</id><name>Nobody</name></artist></artists>
  <title>Unjoinable</title>
  <identifiers><identifier type="Matrix / Runout" value="XYZ"/></identifiers>
</release>`;

describe('parseReleaseElement', () => {
  it('reads the fields MusicBrainz is thin on', () => {
    const release = parseReleaseElement(RELEASE_XML);
    if (!release) throw new Error('expected a release');

    expect(release.discogsReleaseId).toBe('249504');
    expect(release.title).toBe('The Longest Winter');
    expect(release.artistNames).toEqual(['Kestrel Lane']);
    expect(release.labels).toEqual(['Bridgewater Recordings']);
    expect(release.formats).toEqual(['CD']);
    expect(release.countryCode).toBe('UK');
    expect(release.released).toBe('1998-09-22');
  });

  it('normalises the barcode to digits so it can join a file tag', () => {
    // Discogs writes barcodes as PRINTED, spaces and all; the `BARCODE` tag in a
    // file is digits. Without this the join key never matches anything.
    const release = parseReleaseElement(RELEASE_XML);
    expect(release?.barcodes).toEqual(['5016958034528']);
  });

  it('takes only barcode identifiers, not matrix numbers', () => {
    const release = parseReleaseElement(RELEASE_XML);
    expect(release?.barcodes).not.toContain('BRIDGE045CD 01');
  });

  it('splits a multi-role credit into one credit per role', () => {
    // `Producer, Mixed By` is ONE Discogs field and TWO credits.
    const release = parseReleaseElement(RELEASE_XML);
    expect(release?.credits).toContainEqual({
      name: 'Neil Frankland',
      role: 'Producer',
      nameKey: 'neil frankland',
    });
    expect(release?.credits).toContainEqual({
      name: 'Neil Frankland',
      role: 'Mixed By',
      nameKey: 'neil frankland',
    });
    expect(release?.credits).toContainEqual({
      name: 'Sofia Kallio',
      role: 'Engineer',
      nameKey: 'sofia kallio',
    });
  });

  it('drops a credited person with no role rather than inventing one', () => {
    const release = parseReleaseElement(RELEASE_XML);
    expect(release?.credits.some((credit) => credit.name === 'No Role Given')).toBe(false);
  });

  it('drops the placeholder catalogue number Discogs writes as "none"', () => {
    const release = parseReleaseElement(RELEASE_XML);
    expect(release?.catalogNumbers).toEqual(['BRIDGE045CD']);
  });

  it('REFUSES a release with no barcode', () => {
    // The barcode is the only strong key joining a Discogs release to an
    // uploaded file, so a release without one is a row nothing will ever read.
    expect(parseReleaseElement(NO_BARCODE_XML)).toBeUndefined();
  });

  it('refuses malformed input rather than producing a half-read row', () => {
    expect(parseReleaseElement('<release id="1"></release>')).toBeUndefined();
  });
});

describe('readReleaseElements', () => {
  const created: string[] = [];

  function writeDump(content: string, gzip: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syra-discogs-'));
    created.push(dir);
    const file = path.join(dir, gzip ? 'releases.xml.gz' : 'releases.xml');
    fs.writeFileSync(file, gzip ? zlib.gzipSync(Buffer.from(content)) : content);
    return file;
  }

  afterAll(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('yields one element at a time from a plain XML file', async () => {
    const file = writeDump(`<releases>${RELEASE_XML}${NO_BARCODE_XML}</releases>`, false);
    const elements: string[] = [];
    for await (const element of readReleaseElements(file)) elements.push(element);

    expect(elements).toHaveLength(2);
    expect(elements[0]).toContain('The Longest Winter');
    expect(elements[1]).toContain('Unjoinable');
  });

  it('reads a gzipped dump, which is how Discogs ships it', async () => {
    const file = writeDump(`<releases>${RELEASE_XML}</releases>`, true);
    const elements: string[] = [];
    for await (const element of readReleaseElements(file)) elements.push(element);
    expect(elements).toHaveLength(1);
  });

  it('handles an element split across read chunks', async () => {
    // The real dump is ~12 GB, so every element crosses a chunk boundary
    // eventually. A reader that only looked within one chunk would drop those
    // silently — the worst kind of import bug, because the run still succeeds.
    const many = Array.from({ length: 400 }, () => RELEASE_XML).join('');
    const file = writeDump(`<releases>${many}</releases>`, false);

    let count = 0;
    for await (const element of readReleaseElements(file)) {
      expect(element.endsWith('</release>')).toBe(true);
      count += 1;
    }
    expect(count).toBe(400);
  });
});

describe('importDiscogsReleases', () => {
  const created: string[] = [];

  function writeDump(content: string): { file: string; checkpointPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syra-discogs-import-'));
    created.push(dir);
    const file = path.join(dir, 'discogs_20260701_releases.xml');
    fs.writeFileSync(file, content);
    return { file, checkpointPath: path.join(dir, 'checkpoint.json') };
  }

  afterAll(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports releases keyed by their Discogs id', async () => {
    const dump = writeDump(`<releases>${RELEASE_XML}${NO_BARCODE_XML}</releases>`);
    const summary = await importDiscogsReleases({
      dumpFile: dump.file,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });

    expect(summary.releasesRead).toBe(2);
    expect(summary.documentsWritten).toBe(1);
    expect(summary.skippedUnusable).toBe(1);

    const stored = await DiscogsReleaseModel.findOne({ discogsReleaseId: '249504' }).lean();
    expect(stored?.barcodes).toEqual(['5016958034528']);
    expect(stored?.credits).toHaveLength(3);
  });

  it('is idempotent — a second pass over the same dump changes nothing', async () => {
    const dump = writeDump(`<releases>${RELEASE_XML}</releases>`);
    const options = { dumpFile: dump.file, checkpointPath: dump.checkpointPath, batchSize: 100 };

    await importDiscogsReleases(options);
    const first = await DiscogsReleaseModel.findOne({ discogsReleaseId: '249504' }).lean();
    fs.rmSync(dump.checkpointPath);
    await importDiscogsReleases(options);
    const second = await DiscogsReleaseModel.findOne({ discogsReleaseId: '249504' }).lean();

    expect(await DiscogsReleaseModel.countDocuments()).toBe(1);
    expect(second?._id.toString()).toBe(first?._id.toString() ?? '');
  });

  it('resumes from the checkpoint', async () => {
    const dump = writeDump(`<releases>${RELEASE_XML}${NO_BARCODE_XML}</releases>`);
    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: 'discogs_20260701_releases.xml', committedRows: 2 }),
    );

    const summary = await importDiscogsReleases({
      dumpFile: dump.file,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });
    expect(summary.skippedResumed).toBe(2);
    expect(summary.documentsWritten).toBe(0);
  });

  it('REFUSES to resume a checkpoint from a different dump', async () => {
    const dump = writeDump(`<releases>${RELEASE_XML}</releases>`);
    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: 'discogs_20260601_releases.xml', committedRows: 1 }),
    );

    await expect(
      importDiscogsReleases({
        dumpFile: dump.file,
        checkpointPath: dump.checkpointPath,
        batchSize: 100,
      }),
    ).rejects.toThrow(/20260601/);
  });

  it('honours --limit, for a cautious first run over a real dump', async () => {
    const dump = writeDump(`<releases>${RELEASE_XML}${RELEASE_XML}${RELEASE_XML}</releases>`);
    const summary = await importDiscogsReleases({
      dumpFile: dump.file,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      limit: 1,
    });
    expect(summary.releasesRead).toBe(2);
    expect(summary.documentsWritten).toBe(1);
  });
});
