import { allowedSections, type AkronProfileSection } from "../submissions/types.js";

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
