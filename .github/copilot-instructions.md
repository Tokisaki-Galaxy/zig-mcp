# Copilot Instructions for zig-mcp

## Project shape

- This repo ships an MCP server for Zig docs.
- The runtime is split between TypeScript/Bun (`mcp/`) and Zig/WASM (`docs/`).
- `mcp/mcp.ts` is the CLI entrypoint. It parses flags, chooses local vs remote docs, and starts either the MCP server, the updater, or the docs viewer.
- `mcp/docs.ts` owns doc caching, remote downloads, the local `zig std` fallback, and the static viewer server.
- `mcp/tools.ts` registers the MCP tools and bridges them to the WASM backend.
- `docs/main.zig` is the WASM backend. `docs/Walk.zig`, `docs/Decl.zig`, and `docs/markdown/*` provide parsing, symbol lookup, and Markdown rendering.
- `build.zig` builds the WASM artifact and installs it alongside the TS assets used by the viewer/server.

## Commands

- Full build/package: `bun run build`
- Zig backend build: `zig build --release`
- Lint: `bun run lint`
- Autofix lint: `bun run lint:fix`
- Typecheck / focused TS check: `bun run typecheck`
- Run the MCP server locally: `bunx zig-mcp --doc-source local`
- Update cached remote docs: `bunx zig-mcp update --version 0.14.1`
- Start the docs viewer: `bunx zig-mcp view --version master`

## Architecture notes

- Local mode defaults to the installed Zig compiler via `zig std`; remote mode downloads docs from ziglang.org and caches them under the platform cache path from `env-paths`.
- Passing `--version` without `--doc-source` switches the CLI to remote docs automatically.
- The viewer serves `index.html`, `std.js`, `main.wasm`, and `sources.tar` from `mcp/`.
- `docs/main.zig` exports the functions consumed by the viewer/search flow; keep TS callers and Zig exports in sync when changing names or signatures.
- The Zig backend tracks compiler internals closely; if `zig build --release` fails after a Zig upgrade, check `docs/Walk.zig` and related AST assumptions first.

## Conventions

- Use Bun/TypeScript ESM style in `mcp/`; the repo is formatted with Biome (4-space indent, double quotes, imports organized automatically).
- Treat generated artifacts as build outputs, not edit targets: `dist/`, `zig-out/`, `mcp/main.wasm`, and `mcp/std.js`.
- `mcp/std.ts` is generated and intentionally excluded from Biome linting.
- Keep MCP tool descriptions and CLI help text aligned; users rely on those strings as the public interface.
- In the Zig docs pipeline, prefer small exports and explicit WASM-facing helpers instead of broad cross-module coupling.
