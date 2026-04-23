/// <reference types="@cloudflare/workers-types" />

import { buildSourceFileIndex, renderSourceMarkdown } from "../mcp/std.js";

export interface BuiltinFunction {
    func: string;
    signature: string;
    docs: string;
}

export interface ZigDocsManifest {
    version: string;
    builtinsKey: string;
    itemDocsKey: string;
    sourcesKey: string;
    searchIndexKey?: string;
}

export interface ZigDocsLatestIndex {
    latestVersion: string;
    versions: string[];
    updatedAt?: string;
}

export interface ZigDocsEnv {
    ZIG_DOCS: R2Bucket;
}

interface ZigDocsLatestIndexRaw {
    latestVersion?: string;
    version?: string;
    versions?: unknown;
    updatedAt?: string;
}

export interface StdSearchEntry {
    name: string;
    fqn: string;
    kind: string;
    summary?: string;
}

export interface StdSearchIndex {
    version: string;
    builtAt: string;
    entries: StdSearchEntry[];
}

export interface StdLibItemDoc {
    markdown: string;
    sourcePath: string;
}

export interface StdLibItemIndex {
    version: string;
    builtAt: string;
    items: Record<string, StdLibItemDoc>;
}

export interface SourceFileIndex {
    version: string;
    builtAt: string;
    files: Record<string, string>;
}

export interface ZigDocsStatus {
    latestVersion: string;
    versions: string[];
    itemDocsAvailable: boolean;
    searchIndexAvailable: boolean;
    itemDocsVersion?: string;
    searchIndexVersion?: string;
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
const searchIndexCache = new Map<string, Promise<StdSearchIndex>>();
const itemDocsCache = new Map<string, Promise<StdLibItemIndex>>();
const sourceIndexCache = new Map<string, Promise<SourceFileIndex>>();
const builtinsCache = new Map<string, Promise<BuiltinFunction[]>>();
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
    constructor(private readonly bucket: R2Bucket) {}

    async resolveVersion(version?: string): Promise<string> {
        const explicitVersion = normalizeVersion(version);
        if (explicitVersion) {
            return explicitVersion;
        }

        const latest = await this.loadLatestIndex();
        const latestVersion = normalizeVersion(latest.latestVersion);
        if (latestVersion) {
            return latestVersion;
        }

        throw new Error(
            "Missing Zig docs version. Pass a version or ensure zig/latest.json is available.",
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

    async loadSearchIndex(version?: string): Promise<StdSearchIndex | null> {
        const manifest = await this.loadManifest(version);
        if (!manifest.searchIndexKey) {
            return null;
        }

        return await this.cachedLoad(searchIndexCache, manifest.searchIndexKey, () =>
            readJson<StdSearchIndex>(this.bucket, manifest.searchIndexKey as string),
        );
    }

    async loadStdLibItemIndex(version?: string): Promise<StdLibItemIndex> {
        const manifest = await this.loadManifest(version);
        return await this.cachedLoad(itemDocsCache, manifest.itemDocsKey, () =>
            readJson<StdLibItemIndex>(this.bucket, manifest.itemDocsKey),
        );
    }

    async loadSourceIndex(version?: string): Promise<SourceFileIndex> {
        const manifest = await this.loadManifest(version);
        return await this.cachedLoad(sourceIndexCache, manifest.sourcesKey, async () => {
            const sourcesBytes = await this.loadSources(version);
            return buildSourceFileIndex(sourcesBytes, manifest.version);
        });
    }

    async loadStatus(): Promise<ZigDocsStatus> {
        const latest = await this.loadLatestIndex();
        await this.loadManifest(latest.latestVersion);
        let itemDocs: StdLibItemIndex | null = null;
        let searchIndex: StdSearchIndex | null = null;
        try {
            itemDocs = await this.loadStdLibItemIndex(latest.latestVersion);
        } catch {
            itemDocs = null;
        }

        try {
            searchIndex = await this.loadSearchIndex(latest.latestVersion);
        } catch {
            searchIndex = null;
        }

        return {
            latestVersion: latest.latestVersion,
            versions: latest.versions,
            itemDocsAvailable: itemDocs !== null,
            searchIndexAvailable: searchIndex !== null,
            ...(itemDocs ? { itemDocsVersion: itemDocs.version } : {}),
            ...(searchIndex ? { searchIndexVersion: searchIndex.version } : {}),
        };
    }

    async loadBuiltins(version?: string): Promise<BuiltinFunction[]> {
        const manifest = await this.loadManifest(version);
        return await this.cachedLoad(builtinsCache, manifest.builtinsKey, () =>
            readJson<BuiltinFunction[]>(this.bucket, manifest.builtinsKey),
        );
    }

    async loadSources(version?: string): Promise<Uint8Array<ArrayBuffer>> {
        const manifest = await this.loadManifest(version);
        return await this.cachedLoad(sourcesCache, manifest.sourcesKey, () =>
            readBytes(this.bucket, manifest.sourcesKey),
        );
    }

    async loadStdLibItemMarkdown(version: string | undefined, name: string): Promise<string> {
        const itemIndex = await this.loadStdLibItemIndex(version);
        const item = itemIndex.items[name];
        if (!item) {
            throw new Error(`Missing stdlib item docs: ${name}`);
        }

        return item.markdown;
    }

    async loadStdLibItemSourceMarkdown(version: string | undefined, name: string): Promise<string> {
        const itemIndex = await this.loadStdLibItemIndex(version);
        const item = itemIndex.items[name];
        if (!item) {
            throw new Error(`Missing stdlib item docs: ${name}`);
        }

        const sourceIndex = await this.loadSourceIndex(version);
        const sourcePath = item.sourcePath.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
        const source = sourceIndex.files[sourcePath];
        if (!source) {
            throw new Error(`Missing source file: ${sourcePath}`);
        }

        return renderSourceMarkdown(sourcePath, source);
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
