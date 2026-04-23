import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface Args {
    version: string;
    bundleDir: string;
    bucket: string;
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
        bundleDir: "bundle",
        bucket: "zig-docs",
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--version" && i + 1 < argv.length) {
            args.version = argv[++i];
        } else if (arg === "--bundle" && i + 1 < argv.length) {
            args.bundleDir = argv[++i];
        } else if (arg === "--bucket" && i + 1 < argv.length) {
            args.bucket = argv[++i];
        }
    }

    return args;
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

function readLatestIndex(bucket: string, key: string): ZigDocsLatestIndex | null {
    const result = spawnSync(
        "bunx",
        ["wrangler", "r2", "object", "get", `${bucket}/${key}`, "--pipe", "--remote"],
        {
            encoding: "utf8",
            shell: true,
        },
    );

    if (result.status !== 0) {
        return null;
    }

    const stdout = result.stdout?.trim();
    if (!stdout) {
        return null;
    }

    try {
        return normalizeLatestIndex(JSON.parse(stdout) as ZigDocsLatestIndexRaw);
    } catch (error) {
        throw new Error(
            `Failed to parse existing latest index from R2: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

function readLatestIndexFile(filePath: string): ZigDocsLatestIndex | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return normalizeLatestIndex(JSON.parse(raw) as ZigDocsLatestIndexRaw);
    } catch (error) {
        throw new Error(
            `Failed to parse local latest index from ${filePath}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

function mergeLatestIndexes(
    version: string,
    ...indexes: Array<ZigDocsLatestIndex | null>
): ZigDocsLatestIndex {
    const versions = [version, ...indexes.flatMap((index) => index?.versions ?? [])];
    const uniqueVersions = Array.from(new Set(versions));

    return {
        latestVersion: version,
        versions: uniqueVersions,
        updatedAt: new Date().toISOString(),
    };
}

function uploadObject(bucket: string, key: string, filePath: string, contentType: string) {
    const objectPath = `${bucket}/${key}`;
    const result = spawnSync(
        "bunx",
        [
            "wrangler",
            "r2",
            "object",
            "put",
            objectPath,
            "--file",
            filePath,
            "--content-type",
            contentType,
            "--remote",
            "--force",
        ],
        {
            stdio: "inherit",
            shell: true,
        },
    );

    if (result.status !== 0) {
        throw new Error(`Failed to upload ${objectPath}`);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const versionDir = path.resolve(args.bundleDir, "zig", args.version);

    const manifestPath = path.join(versionDir, "manifest.json");
    const builtinPath = path.join(versionDir, "builtin-functions.json");
    const wasmPath = path.join(versionDir, "main.wasm");
    const sourcesPath = path.join(versionDir, "sources.tar");
    const latestPath = path.resolve(args.bundleDir, "zig", "latest.json");

    for (const filePath of [manifestPath, builtinPath, wasmPath, sourcesPath, latestPath]) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Missing bundle file: ${filePath}`);
        }
    }

    const localLatest = readLatestIndexFile(latestPath);
    const remoteLatest = readLatestIndex(args.bucket, "zig/latest.json");
    const mergedLatest = mergeLatestIndexes(args.version, localLatest, remoteLatest);
    fs.writeFileSync(latestPath, JSON.stringify(mergedLatest, null, 2));

    uploadObject(
        args.bucket,
        `zig/${args.version}/manifest.json`,
        manifestPath,
        "application/json",
    );
    uploadObject(
        args.bucket,
        `zig/${args.version}/builtin-functions.json`,
        builtinPath,
        "application/json",
    );
    uploadObject(args.bucket, `zig/${args.version}/main.wasm`, wasmPath, "application/wasm");
    uploadObject(args.bucket, `zig/${args.version}/sources.tar`, sourcesPath, "application/x-tar");
    uploadObject(args.bucket, "zig/latest.json", latestPath, "application/json");

    console.log(`Uploaded R2 bundle for ${args.version} to bucket ${args.bucket}`);
}

main();
