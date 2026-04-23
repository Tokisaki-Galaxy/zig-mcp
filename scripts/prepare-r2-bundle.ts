import * as fs from "node:fs";
import * as path from "node:path";
import { downloadSourcesTar } from "../mcp/docs.js";
import extractBuiltinFunctions from "../mcp/extract-builtin-functions.js";

interface Args {
    version: string;
    wasmPath: string;
    outDir: string;
}

interface ZigDocsLatestIndex {
    latestVersion: string;
    versions: string[];
    updatedAt?: string;
}

interface ZigDocsLatestIndexRaw {
    latestVersion?: unknown;
    version?: unknown;
    versions?: unknown;
    updatedAt?: unknown;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        version: "master",
        wasmPath: "zig-out/bin/main.wasm",
        outDir: "bundle",
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--version" && i + 1 < argv.length) {
            args.version = argv[++i];
        } else if (arg === "--wasm" && i + 1 < argv.length) {
            args.wasmPath = argv[++i];
        } else if (arg === "--out" && i + 1 < argv.length) {
            args.outDir = argv[++i];
        }
    }

    return args;
}

function resolveWasmPath(inputPath: string): string {
    const candidates = [
        path.resolve(inputPath),
        path.resolve("zig-out/bin/main.wasm"),
        path.resolve("zig-out/main.wasm"),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `WASM file not found. Looked in: ${candidates.join(", ")}. Run \`zig build\` first, then try again.`,
    );
}

function normalizeVersion(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const version = value.trim();
    return version.length > 0 ? version : null;
}

function normalizeVersionList(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }

    const normalized = values
        .map((value) => normalizeVersion(value))
        .filter((value): value is string => value !== null);

    return Array.from(new Set(normalized));
}

function normalizeLatestIndex(value: ZigDocsLatestIndexRaw | null): ZigDocsLatestIndex | null {
    if (!value) {
        return null;
    }

    const versions = normalizeVersionList(value.versions);
    const latestVersion = normalizeVersion(value.latestVersion ?? value.version) ?? versions[0];
    if (!latestVersion) {
        return null;
    }

    const orderedVersions = [latestVersion];
    for (const version of versions) {
        if (version !== latestVersion && !orderedVersions.includes(version)) {
            orderedVersions.push(version);
        }
    }

    return {
        latestVersion,
        versions: orderedVersions,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    };
}

function readLatestIndex(filePath: string): ZigDocsLatestIndex | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeLatestIndex(JSON.parse(raw) as ZigDocsLatestIndexRaw);
}

function mergeLatestIndex(
    existing: ZigDocsLatestIndex | null,
    version: string,
): ZigDocsLatestIndex {
    const versions = [version, ...(existing?.versions ?? [])];
    const uniqueVersions = Array.from(new Set(versions));

    return {
        latestVersion: version,
        versions: uniqueVersions,
        updatedAt: new Date().toISOString(),
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const wasmSource = resolveWasmPath(args.wasmPath);

    const outRoot = path.resolve(args.outDir);
    const versionDir = path.join(outRoot, "zig", args.version);
    fs.mkdirSync(versionDir, { recursive: true });

    const builtins = await extractBuiltinFunctions(args.version, false, true, "remote");
    const sourcesTar = await downloadSourcesTar(args.version, false, true, "remote");

    fs.copyFileSync(wasmSource, path.join(versionDir, "main.wasm"));
    fs.writeFileSync(path.join(versionDir, "sources.tar"), sourcesTar);
    fs.writeFileSync(
        path.join(versionDir, "builtin-functions.json"),
        JSON.stringify(builtins, null, 2),
    );

    const manifest = {
        version: args.version,
        builtinsKey: `zig/${args.version}/builtin-functions.json`,
        wasmKey: `zig/${args.version}/main.wasm`,
        sourcesKey: `zig/${args.version}/sources.tar`,
    };

    fs.writeFileSync(path.join(versionDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    const latestPath = path.join(outRoot, "zig", "latest.json");
    const existingLatest = readLatestIndex(latestPath);
    const mergedLatest = mergeLatestIndex(existingLatest, args.version);
    fs.writeFileSync(latestPath, JSON.stringify(mergedLatest, null, 2));

    console.log(`Prepared R2 bundle in ${outRoot}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
