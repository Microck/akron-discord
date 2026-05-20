import { eq } from "drizzle-orm";
import {
  ChannelType,
  EmbedBuilder,
  type AnyThreadChannel,
  type Attachment,
  type ForumChannel,
  type Message,
  type TextChannel
} from "discord.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";
import type { AkronDatabase } from "../db/database.js";
import { scanStates } from "../db/schema.js";
import { mapCatalogScopes, statusForumTags, submissionChannelScopes } from "../server-spec.js";
import { logAudit, sendAuditLog } from "../services/audit.js";
import { createR2Client } from "../services/r2.js";
import { publishCatalogEntry } from "../services/catalog.js";
import { optimizeCatalogImage } from "../services/image-optimizer.js";
import { resolveMapSid } from "../services/map-resolver.js";
import { reviewWithNim } from "../services/nim-review.js";
import { utcNow } from "../time.js";
import { validateAkrArchive } from "./archive.js";
import { formatSection } from "./sections.js";
import { isSupportedMapUrl, parseSubmissionPost } from "./post-parser.js";
import { akrMaxBytes, imageMaxBytes, type AkronProfileSection, type ScanStatus } from "./types.js";

type ScanThreadInput = {
  config: AppConfig;
  db: AkronDatabase;
  thread: AnyThreadChannel;
  r2Client?: S3Client;
};

type AttachmentPlan = {
  akr?: Attachment;
  image?: Attachment;
  problems: string[];
};

export function isSubmissionForumName(name: string): boolean {
  return submissionChannelScopes.has(name);
}

export async function scanSubmissionThread(input: ScanThreadInput): Promise<void> {
  const parent = input.thread.parent;
  if (!parent || parent.type !== ChannelType.GuildForum || !isSubmissionForumName(parent.name)) {
    return;
  }

  await applyStatusTag(input.thread, parent, "Pending Scan");

  const scope = submissionChannelScopes.get(parent.name) as AkronProfileSection;
  const starter = await input.thread.fetchStarterMessage();
  if (!starter) {
    await finishScan(input, parent, {
      status: "Needs Moderator Review",
      scope,
      reasons: ["Could not fetch the forum starter message."]
    });
    return;
  }

  const attachmentPlan = selectSubmissionAttachments(starter);
  const parsed = parseSubmissionPost(starter.content);
  const reasons = [...attachmentPlan.problems];
  let status: ScanStatus = "Published";
  let archiveSection: AkronProfileSection | undefined;
  let archiveMapSid = "";
  let r2PackKey = "";
  let r2ImageKey = "";

  if (!attachmentPlan.akr) {
    status = "Needs Fix";
    reasons.push("Attach exactly one `.akr` file.");
  }

  if (isMapCatalogScope(scope)) {
    if (!parsed.mapUrl) {
      status = "Needs Fix";
      reasons.push("Include a supported map link in the form `Map: https://gamebanana.com/mods/...`.");
    } else if (!isSupportedMapUrl(parsed.mapUrl)) {
      status = "Needs Fix";
      reasons.push("Map link must be a supported GameBanana mod URL.");
    }
  }

  let akrBytes: Buffer | undefined;
  if (attachmentPlan.akr) {
    try {
      akrBytes = await downloadAttachment(attachmentPlan.akr, akrMaxBytes);
      const archive = await validateAkrArchive(akrBytes);
      archiveSection = archive.section;
      archiveMapSid = archive.mapSid ?? "";
      reasons.push(...archive.reasons);

      if (archive.section && archive.section !== scope) {
        reasons.push(`This forum accepts ${formatSection(scope)} packs, but the archive contains ${formatSection(archive.section)}.`);
      }
      if (archive.section === "Whole") {
        reasons.push("Whole profile packs are not accepted publicly yet.");
      }

      if (hasFlaggableArchiveReason(archive.reasons)) {
        status = "Flagged";
      } else if (!archive.ok || (archive.section && archive.section !== scope)) {
        status = status === "Published" ? "Needs Fix" : status;
      }

      if (status !== "Flagged") {
        const nim = await reviewWithNim(input.config, {
          title: input.thread.name,
          body: starter.content,
          archiveFacts: archive.normalizedFacts
        });
        if (nim.decision === "reject" || nim.severity === "high") {
          status = "Flagged";
          reasons.push(...nim.reasons.map(reason => "NIM policy rejection: " + reason));
        } else if (nim.decision === "needs_review") {
          status = status === "Published" ? "Needs Moderator Review" : status;
          reasons.push(...nim.reasons.map(reason => "NIM review: " + reason));
        }
      }
    } catch (error) {
      status = "Flagged";
      reasons.push(error instanceof Error ? error.message : "Failed to scan .akr archive.");
    }
  }

  if (isMapCatalogScope(scope) && parsed.mapUrl && isSupportedMapUrl(parsed.mapUrl) && status !== "Flagged") {
    const mapping = await resolveMapSid(input.db, parsed.mapUrl);
    if (!mapping) {
      status = status === "Published" ? "Needs Moderator Review" : status;
      reasons.push("Map link is valid, but no map SID mapping exists yet. A moderator must add it.");
    } else if (archiveMapSid && mapping.mapSid !== archiveMapSid) {
      status = "Flagged";
      reasons.push(`Archive map SID ${archiveMapSid} does not match mapped SID ${mapping.mapSid}.`);
    } else if (akrBytes && status === "Published") {
      try {
        const optimizedImage = attachmentPlan.image
          ? await optimizeCatalogImage({
              bytes: await downloadAttachment(attachmentPlan.image, imageMaxBytes),
              contentType: attachmentPlan.image.contentType ?? "",
              fileName: attachmentPlan.image.name
            })
          : undefined;
        const result = await publishCatalogEntry(input.config, input.db, input.r2Client ?? createR2Client(input.config), {
          discordThreadId: input.thread.id,
          title: input.thread.name,
          description: parsed.description,
          section: scope,
          mapSid: mapping.mapSid,
          mapUrl: mapping.mapUrl,
          authorName: starter.member?.displayName ?? starter.author.username,
          authorAvatarUrl: starter.author.displayAvatarURL(),
          akrBytes,
          image: optimizedImage
        });
        archiveMapSid = mapping.mapSid;
        r2PackKey = result.packKey;
        r2ImageKey = result.imageKey;
      } catch (error) {
        status = "Needs Moderator Review";
        reasons.push(error instanceof Error ? error.message : "Failed to publish to R2 catalog.");
        await logAudit(input.db, {
          actorId: "bot",
          action: "catalog_publish_failed",
          target: input.thread.id,
          details: { threadUrl: input.thread.url, reason: reasons.at(-1) }
        });
        await sendAuditLog(input.thread.guild, `Catalog publish failed for ${input.thread.url}: ${reasons.at(-1)}`);
        await sendLog(input.thread.guild, "bot-alerts", `Catalog publish failed for ${input.thread.url}: ${reasons.at(-1)}`);
      }
    }
  }

  await finishScan(input, parent, {
    status,
    scope,
    mapUrl: parsed.mapUrl,
    mapSid: archiveMapSid,
    reasons: uniqueReasons(reasons),
    r2PackKey,
    r2ImageKey,
    starter
  });
}

async function finishScan(
  input: ScanThreadInput,
  parent: ForumChannel,
  result: {
    status: ScanStatus;
    scope: AkronProfileSection;
    mapUrl?: string;
    mapSid?: string;
    reasons: string[];
    r2PackKey?: string;
    r2ImageKey?: string;
    starter?: Message<true>;
  }
): Promise<void> {
  await applyStatusTag(input.thread, parent, result.status, result.scope);

  await input.db
    .insert(scanStates)
    .values({
      discordThreadId: input.thread.id,
      parentChannelId: parent.id,
      authorId: result.starter?.author.id ?? input.thread.ownerId ?? "",
      status: result.status,
      scope: result.scope,
      mapUrl: result.mapUrl ?? "",
      mapSid: result.mapSid ?? "",
      title: input.thread.name,
      reasonsJson: JSON.stringify(result.reasons),
      r2PackKey: result.r2PackKey ?? "",
      r2ImageKey: result.r2ImageKey ?? "",
      lastScannedUtc: utcNow()
    })
    .onConflictDoUpdate({
      target: scanStates.discordThreadId,
      set: {
        parentChannelId: parent.id,
        authorId: result.starter?.author.id ?? input.thread.ownerId ?? "",
        status: result.status,
        scope: result.scope,
        mapUrl: result.mapUrl ?? "",
        mapSid: result.mapSid ?? "",
        title: input.thread.name,
        reasonsJson: JSON.stringify(result.reasons),
        r2PackKey: result.r2PackKey ?? "",
        r2ImageKey: result.r2ImageKey ?? "",
        lastScannedUtc: utcNow()
      }
    });

  const embed = buildScanEmbed(result.status, result.scope, result.reasons, result.mapSid);
  await input.thread.send({ embeds: [embed] });
  await sendLog(input.thread.guild, "scan-log", `${result.status}: ${input.thread.url}`);
  if (result.status === "Published" && result.r2PackKey) {
    await logAudit(input.db, {
      actorId: "bot",
      action: "catalog_published",
      target: input.thread.id,
      details: {
        threadUrl: input.thread.url,
        packKey: result.r2PackKey,
        imageKey: result.r2ImageKey,
        mapSid: result.mapSid
      }
    });
    await sendAuditLog(input.thread.guild, `Catalog published for ${input.thread.url}: ${result.r2PackKey}`);
  }
  if (result.status === "Flagged") {
    await logAudit(input.db, {
      actorId: "bot",
      action: "submission_flagged",
      target: input.thread.id,
      details: { threadUrl: input.thread.url, reasons: result.reasons }
    });
    await sendLog(input.thread.guild, "mod-log", `Flagged submission ${input.thread.url}\n${result.reasons.join("\n")}`);
    await input.thread.setLocked(true, "Akron scan flagged this post.");
    await input.thread.setArchived(true, "Akron scan flagged this post.");
  }
}

function selectSubmissionAttachments(message: Message<true>): AttachmentPlan {
  const akrAttachments = message.attachments.filter(attachment => attachment.name.toLowerCase().endsWith(".akr"));
  const imageAttachments = message.attachments.filter(attachment => isImageAttachment(attachment));
  const problems: string[] = [];

  if (akrAttachments.size > 1) {
    problems.push("Attach only one `.akr` file.");
  }

  const extras = message.attachments.filter(attachment => !attachment.name.toLowerCase().endsWith(".akr") && !isImageAttachment(attachment));
  if (extras.size > 0) {
    problems.push("Only `.akr` files and one optional PNG/JPEG/WebP map capture are allowed.");
  }
  if (imageAttachments.size > 1) {
    problems.push("Attach at most one map capture image.");
  }

  return {
    akr: akrAttachments.first(),
    image: imageAttachments.first(),
    problems
  };
}

function isImageAttachment(attachment: Attachment): boolean {
  return ["image/png", "image/jpeg", "image/webp"].includes(attachment.contentType ?? "");
}

async function downloadAttachment(attachment: Attachment, maxBytes: number): Promise<Buffer> {
  if (attachment.size > maxBytes) {
    throw new Error(`${attachment.name} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }

  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`Failed to download ${attachment.name}.`);
  }

  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    throw new Error(`${attachment.name} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`${attachment.name} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }

  return buffer;
}

async function applyStatusTag(
  thread: AnyThreadChannel,
  parent: ForumChannel,
  status: ScanStatus | "Pending Scan",
  scope?: AkronProfileSection
): Promise<void> {
  const tagByName = new Map(parent.availableTags.map(tag => [tag.name, tag.id]));
  const statusIds = new Set(statusForumTags.map(tag => tagByName.get(tag)).filter(Boolean));
  const next = thread.appliedTags.filter(tagId => !statusIds.has(tagId));
  const statusId = tagByName.get(status);
  if (statusId) {
    next.push(statusId);
  }

  const scopeLabel = scope === "AutoKill" ? "Auto Kill" : scope === "AutoDeafen" ? "Auto Deafen" : scope;
  const scopeId = scopeLabel ? tagByName.get(scopeLabel) : undefined;
  if (scopeId && !next.includes(scopeId)) {
    next.push(scopeId);
  }

  if (typeof thread.setAppliedTags === "function") {
    await thread.setAppliedTags(next, "Akron scan status update");
  }
}

function buildScanEmbed(status: ScanStatus, scope: AkronProfileSection, reasons: string[], mapSid?: string): EmbedBuilder {
  const color = status === "Published" ? 0x2da44e : status === "Flagged" ? 0xcf222e : 0xbf8700;
  const embed = new EmbedBuilder()
    .setTitle(`Akron Scan: ${status}`)
    .setColor(color)
    .addFields({ name: "Scope", value: formatSection(scope), inline: true });

  if (mapSid) {
    embed.addFields({ name: "Map SID", value: mapSid, inline: true });
  }

  embed.setDescription(
    reasons.length > 0
      ? reasons.slice(0, 10).map(reason => `- ${reason}`).join("\n").slice(0, 4000)
      : "Submission passed deterministic validation."
  );

  return embed;
}

export function hasFlaggableArchiveReason(reasons: string[]): boolean {
  return reasons.some(reason =>
    /unsafe path|unexpected file|too many files|nested archives|compression ratio|payload is too large|not valid JSON|manifest\.kind|missing manifest|missing profile|scope mismatch|whole profile|suspicious text|large text value/i.test(reason)
  );
}

function isMapCatalogScope(scope: AkronProfileSection): boolean {
  return mapCatalogScopes.has(scope);
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons.filter(Boolean))];
}

async function sendLog(guild: AnyThreadChannel["guild"], channelName: string, content: string): Promise<void> {
  const channel = guild.channels.cache.find(candidate => candidate.name === channelName && candidate.type === ChannelType.GuildText) as TextChannel | undefined;
  if (!channel) {
    return;
  }

  await channel.send({ content: content.slice(0, 1900) });
}
