import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { searchADOFeatures } from './ado.js';

const API_KEY = process.env.API_KEY;
const PORT = Number(process.env.PORT ?? 3000);

// ─── MCP server factory ───────────────────────────────────────────────────────
// A fresh McpServer is created per request (stateless HTTP transport).

function createMCPServer(): McpServer {
  const server = new McpServer({ name: 'ado-finder', version: '1.0.0' });

  server.registerTool(
    'search_ado_features',
    {
      description:
        'Search Azure DevOps for Feature work items in MSTeams\\Design area. ' +
        'Searches titles, tags, and descriptions. Returns open Features: ' +
        'Proposed, Active, New, Committed, Open, In Progress, To Do.',
      inputSchema: {
        keyword: z.string().describe('Search keyword to find in work item titles, tags, or descriptions'),
        topK: z.number().optional().describe('Maximum number of results to return (default: 10)'),
      },
    },
    async ({ keyword, topK = 10 }) => {
      try {
        const items = await searchADOFeatures(keyword, topK);
        return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Auth middleware — validates x-api-key on all /mcp requests
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    res.status(500).json({ error: 'Server misconfigured: API_KEY env var not set' });
    return;
  }
  const provided = req.headers['x-api-key'];
  const key = Array.isArray(provided) ? provided[0] : provided;
  if (!key || key !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing x-api-key header' });
    return;
  }
  next();
}

// Health check — no auth, used by hosting platform probes
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).send('ok');
});

// MCP endpoint — Streamable HTTP transport (stateless, one McpServer per request)
async function handleMCP(req: Request, res: Response): Promise<void> {
  const server = createMCPServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

// Patch Accept header so clients that omit text/event-stream still work.
// Must update rawHeaders because @hono/node-server reads rawHeaders, not req.headers.
function patchAccept(req: Request, _res: Response, next: NextFunction): void {
  const accept = req.headers['accept'] ?? '';
  if (!accept.includes('text/event-stream')) {
    const patched = 'application/json, text/event-stream';
    req.headers['accept'] = patched;
    const raw = req.rawHeaders as string[];
    const idx = raw.findIndex((h, i) => i % 2 === 0 && h.toLowerCase() === 'accept');
    if (idx >= 0) {
      raw[idx + 1] = patched;
    } else {
      raw.push('accept', patched);
    }
  }
  next();
}

// POST: JSON-RPC requests (initialize, tools/list, tools/call)
app.post('/mcp', requireApiKey, patchAccept, handleMCP);

// GET: SSE stream for clients that open a persistent server-push channel
app.get('/mcp', requireApiKey, patchAccept, handleMCP);

app.listen(PORT, () => {
  console.log(`ADO Finder MCP server listening on port ${PORT}`);
  console.log(`  MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`  Health check : http://localhost:${PORT}/healthz`);
});
