import { describe, expect, it } from 'bun:test';
import { createCatalogMcpToolDefinitions } from '@oxy.so/mcp';
import {
  handlers,
  READ_SCOPE,
  SYRA_MCP_CATALOG,
  SYRA_MCP_TOOL_NAMES,
  WRITE_SCOPE,
} from './catalog';

describe('the Syra MCP catalogue', () => {
  it('declares the public resource and every tool once', () => {
    expect(SYRA_MCP_CATALOG.appId).toBe('syra');
    expect(SYRA_MCP_CATALOG.externalMcp?.resource).toMatch(/\/mcp$/);
    expect([...SYRA_MCP_TOOL_NAMES].sort()).toEqual([
      'generate-episode',
      'get-episode',
      'get-generation',
      'get-podcast',
      'list-generations',
      'list-my-podcasts',
      'list-podcast-episodes',
      'search-catalogue',
    ]);
  });

  it('asks for write consent only for the one tool that writes, which takes an idempotency key', () => {
    for (const tool of SYRA_MCP_CATALOG.tools) {
      const writes = tool.name === 'generate-episode';
      expect(tool.effect).toBe(writes ? 'write' : 'read');
      expect(tool.requiredCapabilities).toEqual([writes ? WRITE_SCOPE : READ_SCOPE]);
      expect(tool.exposure).toEqual(['mcp']);
      if (writes) {
        expect(tool.idempotency).toBe('supported');
        expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain(
          'idempotencyKey',
        );
      }
    }
  });

  it('has a handler for every tool, and its schemas load as MCP input', () => {
    const definitions = createCatalogMcpToolDefinitions(SYRA_MCP_CATALOG, handlers);
    expect(definitions).toHaveLength(SYRA_MCP_TOOL_NAMES.length);
    const generate = definitions.find((definition) => definition.tool.name === 'generate-episode');
    expect(generate?.inputSchema.safeParse({ podcastId: 'x', topic: 'Bees' }).success).toBe(true);
    expect(generate?.inputSchema.safeParse({ format: 'opera' }).success).toBe(false);
  });
});
