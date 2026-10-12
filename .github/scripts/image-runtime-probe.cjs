'use strict';
/**
 * Runs INSIDE the built backend image, under the image's runtime, from /app:
 *
 *   docker run --rm -v "$PWD/.github/scripts:/probe:ro" "$IMAGE" bun /probe/image-runtime-probe.cjs
 *
 * and fails unless every native and system dependency the backend leans on
 * actually works there. Each of these is a property of the IMAGE (its libc, its
 * runtime, the binaries its runner stage installs), so the unit suite on an
 * Ubuntu runner proves nothing about any of them:
 *
 *   - sharp: its musl prebuild (@img/sharp-linuxmusl-*) loads under Bun, and the
 *     real normaliser (`dist/src/utils/imageProcessor.js`) decodes, resizes and
 *     re-encodes an image.
 *   - livekit-server-sdk: ESM-only, require()d by the CommonJS build.
 *   - firebase-admin: a production dependency whose Firestore entry pulls in
 *     @grpc/grpc-js and protobufjs.
 *   - ffmpeg/ffprobe, fpcalc (chromaprint) and Bento4 (mp4fragment, mp42hls):
 *     driven through the real ingest modules (`probeAudio`, `fingerprintFile`,
 *     `packageToEncryptedHls`) on a generated tone, so a missing binary, a
 *     binary that cannot load its shared libraries, or an output the code cannot
 *     parse all fail here.
 *
 * Modules are resolved from the backend's own location, exactly as the server
 * resolves them, not from this file's.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(process.cwd(), 'packages', 'backend', 'dist');
const fromBackend = createRequire(path.join(DIST, 'server.js'));
const dist = (relative) => require(path.join(DIST, relative));

async function main() {
  assert.ok(process.versions.bun, 'the probe is not running on Bun');
  if (process.env.EXPECTED_BUN_VERSION) {
    assert.equal(process.versions.bun, process.env.EXPECTED_BUN_VERSION, 'image Bun version');
  }
  console.log(`runtime: bun ${process.versions.bun} (${process.platform}/${process.arch})`);

  // ── sharp ────────────────────────────────────────────────────────────────
  const sharp = fromBackend('sharp');
  const source = await sharp({
    create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 30, b: 60 } },
  })
    .png()
    .toBuffer();
  const { processImage } = dist('src/utils/imageProcessor.js');
  const normalised = await processImage(source, 'cover');
  assert.equal(normalised.contentType, 'image/webp');
  const meta = await sharp(normalised.buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 630);
  console.log(
    `sharp ${sharp.versions.sharp} (libvips ${sharp.versions.vips}): PNG 1600x900 -> WebP 1200x630`,
  );

  // ── livekit-server-sdk (ESM-only, from CommonJS) ─────────────────────────
  const { AccessToken } = fromBackend('livekit-server-sdk');
  const token = new AccessToken('smoke-key', 's'.repeat(32), { identity: 'image-smoke' });
  token.addGrant({ roomJoin: true, room: 'image-smoke' });
  const jwt = await token.toJwt();
  assert.equal(jwt.split('.').length, 3, 'livekit AccessToken did not produce a JWT');
  console.log('livekit-server-sdk: require(ESM) from CommonJS, AccessToken signed');

  // ── firebase-admin (gRPC) ────────────────────────────────────────────────
  const { initializeApp } = fromBackend('firebase-admin/app');
  const { getFirestore } = fromBackend('firebase-admin/firestore');
  // Constructing the client loads google-gax and the gRPC stack; it opens no
  // connection until a request, and none is made.
  const app = initializeApp({ projectId: 'image-smoke' }, 'image-smoke');
  const firestore = getFirestore(app);
  assert.equal(firestore.collection('smoke').doc('probe').path, 'smoke/probe');
  const grpc = fromBackend('@grpc/grpc-js');
  assert.equal(typeof grpc.credentials.createSsl, 'function');
  console.log('firebase-admin: app initialised, Firestore client built on @grpc/grpc-js');

  // ── ffmpeg, ffprobe, fpcalc, Bento4 via the real ingest modules ──────────
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'syra-image-probe-'));
  try {
    const tone = path.join(work, 'tone.m4a');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        tone,
      ],
      { stdio: 'inherit' },
    );

    const { probeAudio } = dist('src/services/ingest/probeAudio.js');
    const probed = await probeAudio(tone);
    assert.ok(
      probed.durationSec > 11 && probed.durationSec < 13,
      `ffprobe duration ${probed.durationSec}`,
    );
    assert.equal(probed.codec, 'aac');
    console.log(`ffprobe: ${probed.durationSec.toFixed(2)} s ${probed.codec}`);

    const { fingerprintFile } = dist('src/services/uploads/fingerprint.js');
    const fingerprint = await fingerprintFile(tone);
    assert.equal(fingerprint.status, 'ok', `fpcalc: ${JSON.stringify(fingerprint)}`);
    assert.ok(fingerprint.values.length > 0, 'fpcalc produced an empty fingerprint');
    console.log(`fpcalc: ${fingerprint.values.length} fingerprint items`);

    const { packageToEncryptedHls } = dist('src/services/ingest/hlsPackager.js');
    const outputDir = path.join(work, 'hls');
    const packaged = await packageToEncryptedHls({
      inputPath: tone,
      outputDir,
      bitratesKbps: [96],
    });
    assert.match(packaged.keyHex, /^[0-9a-f]{32}$/);
    assert.equal(packaged.renditions.length, 1);
    assert.ok(Number.isFinite(packaged.loudnessLufs), 'ffmpeg loudnorm measurement');
    const master = fs.readFileSync(path.join(outputDir, packaged.masterPlaylistPath), 'utf8');
    assert.match(master, /#EXTM3U/);
    const variant = fs.readFileSync(
      path.join(outputDir, packaged.renditions[0].playlistPath),
      'utf8',
    );
    assert.match(variant, /#EXT-X-KEY:METHOD=AES-128/);
    assert.match(variant, /\.ts\b|\.m4s\b|\.aac\b/);
    console.log(`ffmpeg + mp4fragment + mp42hls: encrypted HLS at ${packaged.loudnessLufs} LUFS`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log('image runtime probe passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
