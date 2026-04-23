import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

interface Args {
    bucket: string;
    prefix: string;
    force: boolean;
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        bucket: "zig-docs",
        prefix: "",
        force: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--bucket" && i + 1 < argv.length) {
            args.bucket = argv[++i];
        } else if (arg === "--prefix" && i + 1 < argv.length) {
            args.prefix = argv[++i];
        } else if (arg === "--account-id" && i + 1 < argv.length) {
            args.accountId = argv[++i];
        } else if (arg === "--access-key-id" && i + 1 < argv.length) {
            args.accessKeyId = argv[++i];
        } else if (arg === "--secret-access-key" && i + 1 < argv.length) {
            args.secretAccessKey = argv[++i];
        } else if (arg === "--profile" && i + 1 < argv.length) {
            args.profile = argv[++i];
        } else if (arg === "--force") {
            args.force = true;
        }
    }

    return args;
}

function getRequired(value: string | undefined, name: string): string {
    if (!value || value.trim().length === 0) {
        throw new Error(`Missing required value: ${name}`);
    }

    return value.trim();
}

async function resolveAccountId(explicit?: string): Promise<string> {
    if (explicit && explicit.trim().length > 0) {
        return explicit.trim();
    }

    if (process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
        return process.env.CLOUDFLARE_ACCOUNT_ID.trim();
    }

    const wranglerConfigPath = path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "xdg.config",
        ".wrangler",
        "config",
        "default.toml",
    );

    if (fs.existsSync(wranglerConfigPath)) {
        const content = fs.readFileSync(wranglerConfigPath, "utf8");
        const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
        if (match) {
            const response = await fetch("https://api.cloudflare.com/client/v4/accounts", {
                headers: {
                    Authorization: `Bearer ${match[1]}`,
                },
            });

            if (!response.ok) {
                throw new Error(
                    `Failed to resolve Cloudflare account id: ${response.status} ${response.statusText}`,
                );
            }

            const payload = (await response.json()) as {
                success?: boolean;
                result?: Array<{ id?: string }>;
            };
            const accountId = payload.result?.[0]?.id?.trim();
            if (accountId) {
                return accountId;
            }
        }
    }

    throw new Error(
        "Missing required value: account id. Pass --account-id or set CLOUDFLARE_ACCOUNT_ID.",
    );
}

function readIniCredentials(
    filePath: string,
    profile: string,
): { accessKeyId?: string; secretAccessKey?: string } {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    let currentProfile = "";
    let accessKeyId: string | undefined;
    let secretAccessKey: string | undefined;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) {
            continue;
        }

        const section = trimmed.match(/^\[([^\]]+)\]$/);
        if (section) {
            currentProfile = section[1].trim();
            continue;
        }

        if (currentProfile !== profile) {
            continue;
        }

        const [rawKey, ...rest] = trimmed.split("=");
        if (!rawKey || rest.length === 0) {
            continue;
        }

        const key = rawKey.trim().toLowerCase();
        const value = rest.join("=").trim();
        if (key === "aws_access_key_id" || key === "access_key_id") {
            accessKeyId = value;
        } else if (key === "aws_secret_access_key" || key === "secret_access_key") {
            secretAccessKey = value;
        }
    }

    return { accessKeyId, secretAccessKey };
}

function resolveCredentials(args: Args): { accessKeyId: string; secretAccessKey: string } {
    const credentialsPath = path.join(os.homedir(), ".aws", "credentials");
    const iniCredentials = readIniCredentials(credentialsPath, args.profile ?? "default");
    const accessKeyId =
        args.accessKeyId ??
        process.env.R2_ACCESS_KEY_ID ??
        process.env.AWS_ACCESS_KEY_ID ??
        iniCredentials.accessKeyId;
    const secretAccessKey =
        args.secretAccessKey ??
        process.env.R2_SECRET_ACCESS_KEY ??
        process.env.AWS_SECRET_ACCESS_KEY ??
        iniCredentials.secretAccessKey;

    return {
        accessKeyId: getRequired(accessKeyId, "access key id"),
        secretAccessKey: getRequired(secretAccessKey, "secret access key"),
    };
}

async function createClient(args: Args): Promise<S3Client> {
    const accountId = await resolveAccountId(args.accountId);
    const credentials = resolveCredentials(args);

    return new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
        credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
        },
    });
}

async function deleteBucketContents(args: Args) {
    if (!args.force) {
        throw new Error("Refusing to delete R2 objects without --force");
    }

    const client = await createClient(args);
    let deleted = 0;
    let continuationToken: string | undefined;

    while (true) {
        const page = await client.send(
            new ListObjectsV2Command({
                Bucket: args.bucket,
                Prefix: args.prefix.length > 0 ? args.prefix : undefined,
                ContinuationToken: continuationToken,
                MaxKeys: 1000,
            }),
        );

        const keys = (page.Contents ?? [])
            .map((object) => object.Key)
            .filter((key): key is string => typeof key === "string" && key.length > 0);

        if (keys.length > 0) {
            const response = await client.send(
                new DeleteObjectsCommand({
                    Bucket: args.bucket,
                    Delete: {
                        Quiet: true,
                        Objects: keys.map((key) => ({ Key: key })),
                    },
                }),
            );

            if (response.Errors && response.Errors.length > 0) {
                const failed = response.Errors.map((error) => error.Key ?? "<unknown>").join(", ");
                throw new Error(`Failed to delete objects: ${failed}`);
            }

            deleted += keys.length;
            console.log(`Deleted ${deleted} objects so far...`);
        }

        if (!page.IsTruncated) {
            break;
        }

        if (!page.NextContinuationToken) {
            throw new Error("R2 listing was truncated without a continuation token");
        }

        continuationToken = page.NextContinuationToken;
    }

    console.log(
        `Deleted ${deleted} objects from ${args.bucket}${args.prefix ? ` with prefix ${args.prefix}` : ""}`,
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await deleteBucketContents(args);
}

main();
