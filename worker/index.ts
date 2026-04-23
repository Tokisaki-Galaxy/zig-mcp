/// <reference types="@cloudflare/workers-types" />

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import type { ZigDocsEnv } from "./r2-docs.js";
import { registerWorkerTools } from "./tools.js";

const MCP_VERSION = "1.4.1";

function createServer(env: ZigDocsEnv): McpServer {
    const mcpServer = new McpServer({
        name: "ZigDocs",
        description:
            "Retrieves up-to-date documentation for the Zig programming language standard library and builtin functions.",
        version: MCP_VERSION,
    });

    registerWorkerTools(mcpServer, env);
    return mcpServer;
}

function isMcpPath(pathname: string): boolean {
    return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

export default {
    fetch(request: Request, env: ZigDocsEnv, ctx: ExecutionContext) {
        const { pathname } = new URL(request.url);
        if (!isMcpPath(pathname)) {
            return new Response("Not Found", { status: 404 });
        }

        const server = createServer(env);
        return createMcpHandler(server as never)(request, env, ctx);
    },
};
