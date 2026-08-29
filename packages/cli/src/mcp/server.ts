// mcp/server.ts — the MCP stdio server wiring (spec §4.1, M6 Step 15).
//
// Everything that decides anything lives in mcp/tools.ts; this file is the
// adapter between that and the protocol. It uses the SDK's low-level `Server`
// rather than the `McpServer` convenience class for one concrete reason:
// McpServer.registerTool takes zod schemas and converts them itself, while our
// diagram_patch input schema is the JSON Schema core already generates from the
// zod patch schema (graphPatchJsonSchema). Handing that straight to list_tools
// keeps one source of truth; going back through zod would mean maintaining a
// second copy of the patch shape, which is exactly the drift the generator
// exists to prevent.
//
// STDOUT BELONGS TO THE PROTOCOL. A stray console.log lands in the middle of a
// JSON-RPC frame and the client reports a parse error that names no code of
// ours, so every diagnostic here goes to stderr, deliberately and only through
// logStderr().
//
// The .diagram/ directory is resolved per call, not once at startup: an MCP
// server started by an editor outlives many turns, DIAGRAM_DIR is how .mcp.json
// points it at the workspace (spec §4.1), and re-resolving costs nothing.

import type { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createContext, type ContextOptions } from '../commands/context.js';
import { CLI_VERSION } from '../index.js';
import { TOOLS, callTool } from './tools.js';

export interface McpServerOptions extends ContextOptions {
  /** Server name reported in the MCP handshake. */
  name?: string;
  /** Server version reported in the MCP handshake. Defaults to CLI_VERSION. */
  version?: string;
}

/** A running stdio server plus the handle to stop it. */
export interface McpServerHandle {
  server: Server;
  transport: StdioServerTransport;
  close(): Promise<void>;
}

/** The only place this process is allowed to write a diagnostic. */
export function logStderr(message: string): void {
  process.stderr.write(`diagram-mcp: ${message}\n`);
}

/**
 * A short note the client shows the agent when it connects. It says the three
 * things a first turn needs and nothing else: read before you write, the rules
 * travel with diagram_patch, and how to tell a rejection from a success.
 *
 * That last line is here rather than repeated in all seven tool descriptions
 * because it is one fact about the whole surface, and the description of every
 * tool is paid for on every turn. See the isError note in the call handler for
 * why the flag itself is not the signal.
 */
export const SERVER_INSTRUCTIONS = [
  'Local architecture diagram engine. The document lives in .diagram/graph.json.',
  'Call diagram_get before editing an existing diagram; diagram_patch carries the',
  'authoring rules in its description. You never produce coordinates — layout is',
  'not yours to decide.',
  'Every result starts with either "ok — " or "rejected — ". A rejected result',
  'means NOTHING was changed or written: read the lines under it, fix the input,',
  'and send it again.',
].join('\n');

/**
 * Build the server and register the two tool handlers. Connects to nothing:
 * the caller chooses the transport, which is what lets tests drive it in
 * process without a pipe.
 */
export function createMcpServer(opts: McpServerOptions = {}): Server {
  const server = new Server(
    {
      name: opts.name ?? 'diagram',
      version: opts.version ?? CLI_VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  // Awaited, not called synchronously: diagram_export's svg format runs a
  // layout pass and ELK is asynchronous, so a sync dispatch here would be a
  // silently smaller tool surface than the one list_tools advertises.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
    try {
      const result = await callTool(name, args ?? {}, ctx);
      // isError is left false even for a rejection, deliberately: a rejected
      // patch is a result the agent READS and corrects (spec §4.1, rule 11),
      // and some clients hide an error result behind a generic "tool failed"
      // or retry it unchanged — either of which throws away the one thing
      // that makes the rejection useful, its text. The cost is that a host
      // branching on isError cannot tell the two apart, so the discriminator
      // is stated where the agent actually reads it: the "ok — " / "rejected
      // — " prefix, named in SERVER_INSTRUCTIONS above. The CLI twins keep
      // signalling the same conditions with exit 1, where a shell CAN act on
      // it without losing the message.
      return { content: [{ type: 'text' as const, text: result.text }] };
    } catch (err) {
      // A genuine internal fault — a disk that went away, a lock that could
      // not be taken. This one IS an error, and it is worth a stderr line
      // because the agent's copy is all the user would otherwise see.
      const message = err instanceof Error ? err.message : String(err);
      logStderr(`${name} failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: `error — ${name} failed: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Start the server on stdio and keep it up. Resolves once the transport is
 * listening; the process then stays alive on stdin.
 */
export async function startMcpServer(
  opts: McpServerOptions = {},
): Promise<McpServerHandle> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr(`ready on stdio (${createContext(opts).paths.graphFile})`);
  return {
    server,
    transport,
    close: async () => {
      await server.close();
    },
  };
}

/**
 * Register `diagram mcp` — the same stdio server as the `diagram-mcp` binary,
 * reached through the main CLI.
 *
 * Both exist on purpose. The spec's .mcp.json (§4.1) launches
 * `npx -y diagram-engine mcp`, i.e. the package's default binary plus a
 * subcommand, and that is what `diagram init` writes; `diagram-mcp` is the
 * direct entry point for anything that would rather spawn a binary than a
 * subcommand. One server, two doors — not two servers.
 *
 * Nothing here may print: stdout is the JSON-RPC channel from the moment the
 * transport connects.
 */
export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('run the MCP server on stdio (what .mcp.json launches)')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action(async (opts: { dir?: string }) => {
      const handle = await startMcpServer({
        ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
      });
      const shutdown = (): void => {
        void handle.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      // The transport keeps the process alive on stdin.
    });
}
