import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * Which entries reach Zod, measured by bundling them.
 *
 * The client and the live-rooms engine check responses without Zod, so an app
 * that bundles them does not ship Zod and its locales (~500 KiB in Mention's
 * startup JavaScript, where Zod was hoisted into the always-loaded common chunk
 * because three lazy features shared it). `@syra.fm/sdk/schemas` is the one
 * entry that brings it in, on purpose.
 *
 * This bundles each entry the way an app's bundler would, follows every import
 * through the SDK's own sources, and records who asks for `zod`. A source-text
 * grep would miss a re-export chain; resolving the graph does not.
 */

const SRC = import.meta.dir;

async function zodImporters(entry: string): Promise<string[]> {
  const importers: string[] = [];
  const result = await Bun.build({
    entrypoints: [join(SRC, entry)],
    target: 'browser',
    // Peers (react-native, livekit, expo, Oxy) are the app's, not ours; only the
    // SDK's own modules are walked.
    packages: 'external',
    loader: { '.mp3': 'file' },
    plugins: [
      {
        name: 'record-zod',
        setup(build) {
          build.onResolve({ filter: /^zod(\/.*)?$/ }, (args) => {
            importers.push(args.importer.slice(SRC.length + 1));
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, `bundling ${entry} failed`);
  return importers;
}

describe('Zod stays out of the app entries', () => {
  it('the client entry (`.`, `./client`) does not import zod', async () => {
    expect(await zodImporters('index.ts')).toEqual([]);
  });

  it('the live-rooms entry (`.` on react-native/browser) does not import zod', async () => {
    expect(await zodImporters('index.native.ts')).toEqual([]);
  });

  it('`./schemas` does — the control that proves the probe sees an import', async () => {
    expect((await zodImporters('schemas.ts')).sort()).toEqual(['live/schema.ts', 'schema.ts']);
  });
});
