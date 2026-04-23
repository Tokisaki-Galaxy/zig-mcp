/// <reference types="@cloudflare/workers-types" />

export interface BuiltinFunction {
    func: string;
    signature: string;
    docs: string;
}

export interface ZigDocsManifest {
    version: string;
    builtinsKey: string;
    wasmKey: string;
    sourcesKey: string;
}

export interface ZigDocsLatestIndex {
    latestVersion: string;
    versions: string[];
    updatedAt?: string;
}

export interface ZigDocsEnv {
    ZIG_DOCS: R2Bucket;
    DEFAULT_ZIG_VERSION?: string;
}

interface ZigDocsLatestIndexRaw {
    latestVersion?: string;
    version?: string;
    versions?: unknown;
    updatedAt?: string;
}

function normalizeVersion(value: string | undefined): string | null {
    const version = value?.trim();
    return version && version.length > 0 ? version : null;
}

function normalizeVersionList(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }

    const normalized = values
        .filter((value): value is string => typeof value === "string")
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

const manifestCache = new Map<string, Promise<ZigDocsManifest>>();
const latestIndexCache = new Map<string, Promise<ZigDocsLatestIndex>>();
const builtinsCache = new Map<string, Promise<BuiltinFunction[]>>();
const wasmCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
const sourcesCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T> {
    const object = await bucket.get(key);
    if (!object) {
        throw new Error(`Missing R2 object: ${key}`);
    }

    return (await new Response(object.body).json()) as T;
}

async function readBytes(bucket: R2Bucket, key: string): Promise<Uint8Array<ArrayBuffer>> {
    const object = await bucket.get(key);
    if (!object) {
        throw new Error(`Missing R2 object: ${key}`);
    }

    const buffer = await new Response(object.body).arrayBuffer();
    return new Uint8Array(buffer);
}

export function normalizeBuiltinQuery(query: string): string {
    return query.trim().replace(/^@+/, "");
}

export function toolResult(text: string, isError = false) {
    return {
        content: [
            {
                type: "text" as const,
                text,
            },
        ],
        ...(isError ? { isError: true as const } : {}),
    };
}

export class ZigDocsR2Store {
    constructor(
        private readonly bucket: R2Bucket,
        private readonly defaultVersion?: string,
    ) {}

    async resolveVersion(version?: string): Promise<string> {
        const explicitVersion = normalizeVersion(version);
        if (explicitVersion) {
            return explicitVersion;
        }

        const configuredVersion = normalizeVersion(this.defaultVersion);
        if (configuredVersion) {
            return configuredVersion;
        }

        const latest = await this.loadLatestIndex();
        const latestVersion = normalizeVersion(latest.latestVersion);
        if (latestVersion) {
            return latestVersion;
        }

        throw new Error(
            "Missing Zig docs version. Pass a version or configure DEFAULT_ZIG_VERSION.",
        );
    }

    async loadManifest(version?: string): Promise<ZigDocsManifest> {
        const resolvedVersion = await this.resolveVersion(version);
        return await this.cachedLoad(manifestCache, resolvedVersion, () =>
            readJson<ZigDocsManifest>(this.bucket, this.manifestKey(resolvedVersion)),
        );
    }

    async loadLatestIndex(): Promise<ZigDocsLatestIndex> {
        return await this.cachedLoad(latestIndexCache, "zig/latest.json", async () => {
            const latest = await this.tryReadJson<ZigDocsLatestIndexRaw>("zig/latest.json");
            const normalized = normalizeLatestIndex(latest);
            if (!normalized) {
                throw new Error("Missing Zig docs latest index in zig/latest.json.");
            }

            return normalized;
        });
    }

    async loadBuiltins(version?: string): Promise<BuiltinFunction[]> {
        const manifest = await this.loadManifest(version);
        return await this.cachedLoad(builtinsCache, manifest.builtinsKey, () =>
            readJson<BuiltinFunction[]>(this.bucket, manifest.builtinsKey),
        );
    }

    async loadWasm(version?: string): Promise<Uint8Array<ArrayBuffer>> {
        const manifest = await this.loadManifest(version);
        return await this.cachedLoad(wasmCache, manifest.wasmKey, () =>
            readBytes(this.bucket, manifest.wasmKey),
        );
    }

    async loadSources(version?: string): Promise<Uint8Array<ArrayBuffer>> {
        const manifest = await this.loadManifest(version);
        return await this.cachedLoad(sourcesCache, manifest.sourcesKey, () =>
            readBytes(this.bucket, manifest.sourcesKey),
        );
    }

    async loadStdlibAssets(version?: string): Promise<{
        manifest: ZigDocsManifest;
        wasmBytes: Uint8Array<ArrayBuffer>;
        sourcesBytes: Uint8Array<ArrayBuffer>;
    }> {
        const manifest = await this.loadManifest(version);
        const [wasmBytes, sourcesBytes] = await Promise.all([
            this.loadWasm(version),
            this.loadSources(version),
        ]);

        return {
            manifest,
            wasmBytes,
            sourcesBytes,
        };
    }

    private manifestKey(version: string): string {
        return `zig/${version}/manifest.json`;
    }

    private async tryReadJson<T>(key: string): Promise<T | null> {
        const object = await this.bucket.get(key);
        if (!object) {
            return null;
        }

        return (await new Response(object.body).json()) as T;
    }

    private cachedLoad<T>(
        cache: Map<string, Promise<T>>,
        key: string,
        loader: () => Promise<T>,
    ): Promise<T> {
        const cached = cache.get(key);
        if (cached) {
            return cached;
        }

        const promise = loader().catch((error) => {
            cache.delete(key);
            throw error;
        });
        cache.set(key, promise);
        return promise;
    }
}
