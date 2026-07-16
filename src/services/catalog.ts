import type { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { AkronDatabase } from "../db/database.js";
import { catalogEntries } from "../db/schema.js";
import { sectionTag } from "../submissions/sections.js";
import { allowedSections, type AkronProfileSection } from "../submissions/types.js";
import { utcNow } from "../time.js";
import { slugMapSid } from "./map-resolver.js";
import { deleteR2Object, putR2Object, r2ObjectExists } from "./r2.js";
import { createUploadWorkerClient } from "./upload-worker-client.js";

export type CatalogPack = {
  id: string;
  title: string;
  description: string;
  section: AkronProfileSection;
  mapSid: string;
  mapUrl: string;
  discordUrl: string;
  downloadUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  imageUrl?: string;
  images: Array<{ url: string; roomName: string }>;
  downloadCount: number;
  updatedUtc: string;
  tags: string[];
  sha256: string;
  sizeBytes: number;
};

export type CatalogIndex = {
  format: "akron-community-pack-index-v3";
  version: 3;
  packs: CatalogPack[];
};

export type PublishCatalogInput = {
  discordThreadId: string;
  title: string;
  description: string;
  section: AkronProfileSection;
  mapSid: string;
  mapUrl: string;
  discordUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  akrBytes: Buffer;
  image?: {
    bytes: Buffer;
    contentType: string;
    extension: "jpg";
  };
};

export type PublishCatalogResult = {
  entry: CatalogPack;
  packKey: string;
  imageKey: string;
};

type CatalogPublishDependencies = {
  publishMetadata?: (entry: CatalogPack) => Promise<void>;
  reportCacheError?: (error: unknown) => void;
  reportCleanupError?: (error: unknown) => void;
};

export async function publishCatalogEntry(
  config: AppConfig,
  db: AkronDatabase,
  client: S3Client,
  input: PublishCatalogInput,
  now = new Date(),
  dependencies: CatalogPublishDependencies = {}
): Promise<PublishCatalogResult> {
  const existing = await db.query.catalogEntries.findFirst({
    where: eq(catalogEntries.discordThreadId, input.discordThreadId)
  });
  const packId = existing?.id ?? buildPackId(input);
  const mapSlug = slugMapSid(input.mapSid);
  const sha256 = createHash("sha256").update(input.akrBytes).digest("hex");
  // Immutable content-addressed keys make rollback safe even when a forum
  // thread republishes an existing catalog entry with new bytes.
  const revision = sha256.slice(0, 16);
  const packKey = `packs/${mapSlug}/${packId}-${revision}.akr`;
  const imageKey = input.image ? `captures/${mapSlug}/${packId}-${revision}/01-preview.jpg` : "";
  const updatedUtc = now.toISOString();
  const createdKeys: string[] = [];
  let downloadUrl = "";
  let imageUrl = "";
  try {
    const packAlreadyExists = await r2ObjectExists(config, client, packKey);
    downloadUrl = await putR2Object(config, client, {
      key: packKey,
      body: input.akrBytes,
      contentType: "application/octet-stream"
    });
    if (!packAlreadyExists) createdKeys.push(packKey);
    if (input.image) {
      const imageAlreadyExists = await r2ObjectExists(config, client, imageKey);
      imageUrl = await putR2Object(config, client, {
        key: imageKey,
        body: input.image.bytes,
        contentType: input.image.contentType
      });
      if (!imageAlreadyExists) createdKeys.push(imageKey);
    }
  } catch (error) {
    await Promise.all(createdKeys.map(key => deleteR2Object(config, client, key).catch(() => undefined)));
    throw error;
  }

  const entry: CatalogPack = {
    id: packId,
    title: input.title,
    description: input.description,
    section: input.section,
    mapSid: input.mapSid,
    mapUrl: input.mapUrl,
    discordUrl: input.discordUrl,
    downloadUrl,
    authorName: input.authorName,
    authorAvatarUrl: input.authorAvatarUrl,
    imageUrl,
    images: imageUrl ? [{ url: imageUrl, roomName: "" }] : [],
    downloadCount: existing?.downloadCount ?? 0,
    updatedUtc,
    tags: [sectionTag(input.section), mapSlug].filter(Boolean),
    sha256,
    sizeBytes: input.akrBytes.length
  };
  try {
    await (dependencies.publishMetadata ?? createUploadWorkerClient(config).publishCatalogEntry)(entry);
  } catch (error) {
    await Promise.all(createdKeys.map(key => deleteR2Object(config, client, key).catch(() => undefined)));
    throw error;
  }

  try {
    await db
      .insert(catalogEntries)
      .values({
        id: entry.id,
        discordThreadId: input.discordThreadId,
        title: entry.title,
        description: entry.description,
        section: entry.section,
        mapSid: entry.mapSid,
        mapUrl: entry.mapUrl,
        downloadUrl: entry.downloadUrl,
        authorName: entry.authorName,
        authorAvatarUrl: entry.authorAvatarUrl,
        imageUrl: entry.imageUrl,
        downloadCount: entry.downloadCount,
        updatedUtc: utcNow(),
        tagsJson: JSON.stringify(entry.tags)
      })
      .onConflictDoUpdate({
        target: catalogEntries.discordThreadId,
        set: {
          title: entry.title,
          description: entry.description,
          section: entry.section,
          mapSid: entry.mapSid,
          mapUrl: entry.mapUrl,
          downloadUrl: entry.downloadUrl,
          authorName: entry.authorName,
          authorAvatarUrl: entry.authorAvatarUrl,
          imageUrl: entry.imageUrl,
          downloadCount: entry.downloadCount,
          updatedUtc: utcNow(),
          tagsJson: JSON.stringify(entry.tags)
        }
      });
  } catch (error) {
    // The Worker index is the publication source of truth. A local cache write
    // cannot turn an already durable publication into a retryable failure.
    (dependencies.reportCacheError ?? defaultCatalogErrorReporter)(error);
  }

  const currentKeys = new Set([packKey, ...(imageKey ? [imageKey] : [])]);
  const supersededKeys = existing ? catalogObjectKeys(existing).filter(key => !currentKeys.has(key)) : [];
  const cleanup = await Promise.allSettled(supersededKeys.map(key => deleteR2Object(config, client, key)));
  for (const failure of cleanup) {
    if (failure.status === "rejected") {
      (dependencies.reportCleanupError ?? defaultCatalogErrorReporter)(failure.reason);
    }
  }

  return { entry, packKey, imageKey };
}

export function mergeCatalogIndex(previousText: string | null, entry: CatalogPack): CatalogIndex {
  const previous = parseCatalogIndex(previousText);
  const packs = previous.packs.filter(pack => pack.id !== entry.id);
  packs.push(entry);
  packs.sort((left, right) => left.title.localeCompare(right.title));
  return { format: "akron-community-pack-index-v3", version: 3, packs };
}

export function parseCatalogIndex(text: string | null): CatalogIndex {
  if (!text) {
    return { format: "akron-community-pack-index-v3", version: 3, packs: [] };
  }

  const parsed = JSON.parse(text) as Partial<CatalogIndex>;
  if (parsed.format !== "akron-community-pack-index-v3" || parsed.version !== 3 || !Array.isArray(parsed.packs) ||
      parsed.packs.some(pack => !isCatalogPack(pack))) {
    throw new Error("Existing catalog/index.json has an unsupported format.");
  }

  return parsed as CatalogIndex;
}

function isCatalogPack(value: unknown): value is CatalogPack {
  if (!value || typeof value !== "object") {
    return false;
  }
  const pack = value as Partial<CatalogPack>;
  return typeof pack.id === "string" && pack.id.length > 0 &&
    typeof pack.title === "string" && pack.title.length > 0 &&
    typeof pack.description === "string" &&
    allowedSections.includes(pack.section as AkronProfileSection) &&
    typeof pack.mapSid === "string" &&
    typeof pack.mapUrl === "string" &&
    typeof pack.downloadUrl === "string" && pack.downloadUrl.length > 0 &&
    typeof pack.authorName === "string" &&
    typeof pack.authorAvatarUrl === "string" &&
    (pack.imageUrl === undefined || typeof pack.imageUrl === "string") &&
    Number.isSafeInteger(pack.downloadCount) && pack.downloadCount! >= 0 &&
    Array.isArray(pack.tags) && pack.tags.every(tag => typeof tag === "string") &&
    typeof pack.discordUrl === "string" &&
    typeof pack.updatedUtc === "string" && pack.updatedUtc.length > 0 &&
    /^[a-f0-9]{64}$/.test(pack.sha256 ?? "") &&
    isCatalogDiscordUrl(pack.discordUrl) &&
    isCatalogImages(pack.images) &&
    Number.isSafeInteger(pack.sizeBytes) && pack.sizeBytes! > 0;
}

function isCatalogImages(value: CatalogPack["images"] | undefined): boolean {
  return Array.isArray(value) && value.every(image =>
    image && typeof image === "object" && typeof image.url === "string" && typeof image.roomName === "string"
  );
}

function isCatalogDiscordUrl(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  if (value.length > 2048) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "discord.com" &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      /^\/channels\/[0-9]{1,20}\/[0-9]{1,20}\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function buildPackId(input: PublishCatalogInput): string {
  const base = `${input.section}-${input.discordThreadId}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function catalogObjectKeys(entry: typeof catalogEntries.$inferSelect): string[] {
  const mapSlug = slugMapSid(entry.mapSid);
  const keys: string[] = [];
  const packName = safeLastPathSegment(entry.downloadUrl);
  if (packName?.startsWith(`${entry.id}-`) && packName.endsWith(".akr")) {
    keys.push(`packs/${mapSlug}/${packName}`);
  }
  const imageUrl = entry.imageUrl;
  if (imageUrl) {
    const segments = safePathSegments(imageUrl);
    const captureStart = segments.indexOf("captures");
    const captureSegments = segments.length === 5 && segments[0] === "maps" && segments[3] === "captures"
      ? ["captures", segments[1], segments[2], segments[4]]
      : captureStart >= 0
        ? segments.slice(captureStart)
        : segments;
    if (captureSegments.length === 4 && captureSegments[0] === "captures" &&
        captureSegments[1] === mapSlug && captureSegments[2]?.startsWith(`${entry.id}-`) &&
        captureSegments[3] === "01-preview.jpg") {
      keys.push(captureSegments.join("/"));
      return keys;
    }
    const rawName = segments.at(-1);
    const brandedName = rawName === "capture.webp" ? segments.at(-2) + ".webp" : rawName;
    if (brandedName?.startsWith(`${entry.id}-`) && brandedName.endsWith(".webp")) {
      keys.push(`captures/${mapSlug}/${brandedName}`);
    }
  }
  return keys;
}

function safeLastPathSegment(value: string): string | undefined {
  return safePathSegments(value).at(-1);
}

function safePathSegments(value: string): string[] {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return [];
  }
}

function defaultCatalogErrorReporter(error: unknown): void {
  console.error("Catalog reconciliation failed after the Worker index was committed.", error);
}
