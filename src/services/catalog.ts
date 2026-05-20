import type { S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { AkronDatabase } from "../db/database.js";
import { catalogEntries } from "../db/schema.js";
import { sectionTag } from "../submissions/sections.js";
import type { AkronProfileSection } from "../submissions/types.js";
import { formatCatalogBackupTimestamp, utcNow } from "../time.js";
import { slugMapSid } from "./map-resolver.js";
import { getR2Text, putR2Object } from "./r2.js";

export type CatalogPack = {
  id: string;
  title: string;
  description: string;
  section: AkronProfileSection;
  mapSid: string;
  mapUrl: string;
  downloadUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  imageUrl: string;
  downloadCount: number;
  updatedUtc: string;
  tags: string[];
};

export type CatalogIndex = {
  format: "akron-community-pack-index-v1";
  version: 1;
  packs: CatalogPack[];
};

export type PublishCatalogInput = {
  discordThreadId: string;
  title: string;
  description: string;
  section: AkronProfileSection;
  mapSid: string;
  mapUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  akrBytes: Buffer;
  image?: {
    bytes: Buffer;
    contentType: string;
    extension: "webp";
  };
};

export type PublishCatalogResult = {
  entry: CatalogPack;
  packKey: string;
  imageKey: string;
};

const catalogIndexKey = "catalog/index.json";

export async function publishCatalogEntry(
  config: AppConfig,
  db: AkronDatabase,
  client: S3Client,
  input: PublishCatalogInput,
  now = new Date()
): Promise<PublishCatalogResult> {
  const existing = await db.query.catalogEntries.findFirst({
    where: eq(catalogEntries.discordThreadId, input.discordThreadId)
  });
  const packId = existing?.id ?? buildPackId(input);
  const mapSlug = slugMapSid(input.mapSid);
  const packKey = `packs/${mapSlug}/${packId}.akr`;
  const imageKey = input.image ? `captures/${mapSlug}/${packId}.webp` : "";
  const updatedUtc = now.toISOString();

  const downloadUrl = await putR2Object(config, client, {
    key: packKey,
    body: input.akrBytes,
    contentType: "application/octet-stream"
  });

  const imageUrl = input.image
    ? await putR2Object(config, client, {
        key: imageKey,
        body: input.image.bytes,
        contentType: input.image.contentType
      })
    : "";

  const entry: CatalogPack = {
    id: packId,
    title: input.title,
    description: input.description,
    section: input.section,
    mapSid: input.mapSid,
    mapUrl: input.mapUrl,
    downloadUrl,
    authorName: input.authorName,
    authorAvatarUrl: input.authorAvatarUrl,
    imageUrl,
    downloadCount: existing?.downloadCount ?? 0,
    updatedUtc,
    tags: [sectionTag(input.section), mapSlug].filter(Boolean)
  };

  const previousText = await getR2Text(config, client, catalogIndexKey);
  if (previousText) {
    await putR2Object(config, client, {
      key: `catalog/backups/index-${formatCatalogBackupTimestamp(now)}.json`,
      body: previousText,
      contentType: "application/json"
    });
  }

  const merged = mergeCatalogIndex(previousText, entry);
  await putR2Object(config, client, {
    key: catalogIndexKey,
    body: JSON.stringify(merged, null, 2) + "\n",
    contentType: "application/json"
  });

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

  return { entry, packKey, imageKey };
}

export function mergeCatalogIndex(previousText: string | null, entry: CatalogPack): CatalogIndex {
  const previous = parseCatalogIndex(previousText);
  const packs = previous.packs.filter(pack => pack.id !== entry.id);
  packs.push(entry);
  packs.sort((left, right) => left.title.localeCompare(right.title));
  return { format: "akron-community-pack-index-v1", version: 1, packs };
}

function parseCatalogIndex(text: string | null): CatalogIndex {
  if (!text) {
    return { format: "akron-community-pack-index-v1", version: 1, packs: [] };
  }

  const parsed = JSON.parse(text) as Partial<CatalogIndex>;
  if (parsed.format !== "akron-community-pack-index-v1" || parsed.version !== 1 || !Array.isArray(parsed.packs)) {
    throw new Error("Existing catalog/index.json has an unsupported format.");
  }

  return parsed as CatalogIndex;
}

function buildPackId(input: PublishCatalogInput): string {
  const base = `${input.title}-${input.section}-${input.discordThreadId}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}
