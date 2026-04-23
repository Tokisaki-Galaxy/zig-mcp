import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface Args {
    version: string;
    bundleDir: string;
    bucket: string;
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
