# Zig Docs MCP

Model Context Protocol (MCP) server for Zig documentation, deployed as a Cloudflare Worker.

The Worker serves docs over remote MCP at `/mcp` and reads versioned Zig artifacts from R2. A separate snapshot step packages pre-rendered item docs, `sources.tar`, builtin metadata, and search indexes for upload.

> [!TIP]
> Add `use zigdocs` to your prompt if you want to explicitly instruct the LLM to use Zig docs tools. Otherwise, LLM will automatically decide when to utilize MCP tools based on the context of your questions.

<p align="center" width="100%">
  <img src="https://raw.githubusercontent.com/zig-wasm/.github/refs/heads/main/static/readme_mcp_1.gif" width="49%" />
  <img src="https://raw.githubusercontent.com/zig-wasm/.github/refs/heads/main/static/readme_mcp_2.gif" width="49%" />
</p>

## Tools

- **`list_builtin_functions`** - Lists all available Zig builtin functions. Builtin functions are provided by the compiler and are prefixed with '@'. The comptime keyword on a parameter means that the parameter must be known at compile time. Use this to discover what functions are available, then use 'get_builtin_function' to get detailed documentation.
- **`get_latest_version`** - Returns the latest published Zig docs version and the full list of versions stored in R2.
- **`get_builtin_function`** - Search for Zig builtin functions by name and get their documentation, signatures, and usage information. Returns all matching functions ranked by relevance.
- **`search_std_lib`** - Search the Zig standard library for declarations by name. Returns a list of matching items with their fully qualified names. Use this to discover available types, functions, and constants in the standard library.
- **`get_std_lib_item`** - Get detailed documentation for a specific standard library item by its fully qualified name (e.g., "std.ArrayList.init"). Returns comprehensive documentation including function signatures, parameters, errors, examples, and source code. Set `get_source_file: true` to retrieve the entire source file where the item is implemented.

## Commands

```bash
# Run the Worker locally
bun run dev:worker

# Build the Zig WASM artifact
zig build

# Prepare a versioned R2 bundle
bun run snapshot:prepare -- --version 0.14.1 --out ./bundle

# Upload the bundle to R2
bun run snapshot:publish -- --bundle ./bundle --bucket zig-docs

# Delete all objects from the R2 bucket
bun run snapshot:clear -- --bucket zig-docs --force
# or it
bun run snapshot:clear -- --bucket zig-docs --force --access-key-id xxxx --secret-access-key xxxx

# Deploy the Worker
bun run deploy:worker
```

> Requires Zig 0.16.0 or newer. If `zig build` fails, `snapshot:prepare` won't be able to pre-render the docs from `zig-out/bin/main.wasm`.

> `snapshot:prepare` only builds the local bundle. `snapshot:publish` uploads every version listed in `bundle/zig/latest.json` and merges the latest index with R2.

> If rich stdlib item rendering panics during `snapshot:prepare`, the bundle now stores a plain fallback document instead of skipping that item.

> `snapshot:clear` is destructive. It deletes every object in the target bucket and only runs when `--force` is present.

> `zig/latest.json` is now a version index. Each publish keeps older versions in R2 and updates the latest pointer.

## MCP client config

Use the Worker URL with an MCP client that supports remote servers:

```json
{
  "mcpServers": {
    "zig-docs": {
      "url": "https://<your-worker>.workers.dev/mcp"
    }
  }
}
```
