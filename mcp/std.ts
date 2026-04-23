const CAT_namespace = 0;
const CAT_container = 1;
const CAT_global_variable = 2;
const CAT_function = 3;
const CAT_primitive = 4;
const CAT_error_set = 5;
const CAT_global_const = 6;
const CAT_alias = 7;
const CAT_type = 8;
const CAT_type_type = 9;
const CAT_type_function = 10;

const LOG_err = 0;
const LOG_warn = 1;
const LOG_info = 2;
const LOG_debug = 3;

const domContent: any = typeof document !== "undefined" ? document.getElementById("content") : null;
const domSearch: any = typeof document !== "undefined" ? document.getElementById("search") : null;
const domErrors: any = typeof document !== "undefined" ? document.getElementById("errors") : null;
const domErrorsText: any =
    typeof document !== "undefined" ? document.getElementById("errorsText") : null;

var searchTimer: any = null;

const curNav = {
    tag: 0,
    decl: null,
    path: null,
};
var curNavSearch = "";

const moduleList: any = [];

var wasm_exports: any = null;

const text_decoder = new TextDecoder();
const text_encoder = new TextEncoder();
const runtimeModuleCache = new Map<string, Promise<WebAssembly.Module>>();

declare global {
    interface Window {
        wasm?: any;
    }
}

export interface StdSearchEntry {
    name: string;
    fqn: string;
    kind: string;
    summary?: string;
    terms?: string[];
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

function stripHtml(value: string): string {
    return value
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function categoryName(category: number): string {
    switch (category) {
        case CAT_namespace:
            return "namespace";
        case CAT_container:
            return "container";
        case CAT_global_variable:
            return "global_variable";
        case CAT_function:
            return "function";
        case CAT_primitive:
            return "primitive";
        case CAT_error_set:
            return "error_set";
        case CAT_global_const:
            return "global_const";
        case CAT_alias:
            return "alias";
        case CAT_type:
            return "type";
        case CAT_type_type:
            return "type_type";
        case CAT_type_function:
            return "type_function";
        default:
            return "unknown";
    }
}

function makeSummary(value: string, maxLength = 220): string | undefined {
    const summary = stripHtml(value);
    if (summary.length === 0) {
        return undefined;
    }

    return summary.length > maxLength ? `${summary.slice(0, maxLength).trim()}…` : summary;
}

function tokenizeSearchText(value: string): string[] {
    const normalized = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    return Array.from(
        new Set(
            normalized
                .split(/[^A-Za-z0-9]+/)
                .map((part) => part.trim().toLowerCase())
                .filter((part) => part.length > 0),
        ),
    );
}

interface TarEntry {
    path: string;
    content: string;
}

function readTarString(buffer: Uint8Array<ArrayBuffer>, offset: number, length: number): string {
    const bytes = buffer.slice(offset, offset + length);
    const end = bytes.indexOf(0);
    return text_decoder.decode(end === -1 ? bytes : bytes.slice(0, end)).trim();
}

function readTarOctal(buffer: Uint8Array<ArrayBuffer>, offset: number, length: number): number {
    const raw = readTarString(buffer, offset, length).replace(/\0/g, "").trim();
    return raw.length > 0 ? Number.parseInt(raw, 8) : 0;
}

function parseTarEntries(buffer: Uint8Array<ArrayBuffer>): TarEntry[] {
    const entries: TarEntry[] = [];
    let offset = 0;

    while (offset + 512 <= buffer.length) {
        const block = buffer.subarray(offset, offset + 512);
        const isEmpty = block.every((byte) => byte === 0);
        if (isEmpty) {
            break;
        }

        const name = readTarString(buffer, offset, 100);
        const prefix = readTarString(buffer, offset + 345, 155);
        const size = readTarOctal(buffer, offset + 124, 12);
        const typeFlag = buffer[offset + 156];
        const fullPath = prefix.length > 0 ? `${prefix}/${name}` : name;
        const contentOffset = offset + 512;
        const content = buffer.slice(contentOffset, contentOffset + size);

        if (typeFlag === 0 || typeFlag === 48) {
            entries.push({
                path: fullPath,
                content: text_decoder.decode(content),
            });
        }

        offset = contentOffset + Math.ceil(size / 512) * 512;
    }

    return entries;
}

export function buildSourceFileIndex(
    stdSources: Uint8Array<ArrayBuffer>,
    version: string,
): SourceFileIndex {
    const files: Record<string, string> = Object.create(null);

    for (const entry of parseTarEntries(stdSources)) {
        const normalizedPath = normalizeSourcePath(entry.path);
        if (normalizedPath.endsWith(".zig")) {
            files[normalizedPath] = entry.content;
        }
    }

    return {
        version,
        builtAt: new Date().toISOString(),
        files,
    };
}

function normalizeSourcePath(value: string): string {
    return value.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

export function renderSourceMarkdown(sourcePath: string, source: string): string {
    return `# ${sourcePath}\n\n\`\`\`zig\n${source.replace(/\s+$/g, "")}\n\`\`\``;
}

export function renderPlainStdLibItemMarkdown(
    fqn: string,
    sourcePath?: string,
    source?: string,
): string {
    const lines = [fqn, "", "Rendered in plain mode because rich docs generation failed."];
    if (sourcePath && sourcePath.length > 0) {
        lines.push("", `Source: ${sourcePath}`);
    }
    if (source && source.length > 0) {
        lines.push("", source.replace(/\s+$/g, ""));
    }
    return lines.join("\n");
}

function pushSection(lines: string[], title: string, body: string | undefined): void {
    const trimmed = body?.trim();
    if (!trimmed) {
        return;
    }

    lines.push("", `## ${title}`, "", trimmed);
}

function pushBulletSection(lines: string[], title: string, items: string[]): void {
    if (items.length === 0) {
        return;
    }

    lines.push("", `## ${title}`, "");
    for (const item of items) {
        lines.push(`- ${item}`);
    }
}

function pushDetailedSection(lines: string[], title: string, bodies: string[]): void {
    const trimmedBodies = bodies.map((body) => body.trim()).filter((body) => body.length > 0);
    if (trimmedBodies.length === 0) {
        return;
    }

    lines.push("", `## ${title}`, "");
    for (const body of trimmedBodies) {
        lines.push(body, "");
    }
}

function collectMemberGroups(
    exports: any,
    members: Iterable<number> & { length: number },
): {
    types: string[];
    namespaces: string[];
    errorSets: string[];
    functions: number[];
    globals: number[];
    values: Array<{ original: number; member: number }>;
} {
    const types: string[] = [];
    const namespaces: string[] = [];
    const errorSets: string[] = [];
    const functions: number[] = [];
    const globals: number[] = [];
    const values: Array<{ original: number; member: number }> = [];

    for (const member of members) {
        if (!isValidDeclIndex(member)) {
            continue;
        }

        let current = member;
        const original = member;
        const seen = new Set<number>();

        while (true) {
            if (!isValidDeclIndex(current)) {
                values.push({ original, member: current });
                break;
            }

            const category = exports.categorize_decl(current, 0);
            switch (category) {
                case CAT_namespace:
                    namespaces.push(declIndexName(original));
                    break;
                case CAT_container:
                case CAT_type:
                case CAT_type_type:
                case CAT_type_function:
                    types.push(declIndexName(original));
                    break;
                case CAT_error_set:
                    errorSets.push(declIndexName(original));
                    break;
                case CAT_function:
                    functions.push(member);
                    break;
                case CAT_global_variable:
                    globals.push(member);
                    break;
                case CAT_global_const:
                case CAT_primitive:
                    values.push({ original, member: current });
                    break;
                case CAT_alias:
                    if (seen.has(current)) {
                        values.push({ original, member: current });
                        break;
                    }
                    seen.add(current);
                    current = exports.get_aliasee();
                    continue;
                default:
                    values.push({ original, member: current });
                    break;
            }
            break;
        }
    }

    return { types, namespaces, errorSets, functions, globals, values };
}

function renderNamespaceLikeMarkdown(
    exports: any,
    declIndex: number,
    members: Iterable<number> & { length: number },
    fields: Iterable<number> & { length: number },
    includeSourceIfEmpty: boolean,
): string {
    const lines = [`# ${unwrapString(exports.decl_fqn(declIndex)) || declIndexName(declIndex)}`];
    const kindName = unwrapString(exports.decl_category_name(declIndex));
    if (kindName.length > 0) {
        lines.push("", `**Kind:** ${kindName}`);
    }

    const docs = unwrapString(exports.decl_docs_markdown(declIndex, false));
    if (docs.length > 0) {
        lines.push("", docs);
    }

    const groups = collectMemberGroups(exports, members);

    pushBulletSection(lines, "Types", groups.types);
    pushBulletSection(lines, "Namespaces", groups.namespaces);
    pushBulletSection(lines, "Error Sets", groups.errorSets);

    if (groups.functions.length > 0) {
        const functionBodies = groups.functions.map((member) => {
            const name = declIndexName(member);
            const proto = unwrapString(exports.decl_fn_proto_markdown(member, true));
            const docs = unwrapString(exports.decl_docs_markdown(member, true));
            const parts = [`### ${name}`];
            if (proto.length > 0) {
                parts.push("", proto);
            }
            if (docs.length > 0) {
                parts.push("", docs);
            }
            return parts.join("\n");
        });
        pushDetailedSection(lines, "Functions", functionBodies);
    }

    if (fields.length > 0) {
        const fieldBodies = Array.from(fields, (field) =>
            unwrapString(exports.decl_field_markdown(declIndex, field)),
        );
        pushDetailedSection(lines, "Fields", fieldBodies);
    }

    if (groups.globals.length > 0) {
        const globalBodies = groups.globals.map((member) => {
            const name = declIndexName(member);
            const typeMarkdown = unwrapString(exports.decl_type_markdown(member));
            const docs = unwrapString(exports.decl_docs_markdown(member, true));
            const parts = [`### ${name}`];
            if (typeMarkdown.length > 0) {
                parts.push("", `Type: ${typeMarkdown}`);
            }
            if (docs.length > 0) {
                parts.push("", docs);
            }
            return parts.join("\n");
        });
        pushDetailedSection(lines, "Global Variables", globalBodies);
    }

    if (groups.values.length > 0) {
        const valueBodies = groups.values.map(({ original, member }) => {
            const name = declIndexName(original);
            const typeMarkdown = unwrapString(exports.decl_type_markdown(member));
            const docs = unwrapString(exports.decl_docs_markdown(member, true));
            const parts = [`### ${name}`];
            if (typeMarkdown.length > 0) {
                parts.push("", `Type: ${typeMarkdown}`);
            }
            if (docs.length > 0) {
                parts.push("", docs);
            }
            return parts.join("\n");
        });
        pushDetailedSection(lines, "Values", valueBodies);
    }

    if (
        groups.types.length === 0 &&
        groups.namespaces.length === 0 &&
        groups.errorSets.length === 0 &&
        groups.functions.length === 0 &&
        fields.length === 0 &&
        groups.globals.length === 0 &&
        groups.values.length === 0 &&
        includeSourceIfEmpty
    ) {
        pushSection(lines, "Source Code", unwrapString(exports.decl_source_markdown(declIndex)));
    }

    return lines.join("\n").trimEnd();
}

function renderFunctionMarkdown(exports: any, declIndex: number): string {
    const lines = [`# ${unwrapString(exports.decl_fqn(declIndex)) || declIndexName(declIndex)}`];
    const kindName = unwrapString(exports.decl_category_name(declIndex));
    if (kindName.length > 0) {
        lines.push("", `**Kind:** ${kindName}`);
    }

    const docs = unwrapString(exports.decl_docs_markdown(declIndex, false));
    if (docs.length > 0) {
        lines.push("", docs);
    }

    const proto = unwrapString(exports.decl_fn_proto_markdown(declIndex, false));
    if (proto.length > 0) {
        pushSection(lines, "Function Signature", proto);
    }

    const params = unwrapSlice32(exports.decl_params(declIndex)).slice();
    if (params.length > 0) {
        const paramBodies = Array.from(params, (param) =>
            unwrapString(exports.decl_param_markdown(declIndex, param)),
        );
        pushDetailedSection(lines, "Parameters", paramBodies);
    }

    const errorSetNode = exports.fn_error_set(declIndex);
    if (errorSetNode != null) {
        try {
            const baseDecl = exports.fn_error_set_decl(declIndex, errorSetNode);
            const errorList = unwrapSlice64(
                exports.error_set_node_list(baseDecl, errorSetNode),
            ).slice();
            if (errorList.length > 0) {
                const errorBodies = Array.from(errorList, (errorIdentifier) =>
                    unwrapString(exports.error_markdown(baseDecl, errorIdentifier)),
                );
                pushDetailedSection(lines, "Errors", errorBodies);
            }
        } catch {
            // Some Zig 0.16.0 items still have error-set shapes we cannot render safely.
        }
    }

    const doctest = unwrapString(exports.decl_doctest_markdown(declIndex));
    if (doctest.length > 0) {
        pushSection(lines, "Example Usage", doctest);
    }

    const source = unwrapString(exports.decl_source_markdown(declIndex));
    if (source.length > 0) {
        pushSection(lines, "Source Code", source);
    }

    return lines.join("\n").trimEnd();
}

function renderValueMarkdown(exports: any, declIndex: number): string {
    const lines = [`# ${unwrapString(exports.decl_fqn(declIndex)) || declIndexName(declIndex)}`];
    const kindName = unwrapString(exports.decl_category_name(declIndex));
    if (kindName.length > 0) {
        lines.push("", `**Kind:** ${kindName}`);
    }

    const docs = unwrapString(exports.decl_docs_markdown(declIndex, false));
    if (docs.length > 0) {
        lines.push("", docs);
    }

    const typeMarkdown = unwrapString(exports.decl_type_markdown(declIndex));
    if (typeMarkdown.length > 0) {
        pushSection(lines, "Type", typeMarkdown);
    }

    const source = unwrapString(exports.decl_source_markdown(declIndex));
    if (source.length > 0) {
        pushSection(lines, "Source Code", source);
    }

    return lines.join("\n").trimEnd();
}

function renderErrorSetMarkdown(exports: any, declIndex: number): string {
    const lines = [`# ${unwrapString(exports.decl_fqn(declIndex)) || declIndexName(declIndex)}`];
    const kindName = unwrapString(exports.decl_category_name(declIndex));
    if (kindName.length > 0) {
        lines.push("", `**Kind:** ${kindName}`);
    }

    const docs = unwrapString(exports.decl_docs_markdown(declIndex, false));
    if (docs.length > 0) {
        lines.push("", docs);
    }

    const errorList = unwrapSlice64(exports.decl_error_set(declIndex)).slice();
    if (errorList.length > 0) {
        const errorBodies = Array.from(errorList, (errorIdentifier) =>
            unwrapString(exports.error_markdown(declIndex, errorIdentifier)),
        );
        pushDetailedSection(lines, "Errors", errorBodies);
    }

    return lines.join("\n").trimEnd();
}

function renderStructuredStdLibItemMarkdown(
    exports: any,
    sourceIndex: SourceFileIndex,
    itemFqn: string,
    declIndex: number,
): string {
    const kind = exports.categorize_decl(declIndex, 0);
    if ((kind === CAT_namespace || kind === CAT_container) && itemFqn === "std") {
        const lines = [`# ${itemFqn}`];
        const kindName = unwrapString(exports.decl_category_name(declIndex));
        if (kindName.length > 0) {
            lines.push("", `**Kind:** ${kindName}`);
        }

        const docs = unwrapString(exports.decl_docs_markdown(declIndex, false));
        if (docs.length > 0) {
            lines.push("", docs);
        }

        pushSection(lines, "Source Code", unwrapString(exports.decl_source_markdown(declIndex)));

        return lines.join("\n").trimEnd();
    }

    switch (kind) {
        case CAT_namespace:
        case CAT_container: {
            const members = unwrapSlice32(exports.namespace_members(declIndex, false)).slice();
            const fields = unwrapSlice32(exports.decl_fields(declIndex)).slice();
            return renderNamespaceLikeMarkdown(exports, declIndex, members, fields, false);
        }
        case CAT_type_function: {
            const members = unwrapSlice32(exports.type_fn_members(declIndex, false)).slice();
            const fields = unwrapSlice32(exports.type_fn_fields(declIndex)).slice();
            return renderNamespaceLikeMarkdown(exports, declIndex, members, fields, true);
        }
        case CAT_function:
            return renderFunctionMarkdown(exports, declIndex);
        case CAT_error_set:
            return renderErrorSetMarkdown(exports, declIndex);
        case CAT_global_variable:
        case CAT_global_const:
        case CAT_type:
        case CAT_type_type:
        case CAT_primitive:
            return renderValueMarkdown(exports, declIndex);
        default: {
            const sourcePath = normalizeSourcePath(unwrapString(exports.decl_file_path(declIndex)));
            const source = sourceIndex.files[sourcePath];
            if (source) {
                return renderPlainStdLibItemMarkdown(itemFqn, sourcePath || undefined, source);
            }
            return renderPlainStdLibItemMarkdown(itemFqn);
        }
    }
}

function extractDocSummary(lines: string[]): string | undefined {
    const docLines: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("///")) {
            docLines.push(trimmed.replace(/^\/\/\/+\s?/, ""));
            continue;
        }

        if (trimmed.startsWith("//!")) {
            docLines.push(trimmed.replace(/^\/\/!+\s?/, ""));
            continue;
        }

        if (trimmed.length === 0) {
            continue;
        }

        break;
    }

    const summary = docLines.join(" ").trim();
    return summary.length > 0 ? summary : undefined;
}

function pushSearchEntry(entries: StdSearchEntry[], entry: StdSearchEntry) {
    const key = `${entry.fqn}|${entry.kind}|${entry.name}`;
    if (entries.some((existing) => `${existing.fqn}|${existing.kind}|${existing.name}` === key)) {
        return;
    }

    entries.push(entry);
}

function buildIndexEntry(
    name: string,
    fqn: string,
    kind: string,
    summary?: string,
): StdSearchEntry {
    const terms = Array.from(
        new Set([
            ...tokenizeSearchText(name),
            ...tokenizeSearchText(fqn),
            ...tokenizeSearchText(kind),
            ...(summary ? tokenizeSearchText(summary) : []),
        ]),
    );

    return {
        name,
        fqn,
        kind,
        ...(summary ? { summary } : {}),
        terms,
    };
}

export function startDocsViewer() {
    const wasm_promise = fetch("main.wasm");
    const sources_promise = fetch("sources.tar").then((response) => {
        if (!response.ok) throw new Error("unable to download sources");
        return response.arrayBuffer();
    });

    WebAssembly.instantiateStreaming(wasm_promise, {
        js: {
            log: (level: any, ptr: any, len: any) => {
                const msg = decodeString(ptr, len);
                switch (level) {
                    case LOG_err:
                        console.error(msg);
                        if (domErrorsText) domErrorsText.textContent += msg + "\n";
                        if (domErrors) domErrors.classList.remove("hidden");
                        break;
                    case LOG_warn:
                        console.warn(msg);
                        break;
                    case LOG_info:
                        console.info(msg);
                        break;
                    case LOG_debug:
                        console.debug(msg);
                        break;
                }
            },
        },
    }).then((obj) => {
        wasm_exports = obj.instance.exports;
        if (typeof window !== "undefined") window.wasm = obj; // for debugging

        sources_promise.then((buffer) => {
            const js_array = new Uint8Array(buffer);
            const ptr = wasm_exports.alloc(js_array.length);
            const wasm_array = new Uint8Array(wasm_exports.memory.buffer, ptr, js_array.length);
            wasm_array.set(js_array);
            wasm_exports.unpack(ptr, js_array.length);

            updateModuleList();

            if (typeof window !== "undefined") {
                window.addEventListener("popstate", onPopState, false);
                window.addEventListener("keydown", onWindowKeyDown, false);
            }
            if (domSearch) {
                domSearch.addEventListener("keydown", onSearchKeyDown, false);
                domSearch.addEventListener("input", onSearchChange, false);
            }
            onHashChange(null);
        });
    });
}

function renderTitle() {
    if (typeof document === "undefined") return;
    const suffix = " - Zig Documentation";
    if (curNavSearch.length > 0) {
        document.title = curNavSearch + " - Search" + suffix;
    } else if (curNav.decl != null) {
        document.title = fullyQualifiedName(curNav.decl) + suffix;
    } else if (curNav.path != null) {
        document.title = curNav.path + suffix;
    } else {
        document.title = moduleList[0] + suffix;
    }
}

function render() {
    renderTitle();
    if (domContent) domContent.textContent = "";

    if (curNavSearch !== "") return renderSearch();

    switch (curNav.tag) {
        case 0:
            return renderHome();
        case 1:
            if (curNav.decl == null) {
                return renderNotFound();
            } else {
                return renderDecl(curNav.decl);
            }
        case 2:
            return renderSource(curNav.path);
        default:
            throw new Error("invalid navigation state");
    }
}

function renderHome() {
    if (moduleList.length == 0) {
        if (domContent) domContent.textContent = "# Error\n\nsources.tar contains no modules";
        return;
    }
    return renderModule(0);
}

function renderModule(pkg_index: any) {
    const root_decl = wasm_exports.find_module_root(pkg_index);
    return renderDecl(root_decl);
}

function renderDecl(decl_index: any) {
    let current = decl_index;
    const seen = new Set<number>();
    while (true) {
        const category = wasm_exports.categorize_decl(current, 0);
        switch (category) {
            case CAT_namespace:
            case CAT_container:
                return renderNamespacePage(current);
            case CAT_global_variable:
            case CAT_primitive:
            case CAT_global_const:
            case CAT_type:
            case CAT_type_type:
                return renderGlobal(current);
            case CAT_function:
                return renderFunction(current);
            case CAT_type_function:
                return renderTypeFunction(current);
            case CAT_error_set:
                return renderErrorSetPage(current);
            case CAT_alias: {
                if (seen.has(current)) return renderNotFound();
                seen.add(current);
                const aliasee = wasm_exports.get_aliasee();
                if (aliasee === -1) return renderNotFound();
                current = aliasee;
                continue;
            }
            default:
                throw new Error("unrecognized category " + category);
        }
    }
}

function renderSource(path: any) {
    const decl_index = findFileRoot(path);
    if (decl_index == null) return renderNotFound();

    let markdown = "";
    markdown += "# " + path + "\n\n";
    markdown += unwrapString(wasm_exports.decl_source_markdown(decl_index));

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderNamespacePage(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_markdown(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add namespace content
    const members = namespaceMembers(decl_index, false).slice();
    const fields = declFields(decl_index).slice();
    markdown += renderNamespaceMarkdown(decl_index, members, fields);

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderFunction(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_markdown(decl_index, false));
    if (docs.length > 0) {
        markdown += "\n" + docs;
    }

    // Add function prototype
    const proto = unwrapString(wasm_exports.decl_fn_proto_markdown(decl_index, false));
    if (proto.length > 0) {
        markdown += "\n\n## Function Signature\n\n" + proto;
    }

    // Add parameters
    const params = declParams(decl_index).slice();
    if (params.length > 0) {
        markdown += "\n\n## Parameters\n";
        for (let i = 0; i < params.length; i++) {
            const param_markdown = unwrapString(
                wasm_exports.decl_param_markdown(decl_index, params[i]),
            );
            markdown += `\n${param_markdown}`;
        }
    }

    // Add errors
    const errorSetNode = fnErrorSet(decl_index);
    if (errorSetNode != null) {
        const base_decl = wasm_exports.fn_error_set_decl(decl_index, errorSetNode);
        const errorList = errorSetNodeList(decl_index, errorSetNode);
        if (errorList != null && errorList.length > 0) {
            markdown += "\n\n## Errors\n";
            for (let i = 0; i < errorList.length; i++) {
                const error_markdown = unwrapString(
                    wasm_exports.error_markdown(base_decl, errorList[i]),
                );
                markdown += "\n" + error_markdown;
            }
        }
    }

    // Add doctest
    const doctest = unwrapString(wasm_exports.decl_doctest_markdown(decl_index));
    if (doctest.length > 0) {
        markdown += "\n\n## Example Usage\n\n" + doctest;
    }

    // Add source code
    const source = unwrapString(wasm_exports.decl_source_markdown(decl_index));
    if (source.length > 0) {
        markdown += "\n\n## Source Code\n\n" + source;
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderGlobal(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_markdown(decl_index, true));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add source code
    const source = unwrapString(wasm_exports.decl_source_markdown(decl_index));
    if (source.length > 0) {
        markdown += "## Source Code\n\n" + source + "\n\n";
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderTypeFunction(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_markdown(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add parameters
    const params = declParams(decl_index).slice();
    if (params.length > 0) {
        markdown += "## Parameters\n\n";
        for (let i = 0; i < params.length; i++) {
            const param_markdown = unwrapString(
                wasm_exports.decl_param_markdown(decl_index, params[i]),
            );
            markdown += `${param_markdown}\n\n`;
        }
    }

    // Add doctest
    const doctest = unwrapString(wasm_exports.decl_doctest_markdown(decl_index));
    if (doctest.length > 0) {
        markdown += "## Example Usage\n\n" + doctest + "\n\n";
    }

    // Add namespace content or source
    const members = unwrapSlice32(wasm_exports.type_fn_members(decl_index, false)).slice();
    const fields = unwrapSlice32(wasm_exports.type_fn_fields(decl_index)).slice();
    if (members.length !== 0 || fields.length !== 0) {
        markdown += renderNamespaceMarkdown(decl_index, members, fields);
    } else {
        const source = unwrapString(wasm_exports.decl_source_markdown(decl_index));
        if (source.length > 0) {
            markdown += "## Source Code\n\n" + source + "\n\n";
        }
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderErrorSetPage(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_markdown(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add errors
    const errorSetList = declErrorSet(decl_index).slice();
    if (errorSetList != null && errorSetList.length > 0) {
        markdown += "## Errors\n\n";
        for (let i = 0; i < errorSetList.length; i++) {
            const error_markdown = unwrapString(
                wasm_exports.error_markdown(decl_index, errorSetList[i]),
            );
            markdown += error_markdown + "\n\n";
        }
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderNavMarkdown(decl_index: any) {
    let markdown = "";
    const list = [];

    // Walk backwards through decl parents
    let decl_it = decl_index;
    while (decl_it != null) {
        list.push(declIndexName(decl_it));
        decl_it = declParent(decl_it);
    }

    // Walk backwards through file path segments
    if (decl_index != null) {
        const file_path = fullyQualifiedName(decl_index);
        const parts = file_path.split(".");
        parts.pop(); // skip last
        for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i]) {
                list.push(parts[i]);
            }
        }
    }

    list.reverse();

    if (list.length > 0) {
        markdown += "*Navigation: " + list.join(" > ") + "*\n\n";
    }

    return markdown;
}

function renderNamespaceMarkdown(base_decl: any, members: any, fields: any) {
    let markdown = "";

    const typesList = [];
    const namespacesList = [];
    const errSetsList = [];
    const fnsList = [];
    const varsList = [];
    const valsList = [];

    // Categorize members
    for (let i = 0; i < members.length; i++) {
        let member = members[i];
        const original = member;
        const seen = new Set<number>();
        while (true) {
            const member_category = wasm_exports.categorize_decl(member, 0);
            switch (member_category) {
                case CAT_namespace:
                    namespacesList.push({ original: original, member: member });
                    break;
                case CAT_container:
                    typesList.push({ original: original, member: member });
                    break;
                case CAT_global_variable:
                    varsList.push(member);
                    break;
                case CAT_function:
                    fnsList.push(member);
                    break;
                case CAT_type:
                case CAT_type_type:
                case CAT_type_function:
                    typesList.push({ original: original, member: member });
                    break;
                case CAT_error_set:
                    errSetsList.push({ original: original, member: member });
                    break;
                case CAT_global_const:
                case CAT_primitive:
                    valsList.push({ original: original, member: member });
                    break;
                case CAT_alias: {
                    if (seen.has(member)) {
                        valsList.push({ original: original, member: member });
                        break;
                    }
                    seen.add(member);
                    member = wasm_exports.get_aliasee();
                    continue;
                }
                default:
                    throw new Error("unknown category: " + member_category);
            }
            break;
        }
    }

    // Render each category
    if (typesList.length > 0) {
        markdown += "## Types\n\n";
        for (let i = 0; i < typesList.length; i++) {
            const name = declIndexName(typesList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (namespacesList.length > 0) {
        markdown += "## Namespaces\n\n";
        for (let i = 0; i < namespacesList.length; i++) {
            const name = declIndexName(namespacesList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (errSetsList.length > 0) {
        markdown += "## Error Sets\n\n";
        for (let i = 0; i < errSetsList.length; i++) {
            const name = declIndexName(errSetsList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (fnsList.length > 0) {
        markdown += "## Functions\n\n";
        for (let i = 0; i < fnsList.length; i++) {
            const decl = fnsList[i];
            const name = declIndexName(decl);
            const proto = unwrapString(wasm_exports.decl_fn_proto_markdown(decl, true));
            const docs = unwrapString(wasm_exports.decl_docs_markdown(decl, true));

            markdown += "### " + name + "\n\n";
            if (proto.length > 0) {
                markdown += proto + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    if (fields.length > 0) {
        markdown += "## Fields\n\n";
        for (let i = 0; i < fields.length; i++) {
            const field_markdown = unwrapString(
                wasm_exports.decl_field_markdown(base_decl, fields[i]),
            );
            markdown += `${field_markdown}\n\n`;
        }
    }

    if (varsList.length > 0) {
        markdown += "## Global Variables\n\n";
        for (let i = 0; i < varsList.length; i++) {
            const decl = varsList[i];
            const name = declIndexName(decl);
            const type_markdown = unwrapString(wasm_exports.decl_type_markdown(decl));
            const docs = unwrapString(wasm_exports.decl_docs_markdown(decl, true));

            markdown += "### " + name + "\n\n";
            if (type_markdown.length > 0) {
                markdown += "Type: " + type_markdown + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    if (valsList.length > 0) {
        markdown += "## Values\n\n";
        for (let i = 0; i < valsList.length; i++) {
            const original_decl = valsList[i].original;
            const decl = valsList[i].member;
            const name = declIndexName(original_decl);
            const type_markdown = unwrapString(wasm_exports.decl_type_markdown(decl));
            const docs = unwrapString(wasm_exports.decl_docs_markdown(decl, true));

            markdown += "### " + name + "\n\n";
            if (type_markdown.length > 0) {
                markdown += "Type: " + type_markdown + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    return markdown;
}

function renderNotFound() {
    const markdown = "# Error\n\nDeclaration not found.";
    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderSearch() {
    const ignoreCase = curNavSearch.toLowerCase() === curNavSearch;
    const results = executeQuery(curNavSearch, ignoreCase);

    let markdown = "# Search Results\n\n";
    markdown += 'Query: "' + curNavSearch + '"\n\n';

    if (results.length > 0) {
        markdown += "Found " + results.length + " results:\n\n";
        for (let i = 0; i < results.length; i++) {
            const match = results[i];
            const full_name = fullyQualifiedName(match);
            markdown += "- " + full_name + "\n";
        }
    } else {
        markdown += "No results found.\n\nPress escape to exit search.";
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

// Event handlers and utility functions (unchanged from original)
function updateCurNav(location_hash: any) {
    curNav.tag = 0;
    curNav.decl = null;
    curNav.path = null;
    curNavSearch = "";

    if (location_hash.length > 1 && location_hash[0] === "#") {
        const query = location_hash.substring(1);
        const qpos = query.indexOf("?");
        let nonSearchPart;
        if (qpos === -1) {
            nonSearchPart = query;
        } else {
            nonSearchPart = query.substring(0, qpos);
            curNavSearch = decodeURIComponent(query.substring(qpos + 1));
        }

        if (nonSearchPart.length > 0) {
            const source_mode = nonSearchPart.startsWith("src/");
            if (source_mode) {
                curNav.tag = 2;
                curNav.path = nonSearchPart.substring(4);
            } else {
                curNav.tag = 1;
                curNav.decl = findDecl(nonSearchPart);
            }
        }
    }
}

function onHashChange(state: any) {
    if (typeof history !== "undefined") history.replaceState({}, "");
    if (typeof location !== "undefined") navigate(location.hash);
    if (state == null && typeof window !== "undefined") window.scrollTo({ top: 0 });
}

function onPopState(ev: any) {
    onHashChange(ev.state);
}

function navigate(location_hash: any) {
    updateCurNav(location_hash);
    if (domSearch && domSearch.value !== curNavSearch) {
        domSearch.value = curNavSearch;
    }
    render();
}

function onSearchKeyDown(ev: any) {
    switch (ev.code) {
        case "Enter":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            clearAsyncSearch();
            if (typeof location !== "undefined") location.hash = computeSearchHash();
            ev.preventDefault();
            ev.stopPropagation();
            return;
        case "Escape":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            if (domSearch) {
                domSearch.value = "";
                domSearch.blur();
            }
            ev.preventDefault();
            ev.stopPropagation();
            startSearch();
            return;
        default:
            ev.stopPropagation();
            return;
    }
}

function onSearchChange(ev: any) {
    startAsyncSearch();
}

function onWindowKeyDown(ev: any) {
    switch (ev.code) {
        case "KeyS":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            if (domSearch) {
                domSearch.focus();
                domSearch.select();
            }
            ev.preventDefault();
            ev.stopPropagation();
            startAsyncSearch();
            break;
    }
}

function clearAsyncSearch() {
    if (searchTimer != null) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }
}

function startAsyncSearch() {
    clearAsyncSearch();
    searchTimer = setTimeout(startSearch, 10);
}

function computeSearchHash() {
    if (typeof location === "undefined" || !domSearch) return "";
    const oldWatHash = location.hash;
    const oldHash = oldWatHash.startsWith("#") ? oldWatHash : "#" + oldWatHash;
    const parts = oldHash.split("?");
    const newPart2 = domSearch.value === "" ? "" : "?" + domSearch.value;
    return parts[0] + newPart2;
}

function startSearch() {
    clearAsyncSearch();
    navigate(computeSearchHash());
}

function updateModuleList() {
    moduleList.length = 0;
    for (let i = 0; ; i += 1) {
        const name = unwrapString(wasm_exports.module_name(i));
        if (name.length == 0) break;
        moduleList.push(name);
    }
}

// Utility functions (unchanged from original)
function decodeString(ptr: any, len: any) {
    if (len === 0) return "";
    return text_decoder.decode(new Uint8Array(wasm_exports.memory.buffer, ptr, len));
}

function unwrapString(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    return decodeString(ptr, len);
}

function fullyQualifiedName(decl_index: any) {
    return unwrapString(wasm_exports.decl_fqn(decl_index));
}

function declIndexName(decl_index: any) {
    return unwrapString(wasm_exports.decl_name(decl_index));
}

function setQueryString(s: any) {
    const jsArray = text_encoder.encode(s);
    const len = jsArray.length;
    const ptr = wasm_exports.query_begin(len);
    const wasmArray = new Uint8Array(wasm_exports.memory.buffer, ptr, len);
    wasmArray.set(jsArray);
}

function executeQuery(query_string: any, ignore_case: any) {
    setQueryString(query_string);
    const ptr = wasm_exports.query_exec(ignore_case);
    const head = new Uint32Array(wasm_exports.memory.buffer, ptr, 1);
    const len = head[0];
    return new Uint32Array(wasm_exports.memory.buffer, ptr + 4, len);
}

function namespaceMembers(decl_index: any, include_private: any) {
    return unwrapSlice32(wasm_exports.namespace_members(decl_index, include_private));
}

function declFields(decl_index: any) {
    return unwrapSlice32(wasm_exports.decl_fields(decl_index));
}

function declParams(decl_index: any) {
    return unwrapSlice32(wasm_exports.decl_params(decl_index));
}

function declErrorSet(decl_index: any) {
    return unwrapSlice64(wasm_exports.decl_error_set(decl_index));
}

function errorSetNodeList(base_decl: any, err_set_node: any) {
    return unwrapSlice64(wasm_exports.error_set_node_list(base_decl, err_set_node));
}

function unwrapSlice32(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    if (len === 0) return [];
    return Array.from(new Uint32Array(wasm_exports.memory.buffer, ptr, len));
}

function unwrapSlice64(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    if (len === 0) return [];
    return Array.from(new BigUint64Array(wasm_exports.memory.buffer, ptr, len));
}

function findDecl(fqn: any) {
    setInputString(fqn);
    const result = wasm_exports.find_decl();
    if (result === -1) return null;
    return result;
}

function findFileRoot(path: any) {
    setInputString(path);
    const result = wasm_exports.find_file_root();
    if (result === -1) return null;
    return result;
}

function declParent(decl_index: any) {
    const result = wasm_exports.decl_parent(decl_index);
    if (result === -1) return null;
    return result;
}

function fnErrorSet(decl_index: any) {
    const result = wasm_exports.fn_error_set(decl_index);
    if (result === 0) return null;
    return result;
}

function setInputString(s: any) {
    const jsArray = text_encoder.encode(s);
    const len = jsArray.length;
    const ptr = wasm_exports.set_input_string(len);
    const wasmArray = new Uint8Array(wasm_exports.memory.buffer, ptr, len);
    wasmArray.set(jsArray);
}

async function instantiateStdRuntime(
    wasmBytes: Uint8Array<ArrayBuffer>,
    stdSources: Uint8Array<ArrayBuffer>,
    cacheKey?: string,
): Promise<any> {
    const module = cacheKey
        ? await (async () => {
              const cached = runtimeModuleCache.get(cacheKey);
              if (cached) {
                  return await cached;
              }

              const promise = WebAssembly.compile(wasmBytes).catch((error) => {
                  runtimeModuleCache.delete(cacheKey);
                  throw error;
              });
              runtimeModuleCache.set(cacheKey, promise);
              return await promise;
          })()
        : await WebAssembly.compile(wasmBytes);

    const instantiated = await WebAssembly.instantiate(module, {
        js: {
            log: (level: any, ptr: any, len: any) => {
                const msg = decodeString(ptr, len);
                if (level === LOG_err) {
                    throw new Error(msg);
                }
            },
        },
    });

    const exports =
        "instance" in (instantiated as any)
            ? (instantiated as any).instance.exports
            : (instantiated as any).exports;
    wasm_exports = exports;

    const ptr = exports.alloc(stdSources.length);
    const wasmArray = new Uint8Array(exports.memory.buffer, ptr, stdSources.length);
    wasmArray.set(stdSources);
    exports.unpack(ptr, stdSources.length);

    return exports;
}

function collectSearchEntries(version: string, exports: any): StdSearchIndex {
    const entries: StdSearchEntry[] = [];
    const seen = new Set<number>();

    const traverse = (declIndex: number) => {
        if (!isValidDeclIndex(declIndex)) {
            return;
        }

        if (seen.has(declIndex)) return;
        seen.add(declIndex);

        const name = unwrapString(exports.decl_name(declIndex));
        const fqn = unwrapString(exports.decl_fqn(declIndex));
        const category = exports.categorize_decl(declIndex, 0);
        const summary = makeSummary(unwrapString(exports.decl_docs_markdown(declIndex, false)));

        if (name.length > 0 || fqn.length > 0) {
            const terms = Array.from(
                new Set([
                    ...tokenizeSearchText(name),
                    ...tokenizeSearchText(fqn),
                    ...tokenizeSearchText(categoryName(category)),
                    ...(summary ? tokenizeSearchText(summary) : []),
                ]),
            );
            entries.push({
                name,
                fqn,
                kind: categoryName(category),
                ...(summary ? { summary } : {}),
                terms,
            });
        }

        switch (category) {
            case CAT_namespace:
            case CAT_container: {
                const members = unwrapSlice32(exports.namespace_members(declIndex, false));
                for (const member of members) {
                    traverse(member);
                }

                const fields = unwrapSlice32(exports.decl_fields(declIndex));
                for (const field of fields) {
                    traverse(field);
                }
                break;
            }
            case CAT_type_function: {
                const members = unwrapSlice32(exports.type_fn_members(declIndex, false));
                for (const member of members) {
                    traverse(member);
                }

                const fields = unwrapSlice32(exports.type_fn_fields(declIndex));
                for (const field of fields) {
                    traverse(field);
                }
                break;
            }
            case CAT_alias: {
                const aliasee = exports.get_aliasee();
                if (aliasee !== -1) {
                    traverse(aliasee);
                }
                break;
            }
        }
    };

    for (let moduleIndex = 0; ; moduleIndex += 1) {
        const moduleName = unwrapString(exports.module_name(moduleIndex));
        if (moduleName.length === 0) break;

        const rootDecl = exports.find_module_root(moduleIndex);
        if (rootDecl !== -1) {
            traverse(rootDecl);
        }
    }

    return {
        version,
        builtAt: new Date().toISOString(),
        entries,
    };
}

function scoreSearchEntry(entry: StdSearchEntry, query: string): number {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
        return 0;
    }

    const terms =
        entry.terms ??
        tokenizeSearchText(`${entry.name} ${entry.fqn} ${entry.kind} ${entry.summary ?? ""}`);
    const haystack =
        `${entry.name} ${entry.fqn} ${entry.kind} ${entry.summary ?? ""} ${terms.join(" ")}`.toLowerCase();
    let score = 0;

    if (entry.fqn.toLowerCase() === normalized) score += 1000;
    if (entry.name.toLowerCase() === normalized) score += 900;
    if (entry.fqn.toLowerCase().startsWith(normalized)) score += 700;
    if (entry.name.toLowerCase().startsWith(normalized)) score += 600;
    if (entry.fqn.toLowerCase().includes(normalized)) score += 400;
    if (entry.name.toLowerCase().includes(normalized)) score += 300;

    const tokens = normalized.split(/\s+/).filter(Boolean);
    let matchedTokens = 0;
    for (const token of tokens) {
        if (terms.some((term) => term.includes(token)) || haystack.includes(token)) {
            matchedTokens += 1;
        }
    }

    score += matchedTokens * 25;
    if (tokens.length > 1 && matchedTokens === tokens.length) {
        score += 100;
    }

    return score;
}

function renderSearchResultsMarkdown(
    entries: StdSearchEntry[],
    query: string,
    limit: number,
): string {
    const scored = entries
        .map((entry) => ({ entry, score: scoreSearchEntry(entry, query) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.entry.fqn.localeCompare(b.entry.fqn);
        });

    let markdown = `# Search Results\n\nQuery: "${query}"\n\n`;

    if (scored.length > 0) {
        const limitedResults = scored.slice(0, limit);
        markdown += `Found ${scored.length} results (showing ${limitedResults.length}):\n\n`;
        for (const item of limitedResults) {
            const summary = item.entry.summary ? ` — ${item.entry.summary}` : "";
            markdown += `- ${item.entry.fqn} (${item.entry.kind})${summary}\n`;
        }
    } else {
        markdown += "No results found.";
    }

    return markdown;
}

export async function buildStdSearchIndex(
    wasmBytes: Uint8Array<ArrayBuffer>,
    stdSources: Uint8Array<ArrayBuffer>,
    version: string,
    cacheKey?: string,
): Promise<StdSearchIndex> {
    void wasmBytes;
    void cacheKey;

    const entries: StdSearchEntry[] = [];
    const tarEntries = parseTarEntries(stdSources);

    for (const tarEntry of tarEntries) {
        const normalizedPath = normalizeSourcePath(tarEntry.path);
        if (!normalizedPath.endsWith(".zig")) {
            continue;
        }

        const baseName = normalizedPath
            .slice(normalizedPath.lastIndexOf("/") + 1)
            .replace(/\.zig$/, "");
        const moduleName = normalizedPath.replace(/\.zig$/, "");
        const lines = tarEntry.content.split(/\r?\n/);
        const summary = extractDocSummary(lines);

        pushSearchEntry(entries, buildIndexEntry(baseName, `std.${moduleName}`, "file", summary));

        let pendingSummary: string | undefined = summary;
        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith("///")) {
                pendingSummary = [pendingSummary, trimmed.replace(/^\/\/\/+\s?/, "")]
                    .filter(Boolean)
                    .join(" ")
                    .trim();
                continue;
            }

            if (trimmed.startsWith("//!")) {
                pendingSummary = [pendingSummary, trimmed.replace(/^\/\/!+\s?/, "")]
                    .filter(Boolean)
                    .join(" ")
                    .trim();
                continue;
            }

            const declMatch =
                /^(?:pub\s+)?(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed) ??
                /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed) ??
                /^(?:pub\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);

            if (declMatch) {
                const declName = declMatch[1];
                const kind = trimmed.includes("fn ")
                    ? "function"
                    : trimmed.includes("var ")
                      ? "variable"
                      : "const";
                pushSearchEntry(
                    entries,
                    buildIndexEntry(
                        declName,
                        `std.${moduleName}.${declName}`,
                        kind,
                        pendingSummary,
                    ),
                );
                pendingSummary = undefined;
                continue;
            }

            if (trimmed.length > 0) {
                pendingSummary = undefined;
            }
        }
    }

    return {
        version,
        builtAt: new Date().toISOString(),
        entries,
    };
}

function resolveAliasedDeclIndex(exports: any, declIndex: number): number {
    if (!isValidDeclIndex(declIndex)) {
        return declIndex;
    }

    const seen = new Set<number>();
    let current = declIndex;

    while (true) {
        if (!isValidDeclIndex(current)) {
            return current;
        }

        const category = exports.categorize_decl(current, 0);
        if (category !== CAT_alias) {
            return current;
        }

        if (seen.has(current)) {
            return current;
        }
        seen.add(current);

        const next = exports.get_aliasee();
        if (next === -1 || next === current) {
            return current;
        }

        current = next;
    }
}

function declCount(): number {
    return Number(wasm_exports.decl_count());
}

function isValidDeclIndex(declIndex: number): boolean {
    return Number.isInteger(declIndex) && declIndex >= 0 && declIndex < declCount();
}

export async function buildStdLibItemIndex(
    wasmBytes: Uint8Array<ArrayBuffer>,
    stdSources: Uint8Array<ArrayBuffer>,
    version: string,
    cacheKey?: string,
): Promise<StdLibItemIndex> {
    const exports = await instantiateStdRuntime(wasmBytes, stdSources, cacheKey);
    const sourceIndex = buildSourceFileIndex(stdSources, version);
    const items: Record<string, StdLibItemDoc> = Object.create(null);
    const visited = new Set<number>();

    const traverse = (declIndex: number) => {
        try {
            if (!isValidDeclIndex(declIndex)) {
                return;
            }

            if (visited.has(declIndex)) {
                return;
            }
            visited.add(declIndex);

            const fqn = unwrapString(exports.decl_fqn(declIndex));
            if (fqn.length > 0 && items[fqn] === undefined) {
                try {
                    const resolvedDeclIndex = resolveAliasedDeclIndex(exports, declIndex);
                    items[fqn] = {
                        markdown: renderStructuredStdLibItemMarkdown(
                            exports,
                            sourceIndex,
                            fqn,
                            resolvedDeclIndex,
                        ),
                        sourcePath: normalizeSourcePath(
                            unwrapString(exports.decl_file_path(resolvedDeclIndex)),
                        ),
                    };
                } catch (error) {
                    const sourcePath = (() => {
                        try {
                            return normalizeSourcePath(
                                unwrapString(exports.decl_file_path(declIndex)),
                            );
                        } catch {
                            return "";
                        }
                    })();
                    const source = sourcePath ? sourceIndex.files[sourcePath] : undefined;
                    items[fqn] = {
                        markdown: renderPlainStdLibItemMarkdown(
                            fqn,
                            sourcePath || undefined,
                            source,
                        ),
                        sourcePath,
                    };
                    console.warn(
                        `Falling back to plain stdlib item docs for ${fqn}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }

            switch (exports.categorize_decl(declIndex, 0)) {
                case CAT_namespace:
                case CAT_container: {
                    const members = unwrapSlice32(exports.namespace_members(declIndex, false));
                    for (const member of members) {
                        traverse(member);
                    }

                    const fields = unwrapSlice32(exports.decl_fields(declIndex));
                    for (const field of fields) {
                        traverse(field);
                    }
                    break;
                }
                case CAT_type_function: {
                    const members = unwrapSlice32(exports.type_fn_members(declIndex, false));
                    for (const member of members) {
                        traverse(member);
                    }

                    const fields = unwrapSlice32(exports.type_fn_fields(declIndex));
                    for (const field of fields) {
                        traverse(field);
                    }
                    break;
                }
                case CAT_alias: {
                    const aliasee = exports.get_aliasee();
                    if (aliasee !== -1) {
                        traverse(aliasee);
                    }
                    break;
                }
            }
        } catch (error) {
            console.warn(
                `Skipping stdlib declaration ${declIndex}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    };

    for (let moduleIndex = 0; ; moduleIndex += 1) {
        const moduleName = unwrapString(exports.module_name(moduleIndex));
        if (moduleName.length === 0) {
            break;
        }

        const rootDecl = exports.find_module_root(moduleIndex);
        if (rootDecl !== -1) {
            traverse(rootDecl);
        }
    }

    return {
        version,
        builtAt: new Date().toISOString(),
        items,
    };
}

export function searchStdLibFromIndex(
    index: StdSearchIndex,
    query: string,
    limit: number = 20,
): string {
    return renderSearchResultsMarkdown(index.entries, query, limit);
}
