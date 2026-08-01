/**
 * Generator for the committed upload-screening fixtures.
 *
 * The four audio files in this directory are REAL files — real MPEG frames, a
 * real FLAC stream, a real MP4 — carrying real tag structures, because the whole
 * point of the extraction and provenance services is to read what taggers,
 * rippers and stores actually write. A hand-written object literal standing in
 * for a parsed file would test the assertions and not the parser.
 *
 * Run it from the backend package root:
 *
 *   bun run src/services/uploads/__fixtures__/generate.ts
 *
 * It is committed so the provenance of every fixture byte is auditable and so a
 * fixture can be regenerated (or extended) without reverse-engineering it. It is
 * NOT run by the test suite: the tests read the committed binaries, so a machine
 * without ffmpeg still runs them.
 *
 * External tooling: ffmpeg only (7.1.5 on the machine these were generated on).
 * Two structures ffmpeg cannot write are produced here directly, byte by byte:
 *
 *  - The ID3v2.4 tag of `indie-id3v2.mp3`. ffmpeg maps `-metadata` onto a fixed
 *    frame table and writes multi-value frames as one flat string, so it cannot
 *    emit a TIPL involved-people list (whose payload is NUL-separated
 *    role/name pairs) — it writes `TIPL` with a single value, which parses back
 *    as an empty credit map. `buildId3v2Tag` below writes the frames directly.
 *  - The iTunes purchase atoms of `purchased-itunes.m4a` (`apID`, `cnID`, `atID`,
 *    `sfID`, `purd`, `ownr`, `xid `). ffmpeg's mov muxer has no mapping for them.
 *    `injectItunesAtoms` appends them to the existing `ilst` box and re-sizes the
 *    ancestors. This is safe because ffmpeg writes `moov` AFTER `mdat`, so
 *    growing `moov` never invalidates the `stco` chunk offsets.
 *
 * Audio content is a synthetic note sequence. Fixture length is 2.5 s: long
 * enough to be a valid stream in every container, short enough to commit.
 */

import { execFile as execFileCb } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const FIXTURE_DIR = __dirname;
const DURATION_SEC = 2.5;

// ── ID3v2.4 tag writer ──────────────────────────────────────────────────────

const UTF8_ENCODING = 0x03;

/** ID3v2 synchsafe integer: 7 significant bits per byte, high bit always clear. */
function synchsafe(value: number): Buffer {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function frame(id: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(id, 'latin1'),
    synchsafe(payload.length),
    Buffer.from([0x00, 0x00]), // frame flags: none
    payload,
  ]);
}

/** A T*** text frame. Multiple values are NUL-separated (ID3v2.4 §4.2). */
function textFrame(id: string, ...values: string[]): Buffer {
  return frame(
    id,
    Buffer.concat([
      Buffer.from([UTF8_ENCODING]),
      Buffer.from(values.join('\u0000'), 'utf8'),
    ]),
  );
}

/** TXXX: a user-defined text frame, `description NUL value`. */
function userTextFrame(description: string, value: string): Buffer {
  return frame(
    'TXXX',
    Buffer.concat([
      Buffer.from([UTF8_ENCODING]),
      Buffer.from(description, 'utf8'),
      Buffer.from([0x00]),
      Buffer.from(value, 'utf8'),
    ]),
  );
}

/**
 * TIPL: the involved-people list. Payload is a flat NUL-separated sequence of
 * `role, name, role, name, …` — the structure ffmpeg cannot produce.
 */
function involvedPeopleFrame(pairs: ReadonlyArray<[string, string]>): Buffer {
  return textFrame('TIPL', ...pairs.flat());
}

/** USLT: unsynchronised lyrics — `language(3) descriptor NUL text`. */
function lyricsFrame(language: string, descriptor: string, text: string): Buffer {
  return frame(
    'USLT',
    Buffer.concat([
      Buffer.from([UTF8_ENCODING]),
      Buffer.from(language, 'latin1'),
      Buffer.from(descriptor, 'utf8'),
      Buffer.from([0x00]),
      Buffer.from(text, 'utf8'),
    ]),
  );
}

/** COMM: a comment — same shape as USLT. */
function commentFrame(language: string, descriptor: string, text: string): Buffer {
  return frame(
    'COMM',
    Buffer.concat([
      Buffer.from([UTF8_ENCODING]),
      Buffer.from(language, 'latin1'),
      Buffer.from(descriptor, 'utf8'),
      Buffer.from([0x00]),
      Buffer.from(text, 'utf8'),
    ]),
  );
}

/** APIC: an attached picture. `pictureType` follows ID3v2.4 §4.14. */
function pictureFrame(
  mimeType: string,
  pictureType: number,
  description: string,
  data: Buffer,
): Buffer {
  return frame(
    'APIC',
    Buffer.concat([
      Buffer.from([UTF8_ENCODING]),
      Buffer.from(mimeType, 'latin1'),
      Buffer.from([0x00]),
      Buffer.from([pictureType]),
      Buffer.from(description, 'utf8'),
      Buffer.from([0x00]),
      data,
    ]),
  );
}

function buildId3v2Tag(frames: Buffer[]): Buffer {
  const body = Buffer.concat(frames);
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x04, 0x00]), // version 2.4.0
    Buffer.from([0x00]), // tag flags: no unsynchronisation, no extended header
    synchsafe(body.length),
    body,
  ]);
}

// ── MP4 atom injection ──────────────────────────────────────────────────────

/** Well-known iTunes `data` type indicators (ISO/IEC 14496-12 + Apple's table). */
const MP4_DATA_TYPE_UTF8 = 1;
const MP4_DATA_TYPE_SIGNED_INT = 21;

function mp4Box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

/** An `ilst` entry: `<type>` wrapping one `data` box. */
function ilstEntry(type: string, dataType: number, payload: Buffer): Buffer {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(dataType, 0); // 1-byte version + 3-byte flags == the type indicator
  data.writeUInt32BE(0, 4); // locale indicator
  return mp4Box(type, mp4Box('data', Buffer.concat([data, payload])));
}

function textAtom(type: string, value: string): Buffer {
  return ilstEntry(type, MP4_DATA_TYPE_UTF8, Buffer.from(value, 'utf8'));
}

function uint32Atom(type: string, value: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(value, 0);
  return ilstEntry(type, MP4_DATA_TYPE_SIGNED_INT, payload);
}

function uint8Atom(type: string, value: number): Buffer {
  return ilstEntry(type, MP4_DATA_TYPE_SIGNED_INT, Buffer.from([value]));
}

interface BoxLocation {
  /** Absolute offset of the box header. */
  start: number;
  size: number;
  /** Absolute offset of the first child byte. */
  contentStart: number;
}

/** Locate a direct child box by type, starting the scan at `from`. */
function findBox(buf: Buffer, type: string, from: number, until: number): BoxLocation {
  let offset = from;
  while (offset + 8 <= until) {
    const size = buf.readUInt32BE(offset);
    const boxType = buf.toString('latin1', offset + 4, offset + 8);
    if (size < 8) {
      throw new Error(`mp4: box '${boxType}' at ${offset} declares an impossible size ${size}`);
    }
    if (boxType === type) {
      // `meta` is a full box: 4 bytes of version+flags precede its children.
      const headerExtra = type === 'meta' ? 4 : 0;
      return { start: offset, size, contentStart: offset + 8 + headerExtra };
    }
    offset += size;
  }
  throw new Error(`mp4: box '${type}' not found between ${from} and ${until}`);
}

/**
 * Append iTunes atoms to `moov/udta/meta/ilst` and grow every ancestor's size.
 *
 * Requires `moov` to sit after `mdat` (ffmpeg's default without `+faststart`),
 * so the sample chunk offsets in `stco` are untouched by the insertion.
 */
function injectItunesAtoms(source: Buffer, atoms: Buffer[]): Buffer {
  const moov = findBox(source, 'moov', 0, source.length);
  const mdat = findBox(source, 'mdat', 0, source.length);
  if (mdat.start > moov.start) {
    throw new Error('mp4: moov precedes mdat — growing it would invalidate stco offsets');
  }

  const udta = findBox(source, 'udta', moov.contentStart, moov.start + moov.size);
  const meta = findBox(source, 'meta', udta.contentStart, udta.start + udta.size);
  const ilst = findBox(source, 'ilst', meta.contentStart, meta.start + meta.size);

  const addition = Buffer.concat(atoms);
  const insertAt = ilst.start + ilst.size;
  const out = Buffer.concat([
    source.subarray(0, insertAt),
    addition,
    source.subarray(insertAt),
  ]);

  for (const box of [ilst, meta, udta, moov]) {
    out.writeUInt32BE(box.size + addition.length, box.start);
  }
  return out;
}

// ── Cover art ───────────────────────────────────────────────────────────────

/**
 * A small deterministic JPEG. `testsrc2` is ffmpeg's own deterministic pattern
 * generator, so re-running the generator reproduces byte-identical art.
 */
async function makeCoverArt(tmpDir: string, name: string, hue: number): Promise<Buffer> {
  const out = path.join(tmpDir, `${name}.jpg`);
  await execFile('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=96x96:rate=1:duration=1',
    '-vf', `hue=h=${hue},format=yuvj420p`,
    '-frames:v', '1', '-q:v', '8',
    out, '-y',
  ]);
  return fs.readFileSync(out);
}

// ── Audio bed ───────────────────────────────────────────────────────────────

/**
 * A short note sequence rather than a single sine: Chromaprint reads chroma, so
 * a fixture with one constant pitch fingerprints to a near-constant vector and
 * would make any fingerprint assertion meaningless.
 */
async function makeAudioBed(tmpDir: string): Promise<string> {
  const notes = [261.63, 329.63, 392.0, 493.88, 440.0];
  const noteDuration = DURATION_SEC / notes.length;
  const inputs = notes.flatMap((frequency) => [
    '-f', 'lavfi',
    '-t', noteDuration.toFixed(4),
    '-i', `sine=frequency=${frequency}:sample_rate=44100`,
  ]);
  const concatInputs = notes.map((_, index) => `[${index}]`).join('');
  const out = path.join(tmpDir, 'bed.wav');
  await execFile('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    ...inputs,
    '-filter_complex',
    `${concatInputs}concat=n=${notes.length}:v=0:a=1[m];[m]tremolo=f=6:d=0.5[o]`,
    '-map', '[o]', '-ac', '2', '-ar', '44100',
    out, '-y',
  ]);
  return out;
}

// ── Fixture 1: indie MP3 with a rich, hand-written ID3v2.4 tag ──────────────

/**
 * The honest independent release: a full tag set including a TSRC, because indie
 * distributors assign ISRCs. Deliberately carries NO MusicBrainz/Picard tags, no
 * store atoms and no ASIN, so it is the fixture that proves a bare ISRC does not
 * by itself make a file commercial.
 */
async function writeIndieMp3(bedPath: string, tmpDir: string): Promise<void> {
  const raw = path.join(tmpDir, 'indie-raw.mp3');
  await execFile('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    '-i', bedPath,
    '-map_metadata', '-1',
    '-write_id3v1', '0', '-id3v2_version', '0',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    raw, '-y',
  ]);

  const front = await makeCoverArt(tmpDir, 'front', 0);
  const back = await makeCoverArt(tmpDir, 'back', 120);
  const artistShot = await makeCoverArt(tmpDir, 'artist', 240);

  const tag = buildId3v2Tag([
    textFrame('TIT2', 'Midnight Ferry'),
    textFrame('TPE1', 'Nadia Ortiz feat. Kofi Mensah'),
    textFrame('TPE2', 'Nadia Ortiz'),
    textFrame('TALB', 'Harbour Lights'),
    textFrame('TRCK', '3/12'),
    textFrame('TPOS', '1/2'),
    textFrame('TDRC', '2023-04-18'),
    textFrame('TDOR', '2019-11-02'),
    textFrame('TCON', 'Indie Pop'),
    textFrame('TSRC', 'ESA452300137'),
    textFrame('TCOM', 'Nadia Ortiz'),
    textFrame('TEXT', 'Rocío Vela'),
    textFrame('TPE3', 'Elena Marchetti'),
    textFrame('TPE4', 'DJ Sirocco'),
    textFrame('TBPM', '112'),
    textFrame('TKEY', 'F#m'),
    textFrame('TLAN', 'spa'),
    textFrame('TCOP', '2023 Nadia Ortiz'),
    textFrame('TPUB', 'Faro Records'),
    textFrame('TMED', 'Digital Media'),
    involvedPeopleFrame([
      ['producer', 'Kofi Mensah'],
      ['engineer', 'Tomás Ruiz'],
      ['mix', 'Ana Beltrán'],
      ['arranger', 'Nadia Ortiz'],
    ]),
    lyricsFrame('spa', '', 'La niebla cae sobre el puerto\ny el último ferry se va'),
    commentFrame('eng', '', 'Recorded at Faro Studios, Cádiz'),
    userTextFrame('CATALOGNUMBER', 'FARO-014'),
    userTextFrame('BARCODE', '8437011234567'),
    userTextFrame('RELEASECOUNTRY', 'ES'),
    // Track ReplayGain only. ALBUM gain is deliberately absent: it can only be
    // computed by scanning a whole release, so it is one of the CD-rip markers,
    // and this fixture's job is to be the honest independent release that screens
    // clean. Album gain lives on `cdrip-picard.flac`, where it belongs.
    userTextFrame('replaygain_track_gain', '-8.42 dB'),
    userTextFrame('replaygain_track_peak', '0.988525'),
    pictureFrame('image/jpeg', 3, 'Front cover', front),
    pictureFrame('image/jpeg', 4, 'Back cover', back),
    pictureFrame('image/jpeg', 8, 'Artist', artistShot),
  ]);

  fs.writeFileSync(
    path.join(FIXTURE_DIR, 'indie-id3v2.mp3'),
    Buffer.concat([tag, fs.readFileSync(raw)]),
  );
}

// ── Fixture 2: an iTunes Store purchase ─────────────────────────────────────

/**
 * An M4A carrying the atoms the iTunes Store stamps into a purchased file,
 * including the buyer's Apple ID (`apID`) and account name (`ownr`). This is the
 * unambiguous "commercial purchase" shape.
 */
async function writePurchasedM4a(bedPath: string, tmpDir: string): Promise<void> {
  const raw = path.join(tmpDir, 'purchased-raw.m4a');
  await execFile('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    '-i', bedPath,
    '-map_metadata', '-1',
    '-c:a', 'aac', '-b:a', '256k',
    '-metadata', 'title=Glass Harbour',
    '-metadata', 'artist=The Longwave Choir',
    '-metadata', 'album_artist=The Longwave Choir',
    '-metadata', 'album=Signals At Dusk',
    '-metadata', 'date=2016-06-10',
    '-metadata', 'genre=Alternative',
    '-metadata', 'track=4/11',
    '-metadata', 'disc=1/1',
    '-metadata', 'copyright=2016 Longwave Recordings Ltd',
    raw, '-y',
  ]);

  const injected = injectItunesAtoms(fs.readFileSync(raw), [
    textAtom('apID', 'buyer.account@icloud.com'),
    uint32Atom('cnID', 1136291289),
    uint32Atom('atID', 1136290477),
    uint32Atom('sfID', 143444),
    uint32Atom('geID', 34),
    textAtom('purd', '2016-07-02 19:41:07'),
    textAtom('ownr', 'A. Buyer'),
    textAtom('xid ', 'Longwave Recordings:isrc:GBAHT1600042'),
    uint8Atom('rtng', 1),
  ]);
  fs.writeFileSync(path.join(FIXTURE_DIR, 'purchased-itunes.m4a'), injected);
}

// ── Fixture 3: a Picard-tagged CD rip ───────────────────────────────────────

/**
 * A FLAC as a ripper leaves it: Vorbis comments, a CUESHEET, album ReplayGain,
 * MusicBrainz identifiers written by Picard and an EAC encoder string. Every one
 * of those is evidence the file came off a commercial disc rather than out of a
 * studio session.
 */
async function writeCdRipFlac(bedPath: string, tmpDir: string): Promise<void> {
  const cover = path.join(tmpDir, 'flac-cover.jpg');
  fs.writeFileSync(cover, await makeCoverArt(tmpDir, 'flac-front', 60));

  const cuesheet = [
    'REM GENRE Post-Rock',
    'REM DATE 1998',
    'PERFORMER "Kestrel Lane"',
    'TITLE "The Longest Winter"',
    'FILE "Kestrel Lane - The Longest Winter.wav" WAVE',
    '  TRACK 07 AUDIO',
    '    TITLE "Sodium Light"',
    '    PERFORMER "Kestrel Lane"',
    '    ISRC GBAYE9800712',
    '    INDEX 01 24:13:22',
  ].join('\n');

  const comments: Array<[string, string]> = [
    ['TITLE', 'Sodium Light'],
    ['ARTIST', 'Kestrel Lane'],
    ['ALBUMARTIST', 'Kestrel Lane'],
    ['ALBUM', 'The Longest Winter'],
    ['TRACKNUMBER', '7'],
    ['TOTALTRACKS', '14'],
    ['DISCNUMBER', '1'],
    ['TOTALDISCS', '1'],
    ['DATE', '1998-09-22'],
    ['ORIGINALDATE', '1998-09-22'],
    ['GENRE', 'Post-Rock'],
    ['ISRC', 'GBAYE9800712'],
    ['BARCODE', '5016958034528'],
    ['CATALOGNUMBER', 'BRIDGE045CD'],
    ['LABEL', 'Bridgewater Recordings'],
    ['MEDIA', 'CD'],
    ['RELEASECOUNTRY', 'GB'],
    ['COMPOSER', 'Ruth Adeyemi'],
    ['LYRICIST', 'Ruth Adeyemi'],
    ['PRODUCER', 'Neil Frankland'],
    ['ENGINEER', 'Sofia Kallio'],
    ['MUSICBRAINZ_TRACKID', 'c1e3f4a0-9f19-4b1e-9b52-6c8f8a0d4f11'],
    ['MUSICBRAINZ_ALBUMID', '4f2a1d3b-8ec6-4a35-9d21-7f0c5b6e2a90'],
    ['MUSICBRAINZ_ARTISTID', '0b6c9f77-2e5a-4d6c-83a1-91b2f4c7d5e8'],
    ['MUSICBRAINZ_ALBUMARTISTID', '0b6c9f77-2e5a-4d6c-83a1-91b2f4c7d5e8'],
    ['MUSICBRAINZ_RELEASEGROUPID', 'a7c9e211-5b3d-4f88-b0a6-1d2e3f4a5b6c'],
    ['ACOUSTID_ID', 'e6a1b2c3-d4e5-4f60-8a71-92b3c4d5e6f7'],
    ['REPLAYGAIN_TRACK_GAIN', '-6.31 dB'],
    ['REPLAYGAIN_TRACK_PEAK', '0.99856567'],
    ['REPLAYGAIN_ALBUM_GAIN', '-6.94 dB'],
    ['REPLAYGAIN_ALBUM_PEAK', '1.00000000'],
    // ENCODEDBY, not ENCODER: ffmpeg writes its own `ENCODER` comment last and
    // overwrites anything set here, so an EAC string in that field would be a
    // fixture claiming something the file does not actually contain.
    ['ENCODEDBY', 'Exact Audio Copy V1.6'],
    ['CUESHEET', cuesheet],
    ['COMMENT', 'Ripped from the original 1998 CD pressing'],
  ];

  await execFile('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    '-i', bedPath,
    '-i', cover,
    '-map', '0:a', '-map', '1:v',
    '-map_metadata', '-1',
    '-c:a', 'flac', '-c:v', 'copy',
    '-disposition:v', 'attached_pic',
    ...comments.flatMap(([key, value]) => ['-metadata', `${key}=${value}`]),
    path.join(FIXTURE_DIR, 'cdrip-picard.flac'), '-y',
  ]);
}

// ── Fixture 4: an untagged WAV ──────────────────────────────────────────────

/**
 * No tags whatsoever — not even ffmpeg's own `ISFT` encoder string, which
 * `-fflags +bitexact` suppresses. This is the "somebody stripped everything"
 * shape, and also the file that proves extraction survives a total absence of
 * metadata.
 *
 * Deliberately 16-bit/44.1 kHz stereo, i.e. CD audio: the provenance marker for
 * stripped tags only fires at release-grade encoding, because an untagged
 * 22 kHz mono file is a voice memo and an untagged CD-quality file is something
 * somebody scrubbed. A lower-quality fixture would leave that marker untested.
 */
async function writeUntaggedWav(bedPath: string): Promise<void> {
  await execFile('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    '-i', bedPath,
    '-map_metadata', '-1',
    '-fflags', '+bitexact',
    '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '44100',
    path.join(FIXTURE_DIR, 'untagged.wav'), '-y',
  ]);
}

// ── Fixture 5: the Chromaprint corpus behind the BER threshold ──────────────

/**
 * `fingerprints.json` — real Chromaprint fingerprints, committed so the bit
 * error rate threshold in `fingerprint.ts` is backed by evidence a test can
 * recompute rather than by a constant somebody once felt good about.
 *
 * PRODUCED WITH ffmpeg, NOT `fpcalc`, and that substitution is deliberate:
 * `fpcalc` is not installed on this machine, but ffmpeg links the same
 * libchromaprint and exposes it as a muxer. `algorithm=1` is TEST2, which is
 * also `fpcalc`'s default, and `fp_format=raw` emits the same int32 vector
 * `fpcalc -raw` prints. The measurement is therefore of the real algorithm.
 *
 * The corpus is two halves. POSITIVES are one 30 s piece put through the
 * degradations a re-upload actually suffers — transcoding, a noise bed, a
 * trimmed head, a time stretch. NEGATIVES are the closest-matching pair out of
 * ten unrelated pieces, chosen by measurement rather than by eye, because the
 * threshold has to clear the WORST negative, not a typical one.
 *
 * Everything here is deterministic — no RNG anywhere — so re-running the
 * generator reproduces the committed file and the numbers quoted in
 * `fingerprint.ts` can be re-derived from scratch.
 */

/** 30 s, so the fingerprints comfortably exceed the minimum overlap. */
const CORPUS_DURATION_SEC = 30;

/**
 * The window size the short-window hazard is searched at: 40 Chromaprint items,
 * about 5 s. Deliberately well below `FINGERPRINT_MIN_OVERLAP_ITEMS` — the point
 * is to find the false match that comparing this little audio produces.
 */
const SHORT_WINDOW_ITEMS = 40;

interface CorpusPiece {
  name: string;
  /** Note frequencies in Hz, played in sequence across the full duration. */
  notes: number[];
  /** Centre frequency of the band-passed noise layer. */
  textureHz: number;
  /** Weight of the noise layer against the melody. */
  textureMix: number;
  /** Tremolo rate, in Hz. */
  tremoloHz: number;
}

/**
 * Ten unrelated pieces. Self-similar on purpose — same generator, same
 * envelope, same texture — so the negative floor they produce is a PESSIMISTIC
 * bound. Two genuinely unrelated commercial recordings sit much further apart,
 * so a threshold that clears these clears those by a wider margin.
 */
const CORPUS_NEGATIVES: ReadonlyArray<CorpusPiece> = [
  { name: 'n0', notes: [261.63, 329.63, 392.0, 493.88, 440.0, 349.23], textureHz: 420, textureMix: 0.18, tremoloHz: 3.1 },
  { name: 'n1', notes: [293.66, 349.23, 440.0, 523.25, 392.0, 311.13, 466.16, 261.63], textureHz: 780, textureMix: 0.31, tremoloHz: 5.4 },
  { name: 'n2', notes: [415.3, 311.13, 246.94, 369.99, 466.16, 277.18, 493.88, 329.63, 220.0, 392.0], textureHz: 1150, textureMix: 0.22, tremoloHz: 7.7 },
  { name: 'n3', notes: [220.0, 246.94, 277.18, 293.66, 329.63, 369.99, 415.3, 440.0, 466.16, 493.88, 523.25, 587.33], textureHz: 1640, textureMix: 0.44, tremoloHz: 2.6 },
  { name: 'n4', notes: [523.25, 440.0, 349.23, 261.63, 329.63, 392.0], textureHz: 2210, textureMix: 0.12, tremoloHz: 8.3 },
  { name: 'n5', notes: [369.99, 493.88, 277.18, 415.3, 220.0, 311.13, 466.16, 349.23], textureHz: 640, textureMix: 0.37, tremoloHz: 4.2 },
  { name: 'n6', notes: [246.94, 293.66, 392.0, 466.16, 523.25, 311.13, 277.18, 440.0, 329.63, 369.99], textureHz: 2950, textureMix: 0.27, tremoloHz: 6.1 },
  { name: 'n7', notes: [440.0, 392.0, 349.23, 329.63, 293.66, 277.18, 246.94, 220.0, 493.88, 523.25, 466.16, 415.3], textureHz: 310, textureMix: 0.49, tremoloHz: 3.8 },
  { name: 'n8', notes: [311.13, 466.16, 220.0, 523.25, 369.99, 261.63], textureHz: 1880, textureMix: 0.15, tremoloHz: 8.9 },
  { name: 'n9', notes: [493.88, 261.63, 415.3, 293.66, 466.16, 349.23, 220.0, 392.0], textureHz: 990, textureMix: 0.4, tremoloHz: 5.0 },
];

/** The reference recording the positive variants are all derived from. */
const CORPUS_REFERENCE: CorpusPiece = {
  name: 'reference',
  notes: [220.0, 246.94, 277.18, 293.66, 329.63, 369.99, 415.3, 440.0],
  textureHz: 1200,
  textureMix: 0.2,
  tremoloHz: 5.0,
};

async function renderCorpusPiece(piece: CorpusPiece, tmpDir: string): Promise<string> {
  const noteDuration = CORPUS_DURATION_SEC / piece.notes.length;
  const inputs = piece.notes.flatMap((frequency) => [
    '-f', 'lavfi',
    '-t', noteDuration.toFixed(6),
    '-i', `sine=frequency=${frequency}:sample_rate=44100`,
  ]);
  inputs.push(
    '-f', 'lavfi',
    '-t', String(CORPUS_DURATION_SEC),
    '-i', 'anoisesrc=c=pink:a=0.4:r=44100:seed=1',
  );

  const melodyInputs = piece.notes.map((_, index) => `[${index}]`).join('');
  const textureIndex = piece.notes.length;
  const filter =
    `${melodyInputs}concat=n=${piece.notes.length}:v=0:a=1[m];` +
    `[${textureIndex}]bandpass=f=${piece.textureHz}:w=200[t];` +
    `[m][t]amix=inputs=2:weights=1 ${piece.textureMix},tremolo=f=${piece.tremoloHz}:d=0.7[o]`;

  const out = path.join(tmpDir, `corpus-${piece.name}.wav`);
  await execFile('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[o]', '-ac', '1', '-ar', '44100',
    out, '-y',
  ]);
  return out;
}

/**
 * Fingerprint a file through ffmpeg's chromaprint muxer and read the result back
 * as signed int32 — the same representation `TrackFingerprint.fingerprint`
 * stores and `compareFingerprints` consumes.
 */
async function chromaprintOf(wavPath: string, tmpDir: string, name: string): Promise<number[]> {
  const out = path.join(tmpDir, `${name}.fp`);
  await execFile('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    '-i', wavPath,
    '-f', 'chromaprint',
    '-algorithm', '1',
    '-fp_format', 'raw',
    out, '-y',
  ]);
  const raw = fs.readFileSync(out);
  const values: number[] = [];
  for (let offset = 0; offset + 4 <= raw.length; offset += 4) {
    values.push(raw.readInt32LE(offset));
  }
  return values;
}

/** Bit error rate over the best alignment — the same computation under test. */
function corpusBitErrorRate(a: number[], b: number[], maxOffset: number, minOverlap: number): number {
  let best = 1;
  for (let offset = -maxOffset; offset <= maxOffset; offset += 1) {
    const aStart = offset >= 0 ? offset : 0;
    const bStart = offset >= 0 ? 0 : -offset;
    const overlap = Math.min(a.length - aStart, b.length - bStart);
    if (overlap < minOverlap) continue;
    let bits = 0;
    for (let i = 0; i < overlap; i += 1) {
      let word = (a[aStart + i] ^ b[bStart + i]) >>> 0;
      while (word !== 0) {
        bits += word & 1;
        word >>>= 1;
      }
    }
    const rate = bits / (overlap * 32);
    if (rate < best) best = rate;
  }
  return best;
}

async function writeFingerprintCorpus(tmpDir: string): Promise<void> {
  const referenceWav = await renderCorpusPiece(CORPUS_REFERENCE, tmpDir);

  const variants: ReadonlyArray<{ key: string; extension: string; args: string[] }> = [
    { key: 'mp3_128', extension: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '128k'] },
    { key: 'mp3_320', extension: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k'] },
    { key: 'aac96', extension: 'm4a', args: ['-c:a', 'aac', '-b:a', '96k'] },
    { key: 'halfVolume', extension: 'wav', args: ['-af', 'volume=0.5'] },
    { key: 'offset1s', extension: 'wav', args: ['-ss', '1.0'] },
    { key: 'tempo2pct', extension: 'wav', args: ['-af', 'atempo=1.02'] },
    // Pink noise mixed in at a quarter weight — a second input, so it cannot be
    // expressed as a filter on the single-input variants above.
    {
      key: 'pinkNoiseMixed',
      extension: 'wav',
      args: [
        '-f', 'lavfi', '-t', String(CORPUS_DURATION_SEC),
        '-i', 'anoisesrc=c=pink:a=0.05:r=44100:seed=2',
        '-filter_complex', '[0][1]amix=inputs=2:weights=1 0.25[o]',
        '-map', '[o]', '-ac', '1',
      ],
    },
  ];

  const fingerprints: Record<string, number[]> = {
    reference: await chromaprintOf(referenceWav, tmpDir, 'reference'),
  };

  for (const variant of variants) {
    const rendered = path.join(tmpDir, `variant-${variant.key}.${variant.extension}`);
    await execFile('ffmpeg', [
      '-nostdin', '-loglevel', 'error',
      '-i', referenceWav,
      ...variant.args,
      rendered, '-y',
    ]);
    fingerprints[variant.key] = await chromaprintOf(rendered, tmpDir, variant.key);
  }

  // Fingerprint all ten unrelated pieces, then keep the pair that agrees most —
  // the hardest negative the threshold has to clear.
  const negatives: Array<{ name: string; values: number[] }> = [];
  for (const piece of CORPUS_NEGATIVES) {
    const wav = await renderCorpusPiece(piece, tmpDir);
    negatives.push({ name: piece.name, values: await chromaprintOf(wav, tmpDir, piece.name) });
  }

  let closest: { a: string; b: string; rate: number } | undefined;
  for (let i = 0; i < negatives.length; i += 1) {
    for (let j = i + 1; j < negatives.length; j += 1) {
      const rate = corpusBitErrorRate(negatives[i].values, negatives[j].values, 40, 160);
      if (!closest || rate < closest.rate) {
        closest = { a: negatives[i].name, b: negatives[j].name, rate };
      }
    }
  }
  if (!closest) {
    throw new Error('fingerprint corpus: no negative pair overlapped enough to compare');
  }
  const closestA = negatives.find((entry) => entry.name === closest.a);
  const closestB = negatives.find((entry) => entry.name === closest.b);
  if (!closestA || !closestB) {
    throw new Error('fingerprint corpus: closest pair vanished between selection and write');
  }

  // The SHORT-WINDOW hazard, which is a different pair and a different window
  // from the closest full-overlap pair — it has to be searched for and committed
  // separately or the claim behind FINGERPRINT_MIN_OVERLAP_ITEMS has no evidence
  // in the repo. This finds the 40-item (~5 s) window anywhere in any unrelated
  // pair where the two agree most closely: the false match the minimum-overlap
  // guard exists to refuse.
  const shortWindow = SHORT_WINDOW_ITEMS;
  let worst:
    | { a: string; b: string; rate: number; startA: number; startB: number }
    | undefined;
  for (let i = 0; i < negatives.length; i += 1) {
    for (let j = i + 1; j < negatives.length; j += 1) {
      const a = negatives[i].values;
      const b = negatives[j].values;
      for (let start = 0; start + shortWindow <= a.length; start += 1) {
        for (let offset = -8; offset <= 8; offset += 1) {
          const startA = start + Math.max(0, offset);
          const startB = start + Math.max(0, -offset);
          if (startA + shortWindow > a.length || startB + shortWindow > b.length) continue;
          const rate = corpusBitErrorRate(
            a.slice(startA, startA + shortWindow),
            b.slice(startB, startB + shortWindow),
            0,
            shortWindow,
          );
          if (!worst || rate < worst.rate) {
            worst = { a: negatives[i].name, b: negatives[j].name, rate, startA, startB };
          }
        }
      }
    }
  }
  if (!worst) {
    throw new Error('fingerprint corpus: no short window could be compared');
  }
  const shortA = negatives.find((entry) => entry.name === worst.a);
  const shortB = negatives.find((entry) => entry.name === worst.b);
  if (!shortA || !shortB) {
    throw new Error('fingerprint corpus: short-window pair vanished between selection and write');
  }

  fs.writeFileSync(
    path.join(FIXTURE_DIR, 'fingerprints.json'),
    `${JSON.stringify(
      {
        note:
          'Real Chromaprint fingerprints (algorithm 1 / TEST2) produced by ffmpeg ' +
          '"-f chromaprint -fp_format raw" from 30 s of deterministic synthetic audio. ' +
          'Signed int32, the same representation TrackFingerprint stores. See generate.ts.',
        positivesAreVariantsOf: 'reference',
        closestNegativePair: `${closest.a} vs ${closest.b}`,
        shortWindowFalseMatch: {
          pair: `${worst.a} vs ${worst.b}`,
          items: shortWindow,
          startA: worst.startA,
          startB: worst.startB,
          bitErrorRate: Number(worst.rate.toFixed(6)),
        },
        ...fingerprints,
        closestNegativeA: closestA.values,
        closestNegativeB: closestB.values,
        shortWindowNegativeA: shortA.values,
        shortWindowNegativeB: shortB.values,
      },
      null,
      1,
    )}\n`,
  );

  process.stdout.write(
    `fingerprint corpus: closest unrelated pair ${closest.a}/${closest.b} at BER ${closest.rate.toFixed(4)}\n`,
  );
  process.stdout.write(
    `  short-window FALSE match: ${worst.a}/${worst.b} over ${shortWindow} items ` +
      `at +${worst.startA}/+${worst.startB}, BER ${worst.rate.toFixed(4)}\n`,
  );
  for (const [key, values] of Object.entries(fingerprints)) {
    if (key === 'reference') continue;
    const rate = corpusBitErrorRate(fingerprints.reference, values, 40, 160);
    process.stdout.write(`  positive ${key.padEnd(16)} BER ${rate.toFixed(4)}\n`);
  }

  // The evidence for FINGERPRINT_MIN_OVERLAP_ITEMS: how close two unrelated
  // recordings can get when only a short window is compared. Printed rather than
  // committed because it is a property of the whole ten-piece corpus, not of the
  // one pair the JSON keeps — but it is the number that decides the constant, so
  // whoever regenerates the corpus should see it move.
  process.stdout.write('  negative floor by aligned overlap (sliding window):\n');
  for (const window of [40, 80, 120, 160, 200]) {
    let floor = 1;
    for (let i = 0; i < negatives.length; i += 1) {
      for (let j = i + 1; j < negatives.length; j += 1) {
        for (let start = 0; start + window <= negatives[i].values.length; start += 10) {
          const rate = corpusBitErrorRate(
            negatives[i].values.slice(start, start + window),
            negatives[j].values.slice(start, start + window),
            8,
            window - 8,
          );
          if (rate < floor) floor = rate;
        }
      }
    }
    const seconds = (window / 8.08).toFixed(1);
    process.stdout.write(`    ${String(window).padStart(3)} items (~${seconds}s): ${floor.toFixed(4)}\n`);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syra-fixtures-'));
  try {
    const bed = await makeAudioBed(tmpDir);
    await writeIndieMp3(bed, tmpDir);
    await writePurchasedM4a(bed, tmpDir);
    await writeCdRipFlac(bed, tmpDir);
    await writeUntaggedWav(bed);
    await writeFingerprintCorpus(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  process.stdout.write(`fixtures written to ${FIXTURE_DIR}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
