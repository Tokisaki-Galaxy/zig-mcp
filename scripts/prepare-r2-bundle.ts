import * as fs from "node:fs";
import * as path from "node:path";
import { downloadSourcesTar } from "../mcp/docs.js";
import extractBuiltinFunctions from "../mcp/extract-builtin-functions.js";

interface Args {
    version: string;
    wasmPath: string;
    outDir: string;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        version: "master",
        wasmPath: "",
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

    if (!args.wasmPath) {
        throw new Error("Missing --wasm <path>.");
    }

    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const wasmSource = path.resolve(args.wasmPath);
    if (!fs.existsSync(wasmSource)) {
        throw new Error(`WASM file not found: ${wasmSource}`);
    }

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
    fs.writeFileSync(
        path.join(outRoot, "zig", "latest.json"),
        JSON.stringify({ version: args.version }, null, 2),
    );

    console.log(`Prepared R2 bundle in ${outRoot}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
