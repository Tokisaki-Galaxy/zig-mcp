/// <reference types="@cloudflare/workers-types" />

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { getStdLibItem, searchStdLib } from "../mcp/std.js";
import {
    type BuiltinFunction,
    normalizeBuiltinQuery,
    toolResult,
    type ZigDocsEnv,
    type ZigDocsLatestIndex,
    ZigDocsR2Store,
} from "./r2-docs.js";

function formatBuiltinResults(functions: BuiltinFunction[]): string {
    const functionList = functions.map((fn) => `- ${fn.signature}`).join("\n");
    return `Available ${functions.length} builtin functions:\n\n${functionList}`;
}

function formatLatestVersion(index: ZigDocsLatestIndex): string {
    const versions = index.versions.join(", ");
    const lines = [`Latest Zig docs version: ${index.latestVersion}`];

    if (versions.length > 0) {
        lines.push(`Available versions: ${versions}`);
    }

    if (index.updatedAt) {
        lines.push(`Updated at: ${index.updatedAt}`);
    }

    return lines.join("\n");
}

function createListBuiltinFunctionsTool(store: ZigDocsR2Store) {
    return {
        name: "list_builtin_functions",
        config: {
            description:
                "Lists all available Zig builtin functions for a specific version. Provide an optional version to inspect a different Zig release than the default.",
            inputSchema: {
                version: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Optional Zig version to inspect (for example: master, 0.14.1)"),
            },
        },
        handler: async ({ version }: { version?: string }) => {
            try {
                const builtins = await store.loadBuiltins(version);
                return toolResult(formatBuiltinResults(builtins));
            } catch (error) {
                return toolResult(
                    `Unable to list builtin functions: ${error instanceof Error ? error.message : String(error)}`,
                    true,
                );
            }
        },
    };
}

function createGetLatestVersionTool(store: ZigDocsR2Store) {
    return {
        name: "get_latest_version",
        config: {
            description:
                "Returns the latest published Zig docs version and the available version list from R2.",
            inputSchema: {
                include_versions: z
                    .boolean()
                    .default(true)
                    .describe("Include the version list in the response (default: true)"),
            },
        },
        handler: async ({ include_versions = true }: { include_versions?: boolean }) => {
            try {
                const index = await store.loadLatestIndex();
                const message = include_versions
                    ? formatLatestVersion(index)
                    : `Latest Zig docs version: ${index.latestVersion}`;
                return toolResult(message);
            } catch (error) {
                return toolResult(
                    `Unable to get the latest Zig docs version: ${error instanceof Error ? error.message : String(error)}`,
                    true,
                );
            }
        },
    };
}

function createGetBuiltinFunctionTool(store: ZigDocsR2Store) {
    return {
        name: "get_builtin_function",
        config: {
            description:
                "Search for Zig builtin functions by name and get their documentation, signatures, and usage information. Provide an optional version to inspect a different Zig release than the default.",
            inputSchema: {
                function_name: z
                    .string()
                    .min(1, "Query cannot be empty")
                    .describe(
                        "Function name or keywords (for example: '@addWithOverflow', 'overflow', 'atomic')",
                    ),
                version: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Optional Zig version to inspect (for example: master, 0.14.1)"),
            },
        },
        handler: async ({
            function_name,
            version,
        }: {
            function_name: string;
            version?: string;
        }) => {
            try {
                const builtins = await store.loadBuiltins(version);
                const normalizedQuery = normalizeBuiltinQuery(function_name);
                const queryLower = normalizedQuery.toLowerCase();

                if (!queryLower) {
                    return toolResult(
                        "Please provide a builtin function name or keywords. Try searching for a function name like '@addWithOverflow' or keywords like 'overflow' or 'atomic'.",
                        true,
                    );
                }

                const scoredFunctions = builtins
                    .map((fn) => {
                        const funcLower = fn.func.toLowerCase();
                        let score = 0;

                        if (funcLower === queryLower) score += 1000;
                        else if (funcLower.startsWith(queryLower)) score += 500;
                        else if (funcLower.includes(queryLower)) score += 300;

                        if (score > 0) score += Math.max(0, 50 - fn.func.length);

                        return { ...fn, score };
                    })
                    .filter((fn) => fn.score > 0);

                scoredFunctions.sort((a, b) => b.score - a.score);

                if (scoredFunctions.length === 0) {
                    return toolResult(
                        `No builtin functions found matching "${normalizedQuery}". Try using 'list_builtin_functions' to see available functions, or refine your search terms.`,
                        true,
                    );
                }

                const results = scoredFunctions
                    .map((fn) => `**${fn.func}**\n\`\`\`zig\n${fn.signature}\n\`\`\`\n\n${fn.docs}`)
                    .join("\n\n---\n\n");

                const message =
                    scoredFunctions.length === 1
                        ? results
                        : `Found ${scoredFunctions.length} matching functions:\n\n${results}`;

                return toolResult(message);
            } catch (error) {
                return toolResult(
                    `Unable to get builtin function docs: ${error instanceof Error ? error.message : String(error)}`,
                    true,
                );
            }
        },
    };
}

function createSearchStdLibTool(store: ZigDocsR2Store) {
    return {
        name: "search_std_lib",
        config: {
            description:
                "Search the Zig standard library for functions, types, namespaces, and other declarations. Provide an optional version to inspect a different Zig release than the default.",
            inputSchema: {
                query: z
                    .string()
                    .min(1, "Search query cannot be empty")
                    .describe(
                        "Search terms to find in the standard library (for example: 'ArrayList', 'print', 'allocator', 'HashMap')",
                    ),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .default(20)
                    .describe("Maximum number of results to return (default: 20)"),
                version: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Optional Zig version to inspect (for example: master, 0.14.1)"),
            },
        },
        handler: async ({
            query,
            limit = 20,
            version,
        }: {
            query: string;
            limit: number;
            version?: string;
        }) => {
            try {
                const { wasmBytes, sourcesBytes } = await store.loadStdlibAssets(version);
                const normalizedQuery = query.trim();
                if (!normalizedQuery) {
                    return toolResult("Search query cannot be empty.", true);
                }

                const markdown = await searchStdLib(
                    wasmBytes,
                    sourcesBytes,
                    normalizedQuery,
                    limit,
                );
                return toolResult(markdown);
            } catch (error) {
                return toolResult(
                    `Unable to search the standard library: ${error instanceof Error ? error.message : String(error)}`,
                    true,
                );
            }
        },
    };
}

function createGetStdLibItemTool(store: ZigDocsR2Store) {
    return {
        name: "get_std_lib_item",
        config: {
            description:
                "Get detailed documentation for a specific item in the Zig standard library. Provide the fully qualified name and an optional version to inspect a different Zig release than the default.",
            inputSchema: {
                name: z
                    .string()
                    .min(1, "Item name cannot be empty")
                    .describe(
                        "Fully qualified name of the standard library item (for example: 'std.ArrayList', 'std.debug.print', 'std.mem.Allocator')",
                    ),
                get_source_file: z
                    .boolean()
                    .default(false)
                    .describe(
                        "Return the entire source file where this item is implemented (default: false - shows detailed documentation with item source code only)",
                    ),
                version: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Optional Zig version to inspect (for example: master, 0.14.1)"),
            },
        },
        handler: async ({
            name,
            get_source_file = false,
            version,
        }: {
            name: string;
            get_source_file: boolean;
            version?: string;
        }) => {
            try {
                const { wasmBytes, sourcesBytes } = await store.loadStdlibAssets(version);
                const markdown = await getStdLibItem(
                    wasmBytes,
                    sourcesBytes,
                    name,
                    get_source_file,
                );
                return toolResult(markdown);
            } catch (error) {
                return toolResult(
                    `Unable to get standard library item: ${error instanceof Error ? error.message : String(error)}`,
                    true,
                );
            }
        },
    };
}

export function registerWorkerTools(mcpServer: McpServer, env: ZigDocsEnv) {
    const store = new ZigDocsR2Store(env.ZIG_DOCS, env.DEFAULT_ZIG_VERSION);

    const getLatestVersion = createGetLatestVersionTool(store);
    mcpServer.registerTool(
        getLatestVersion.name,
        getLatestVersion.config,
        getLatestVersion.handler,
    );

    const listBuiltinFunctions = createListBuiltinFunctionsTool(store);
    mcpServer.registerTool(
        listBuiltinFunctions.name,
        listBuiltinFunctions.config,
        listBuiltinFunctions.handler,
    );

    const getBuiltinFunction = createGetBuiltinFunctionTool(store);
    mcpServer.registerTool(
        getBuiltinFunction.name,
        getBuiltinFunction.config,
        getBuiltinFunction.handler,
    );

    const searchStdLib = createSearchStdLibTool(store);
    mcpServer.registerTool(searchStdLib.name, searchStdLib.config, searchStdLib.handler);

    const getStdLibItem = createGetStdLibItemTool(store);
    mcpServer.registerTool(getStdLibItem.name, getStdLibItem.config, getStdLibItem.handler);
}
