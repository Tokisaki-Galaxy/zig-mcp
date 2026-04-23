/// <reference types="@cloudflare/workers-types" />

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import type { ZigDocsEnv } from "./r2-docs.js";
import { registerWorkerTools } from "./tools.js";

const MCP_VERSION = "1.4.1";
const GITHUB_REPOSITORY_URL = "https://github.com/tokisaki-galaxy/zig-mcp";

function createLandingPage() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Zig Docs MCP</title>
    <style>
        :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
        main { max-width: 720px; line-height: 1.6; }
        a { color: inherit; }
        .card { padding: 24px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 16px; }
        .links { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 16px; }
        code { padding: 2px 6px; border-radius: 6px; background: color-mix(in srgb, currentColor 10%, transparent); }
    </style>
</head>
<body>
    <main class="card">
        <h1>Zig Docs MCP</h1>
        <p>This Worker serves Zig documentation over remote MCP at <code>/mcp</code>.</p>
        <p>Use the MCP endpoint in a client, or browse the source repository for setup and deployment details.</p>
        <div class="links">
            <a href="/mcp">Open MCP endpoint</a>
            <a href="${GITHUB_REPOSITORY_URL}">GitHub repository</a>
        </div>
    </main>
</body>
</html>`;
}

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

function isRootPath(pathname: string): boolean {
    return pathname === "/";
}

export default {
    fetch(request: Request, env: ZigDocsEnv, ctx: ExecutionContext) {
        const { pathname } = new URL(request.url);
        if (isRootPath(pathname)) {
            return new Response(createLandingPage(), {
                headers: {
                    "content-type": "text/html; charset=utf-8",
                },
            });
        }

        if (!isMcpPath(pathname)) {
            return new Response("Not Found", { status: 404 });
        }

        const server = createServer(env);
        return createMcpHandler(server as never)(request, env, ctx);
    },
};
