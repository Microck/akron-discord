import { eq } from "drizzle-orm";
import type { AkronDatabase } from "../db/database.js";
import { mapMappings } from "../db/schema.js";
import { normalizeMapUrl } from "../submissions/post-parser.js";
import { utcNow } from "../time.js";

export type MapMapping = {
  mapUrl: string;
  mapSid: string;
  displayName: string;
};

export async function resolveMapSid(db: AkronDatabase, mapUrl: string): Promise<MapMapping | null> {
  const normalized = normalizeMapUrl(mapUrl);
  const row = await db.query.mapMappings.findFirst({ where: eq(mapMappings.mapUrl, normalized) });
  return row ? { mapUrl: row.mapUrl, mapSid: row.mapSid, displayName: row.displayName } : null;
}

export async function upsertMapMapping(db: AkronDatabase, mapping: MapMapping, actorId: string): Promise<void> {
  await db
    .insert(mapMappings)
    .values({
      mapUrl: normalizeMapUrl(mapping.mapUrl),
      mapSid: mapping.mapSid,
      displayName: mapping.displayName,
      createdBy: actorId,
      createdUtc: utcNow()
    })
    .onConflictDoUpdate({
      target: mapMappings.mapUrl,
      set: {
        mapSid: mapping.mapSid,
        displayName: mapping.displayName,
        createdBy: actorId,
        createdUtc: utcNow()
      }
    });
}

export function slugMapSid(mapSid: string): string {
  return mapSid
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "unknown-map";
}
