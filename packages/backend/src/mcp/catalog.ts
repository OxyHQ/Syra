/**
 * Syra's MCP tools, compiled into the Oxy capability catalogue and dispatched
 * from it. Any MCP client a person connects — Claude, a gemie through the
 * Gemies Connectors Store, any other agent — signs in with Oxy and acts as the
 * account the connection is acting as. See `docs/mcp.md`.
 *
 * Each tool is a thin reading of a Syra rule that already exists, never a
 * second copy of one:
 *
 * - The catalogue search is the PUBLIC `GET /api/search`, called with no
 *   credentials, so it returns exactly what an anonymous listener gets.
 * - A show or episode is read through the same viewer rules the app uses
 *   (`findPodcastForViewer`, `findEpisodeForViewer`, `episodeVisibilityFilter`),
 *   with the acting account as the viewer: their own private shows included,
 *   nobody else's.
 * - Generating is `requestEpisodeGeneration`, the same service Studio calls.
 */

import { isLiveEntityId } from '@oxy.so/db';
import {
  appCapabilityCatalogSchema,
  type AppCapabilityCatalog,
  type CatalogTool,
} from '@oxy.so/contracts';
import type {
  CatalogInvocationContext,
  CatalogMcpAuthorizationDecision,
  CatalogToolHandler,
  CatalogToolHandlers,
  CatalogToolResult,
} from '@oxy.so/mcp';
import { z } from 'zod';
import {
  createPodcastRequestSchema,
  generateEpisodeRequestSchema,
  podcastVisibilitySchema,
} from '@syra/shared-types';
import { env } from '../config/env';
import {
  countEpisodesByShow,
  findEpisodeForViewer,
  findEpisodesByShow,
} from '../db/podcasts/episodes';
import {
  findGeneration,
  listGenerationsForPodcast,
  toEpisodeGenerationDto,
} from '../db/podcasts/generations';
import { loadShowContext, toEpisodeDtos, toPodcastDtos } from '../db/podcasts/hydrate';
import {
  findPodcastForOwner,
  findPodcastForViewer,
  findPodcastsByOwner,
} from '../db/podcasts/podcasts';
import { episodeVisibilityFilter } from '../db/podcasts/visibility';
import { requestEpisodeGeneration } from '../services/podcasts/generation/request';
import { insertHostedPodcast } from '../services/podcasts/hostedPodcast';

/** The two scopes a person grants a connector on Oxy's consent screen. */
export const READ_SCOPE = 'syra.read';
export const WRITE_SCOPE = 'syra.write';

const CATALOG_VERSION = '1.0.0';
const MAX_PAGE_SIZE = 50;

type Shape = Record<string, z.ZodType>;

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly shape: Shape;
  readonly writes: boolean;
  readonly handler: (input: Record<string, unknown>, actorId: string) => Promise<CatalogToolResult>;
}

const id = (what: string) => z.string().min(1).max(64).describe(`The ${what}'s id`);
const page = z.number().int().min(1).optional().describe('Page, from 1');
const limit = z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Results per page');

function ok(structuredContent: Record<string, unknown>): CatalogToolResult {
  return { structuredContent };
}

function refused(code: string, message: string): CatalogToolResult {
  return {
    isError: true,
    structuredContent: { code, message },
    content: [{ type: 'text', text: message }],
  };
}

const notFound = (what: string) =>
  refused('not_found', `No ${what} with that id is visible to you.`);

/** The public search, exactly as an anonymous listener calls it. */
async function searchCatalogue(input: Record<string, unknown>): Promise<CatalogToolResult> {
  const params = new URLSearchParams({ q: String(input.query) });
  if (typeof input.category === 'string') params.set('category', input.category);
  if (typeof input.limit === 'number') params.set('limit', String(input.limit));
  const response = await fetch(`http://127.0.0.1:${env.PORT}/api/search?${params}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return refused('service_unavailable', 'The catalogue search is unavailable.');
  return ok((await response.json()) as Record<string, unknown>);
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'search-catalogue',
    description:
      'Search Syra: tracks, albums, artists, playlists, podcasts and episodes. Returns what any listener can find.',
    shape: {
      query: z.string().trim().min(1).max(200).describe('What to search for'),
      category: z
        .enum(['all', 'tracks', 'albums', 'artists', 'playlists', 'podcasts', 'episodes'])
        .optional()
        .describe('Only this kind of result'),
      limit,
    },
    writes: false,
    handler: (input) => searchCatalogue(input),
  },
  {
    name: 'list-my-podcasts',
    description: 'The podcasts you own on Syra, in every state, private ones included.',
    shape: {},
    writes: false,
    handler: async (_input, actorId) => {
      const rows = await findPodcastsByOwner(actorId);
      return ok({ podcasts: await toPodcastDtos(rows, actorId) });
    },
  },
  {
    name: 'get-podcast',
    description:
      'One podcast: its details. Yours in any state, anyone else only when public or unlisted.',
    shape: { podcastId: id('podcast') },
    writes: false,
    handler: async (input, actorId) => {
      const podcastId = String(input.podcastId);
      const row = isLiveEntityId(podcastId)
        ? await findPodcastForViewer(podcastId, actorId)
        : undefined;
      if (!row) return notFound('podcast');
      const [podcast] = await toPodcastDtos([row], actorId);
      return ok({ podcast, listenUrl: `https://syra.fm/podcasts/${row.id}` });
    },
  },
  {
    name: 'list-podcast-episodes',
    description:
      "A podcast's episodes, newest first. On your own podcast this includes episodes still being made or that failed.",
    shape: { podcastId: id('podcast'), page, limit },
    writes: false,
    handler: async (input, actorId) => {
      const podcastId = String(input.podcastId);
      const show = isLiveEntityId(podcastId)
        ? await findPodcastForViewer(podcastId, actorId)
        : undefined;
      if (!show) return notFound('podcast');
      const size = typeof input.limit === 'number' ? input.limit : 20;
      const pageNumber = typeof input.page === 'number' ? input.page : 1;
      const visibility = episodeVisibilityFilter(show.ownerOxyUserId, actorId);
      const [rows, total, shows] = await Promise.all([
        findEpisodesByShow(show.id, { visibility, offset: (pageNumber - 1) * size, limit: size }),
        countEpisodesByShow(show.id, visibility),
        loadShowContext([{ podcastId: show.id }]),
      ]);
      return ok({
        episodes: await toEpisodeDtos(rows, actorId, shows),
        total,
        page: pageNumber,
        limit: size,
      });
    },
  },
  {
    name: 'get-episode',
    description: 'One episode: its details and where to listen.',
    shape: { episodeId: id('episode') },
    writes: false,
    handler: async (input, actorId) => {
      const episodeId = String(input.episodeId);
      const found = isLiveEntityId(episodeId)
        ? await findEpisodeForViewer(episodeId, actorId)
        : undefined;
      if (!found) return notFound('episode');
      const shows = await loadShowContext([found.episode]);
      const [episode] = await toEpisodeDtos([found.episode], actorId, shows);
      return ok({ episode, listenUrl: `https://syra.fm/episode/${found.episode.id}` });
    },
  },
  {
    name: 'generate-episode',
    description:
      "Write and voice a new episode of a podcast you own, from a topic or from the show's brief. Name an existing podcast with podcastId, or create one with newPodcast. Returns at once: the episode is made in a few minutes; follow it with get-generation. Pass the same idempotencyKey to retry safely.",
    shape: {
      podcastId: id('podcast').optional(),
      newPodcast: z
        .object({
          title: z.string().trim().min(1).max(200),
          description: z.string().max(4000).optional(),
          visibility: podcastVisibilitySchema
            .optional()
            .describe(
              'Who can listen. A new generated podcast is private unless you say otherwise.',
            ),
        })
        .optional()
        .describe('Create this podcast for you and generate its first episode'),
      ...generateEpisodeRequestSchema.shape,
      idempotencyKey: z.string().min(8).max(128).optional(),
    },
    writes: true,
    handler: generateEpisodeTool,
  },
  {
    name: 'get-generation',
    description:
      'Where a generated episode has got to: queued, writing, recording, assembling, publishing, completed or failed (with why).',
    shape: { episodeId: id('episode') },
    writes: false,
    handler: async (input, actorId) => {
      const episodeId = String(input.episodeId);
      const generation = isLiveEntityId(episodeId) ? await findGeneration(episodeId) : undefined;
      if (!generation || !(await findPodcastForOwner(generation.podcastId, actorId))) {
        return notFound('generation');
      }
      return ok({ generation: toEpisodeGenerationDto(generation) });
    },
  },
  {
    name: 'list-generations',
    description: 'The generated episodes of a podcast you own, newest first, with their status.',
    shape: { podcastId: id('podcast') },
    writes: false,
    handler: async (input, actorId) => {
      const podcastId = String(input.podcastId);
      if (!isLiveEntityId(podcastId) || !(await findPodcastForOwner(podcastId, actorId))) {
        return notFound('podcast');
      }
      const rows = await listGenerationsForPodcast(podcastId, MAX_PAGE_SIZE);
      return ok({ generations: rows.map(toEpisodeGenerationDto) });
    },
  },
];

async function generateEpisodeTool(
  input: Record<string, unknown>,
  actorId: string,
): Promise<CatalogToolResult> {
  const request = generateEpisodeRequestSchema.safeParse(input);
  if (!request.success) return refused('invalid_request', 'The generation request is not valid.');
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined;

  let show;
  if (typeof input.podcastId === 'string') {
    show = isLiveEntityId(input.podcastId)
      ? await findPodcastForOwner(input.podcastId, actorId)
      : undefined;
    if (!show) return notFound('podcast of yours');
  } else if (input.newPodcast !== undefined) {
    const parsed = createPodcastRequestSchema.safeParse({
      ...(input.newPodcast as Record<string, unknown>),
      aiGenerated: true,
    });
    if (!parsed.success) return refused('invalid_request', 'The new podcast is not valid.');
    show = await insertHostedPodcast(actorId, {
      ...parsed.data,
      visibility: parsed.data.visibility ?? 'private',
    });
  } else {
    return refused('invalid_request', 'Name a podcast (podcastId) or create one (newPodcast).');
  }

  const result = await requestEpisodeGeneration({
    show,
    requesterId: actorId,
    request: { ...request.data, ...(idempotencyKey ? { idempotencyKey } : {}) },
    // An MCP connection carries no Oxy session to admit the audio as the
    // person's own Oxy file, so the episode keeps Syra's copy (docs/mcp.md).
    fileTask: (_episodeId, write) => write(null),
  });
  if (!result.ok) return refused(result.code, result.message);
  return ok({
    podcastId: show.id,
    episodeId: result.episode.id,
    replayed: result.replayed,
    generation: toEpisodeGenerationDto(result.generation),
  });
}

function jsonSchema(shape: Shape): Record<string, unknown> {
  const converted: Record<string, unknown> = z.toJSONSchema(z.object(shape), {
    target: 'draft-7',
    io: 'input',
  });
  delete converted.$schema;
  return converted;
}

function catalogTool(tool: ToolDefinition): CatalogTool {
  return {
    name: tool.name,
    version: CATALOG_VERSION,
    description: tool.description,
    inputSchema: jsonSchema(tool.shape),
    capabilityPackage: tool.writes ? 'publish' : 'read',
    requiredCapabilities: [tool.writes ? WRITE_SCOPE : READ_SCOPE],
    resourceTypes: ['syra_podcast'],
    effect: tool.writes ? 'write' : 'read',
    // A write takes `idempotencyKey`; a repeat with it answers the first result.
    idempotency: tool.writes ? 'supported' : 'none',
    rollback: tool.writes ? 'manual' : 'none',
    exposure: ['mcp'],
    limitKeys: [],
    // External MCP only: nothing serves the internal invocation path.
    invocation: { method: 'POST', path: `/_oxy/capabilities/${tool.name}` },
  };
}

/**
 * The public MCP resource: `https://api.syra.fm/mcp` in production, where the
 * API's public origin is required (`STREAM_KEY_BASE_URL`); the local API's own
 * origin elsewhere.
 */
export function mcpResource(): string {
  return new URL('/mcp', env.STREAM_KEY_BASE_URL || `http://localhost:${env.PORT}`).toString();
}

/** Built at import, so a malformed tool fails the boot rather than a request. */
export const SYRA_MCP_CATALOG: AppCapabilityCatalog = appCapabilityCatalogSchema.parse({
  schemaVersion: '1',
  appId: 'syra',
  version: CATALOG_VERSION,
  audience: 'syra-api',
  internalBaseUrl: new URL(mcpResource()).origin,
  accountResourceType: 'oxy_account',
  externalMcp: { resource: mcpResource() },
  tools: TOOLS.map(catalogTool),
  events: [],
});

/** Every tool acts as the connection's active account, and nothing else. */
export async function authorize(
  _input: Readonly<Record<string, unknown>>,
  { principal }: CatalogInvocationContext,
): Promise<CatalogMcpAuthorizationDecision> {
  return { allowed: true, effectiveAccountId: principal.activeAccountId };
}

export const handlers: CatalogToolHandlers = Object.fromEntries(
  TOOLS.map((tool): [string, CatalogToolHandler] => [
    tool.name,
    (input, context) => tool.handler({ ...input }, context.principal.activeAccountId),
  ]),
);

export const SYRA_MCP_TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);
