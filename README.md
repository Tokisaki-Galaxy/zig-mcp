# Zig Docs MCP

<p align="center">
  <img alt="Zig" src="https://img.shields.io/badge/Zig-0xF7A41D?style=for-the-badge&logo=zig&logoColor=white" />
  <img alt="Bun" src="https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-6366F1?style=for-the-badge" />
  <img alt="R2" src="https://img.shields.io/badge/Cloudflare_R2-2B2B2B?style=for-the-badge&logo=cloudflare&logoColor=white" />
</p>

<p align="center">
  <a href="#zh-cn">中文</a>
</p>

Model Context Protocol (MCP) server for Zig documentation, deployed as a Cloudflare Worker.

The Worker serves docs over remote MCP at `/mcp` and reads versioned Zig artifacts from R2. A separate snapshot step packages pre-rendered item docs, `sources.tar`, builtin metadata, and search indexes for upload.

> [!TIP]
> Add `use zigdocs` to your prompt if you want to explicitly instruct the LLM to use Zig docs tools. Otherwise, LLM will automatically decide when to utilize MCP tools based on the context of your questions.

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

<a id="zh-cn"></a>

## 中文

这是一个面向 Zig 文档的 MCP 服务，部署在 Cloudflare Worker 上。它会通过远程 MCP 提供 Zig 标准库和 builtin 文档，并把版本化文档打包到 R2，方便客户端按版本查询。

### 工具

- `list_builtin_functions`：列出 Zig builtin 函数
- `get_latest_version`：获取最新文档版本和版本列表
- `get_builtin_function`：按名称查询 builtin 文档
- `search_std_lib`：搜索标准库符号
- `get_std_lib_item`：按完整名称获取标准库条目文档

### 命令

```bash
# 本地运行 Worker
bun run dev:worker

# 构建 Zig WASM
zig build

# 生成 R2 bundle
bun run snapshot:prepare -- --version 0.14.1 --out ./bundle

# 上传到 R2
bun run snapshot:publish -- --bundle ./bundle --bucket zig-docs

# 清空 R2 bucket
bun run snapshot:clear -- --bucket zig-docs --force
# or it
bun run snapshot:clear -- --bucket zig-docs --force --access-key-id xxxx --secret-access-key xxxx

# 部署 Worker
bun run deploy:worker
```

> 需要 Zig 0.16.0 或更高版本。`zig build` 失败时，`snapshot:prepare` 也无法从 `zig-out/bin/main.wasm` 预渲染文档。

### MCP 客户端配置

```json
{
  "mcpServers": {
    "zig-docs": {
      "url": "https://<your-worker>.workers.dev/mcp"
    }
  }
}
```
