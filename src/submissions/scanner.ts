import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ChannelType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type AnyThreadChannel,
  type Attachment,
  type ButtonInteraction,
  type ForumChannel,
  type GuildMember,
  type Message,
  type TextChannel
} from "discord.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";
import type { AkronDatabase } from "../db/database.js";
import { embedAssets, embedAssetAttachment, embedAssetUrl, type EmbedAssetName } from "../embed-assets.js";
import { scanStates } from "../db/schema.js";
import { directSubmissionChannelScopes, statusForumTags } from "../server-spec.js";
import { logAudit } from "../services/audit.js";
import { isModerator } from "../permissions.js";
import { createR2Client, publicR2Url, putR2Object } from "../services/r2.js";
import { reviewWithNim } from "../services/nim-review.js";
import { utcNow } from "../time.js";
import { validateAkrArchive } from "./archive.js";
import { formatSection } from "./sections.js";
import { parseSubmissionPost } from "./post-parser.js";
import { akrMaxBytes, type AkronProfileSection, type ScanStatus } from "./types.js";

type ScanThreadInput = {
  config: AppConfig;
  db: AkronDatabase;
  thread: AnyThreadChannel;
  r2Client?: S3Client;
  forceBotAuthored?: boolean;
};

export type ScanSubmissionResult =
  | { scanned: true; status: ScanStatus; message: string }
  | { scanned: false; reason: string };

type AttachmentPlan = {
  akr?: Attachment;
  image?: Attachment;
  problems: string[];
};

const scanButtonPrefix = "akron:scan:";
const scanFixedCustomId = `${scanButtonPrefix}fixed`;
const scanCancelCustomId = `${scanButtonPrefix}cancel`;
const scanNotifyCustomId = `${scanButtonPrefix}notify`;
const scanConfirmCancelPrefix = `${scanButtonPrefix}confirm-cancel:`;

export function isSubmissionForumName(name: string): boolean {
  return directSubmissionChannelScopes.has(name);
}

export async function scanSubmissionThread(input: ScanThreadInput): Promise<ScanSubmissionResult> {
  if (input.thread.ownerId === input.thread.client.user.id && !input.forceBotAuthored) {
    return { scanned: false, reason: "Skipped bot-authored example thread." };
  }

  const parent = input.thread.parent;
  if (!parent || parent.type !== ChannelType.GuildForum || !isSubmissionForumName(parent.name)) {
    return { scanned: false, reason: "This is not an Akron submission forum thread." };
  }

  await applyStatusTag(input.thread, parent, "Pending Scan");

  const scope = directSubmissionChannelScopes.get(parent.name) as AkronProfileSection;
  const starter = await input.thread.fetchStarterMessage();
  if (!starter) {
    return await finishScan(input, parent, {
      status: "Needs Moderator Review",
      scope,
      reasons: ["Could not fetch the forum starter message."]
    });
  }

  const attachmentPlan = selectSubmissionAttachments(starter);
  const parsed = parseSubmissionPost(starter.content);
  const reasons = [...attachmentPlan.problems];
  let status: ScanStatus = "Published";
  let archiveSection: AkronProfileSection | undefined;
  let archiveMapSid = "";
  let r2PackKey = "";
  let scannedArchiveKey = "";
  let scannedArchiveUrl = "";
  let scannedArchiveSha256 = "";

  if (!attachmentPlan.akr) {
    status = "Needs Fix";
    reasons.push("Attach exactly one `.akr` file.");
  }

  let akrBytes: Buffer | undefined;
  if (attachmentPlan.akr) {
    try {
      akrBytes = await downloadAttachment(attachmentPlan.akr, akrMaxBytes);
      scannedArchiveSha256 = hashAkrBytes(akrBytes);
      const archive = await validateAkrArchive(akrBytes);
      archiveSection = archive.section;
      archiveMapSid = archive.mapSid ?? "";
      reasons.push(...archive.reasons);

      if (archive.section && archive.section !== scope) {
        reasons.push(`This forum accepts ${formatSection(scope)} packs, but the archive contains ${formatSection(archive.section)}.`);
      }
      if (archive.section === "Whole") {
        reasons.push("Whole setup packs are not accepted publicly yet.");
      }

      if (hasMalwareArchiveReason(archive.reasons)) {
        status = "Flagged";
      } else if (!archive.ok || (archive.section && archive.section !== scope)) {
        status = status === "Published" ? "Needs Moderator Review" : status;
      }

      if (status !== "Flagged") {
        const nim = await reviewWithNim(input.config, {
          title: input.thread.name,
          body: starter.content,
          archiveFacts: archive.normalizedFacts
        });
        if (nim.decision === "reject" || nim.severity === "high") {
          status = status === "Published" ? "Needs Moderator Review" : status;
          reasons.push(...nim.reasons);
        } else if (nim.decision === "needs_review") {
          status = status === "Published" ? "Needs Moderator Review" : status;
          reasons.push(...nim.reasons);
        }
      }
    } catch (error) {
      status = status === "Published" ? "Needs Moderator Review" : status;
      reasons.push(error instanceof Error ? error.message : "Failed to scan .akr archive.");
    }
  }

  if (akrBytes && status === "Published" && !scannedArchiveUrl) {
    try {
      const scannedArchive = await archiveScannedAkr(input.config, input.r2Client ?? createR2Client(input.config), {
        parentName: parent.name,
        threadId: input.thread.id,
        bytes: akrBytes
      });
      scannedArchiveKey = scannedArchive.key;
      scannedArchiveUrl = scannedArchive.url;
      scannedArchiveSha256 = scannedArchive.sha256;
      r2PackKey = scannedArchiveKey;
    } catch (error) {
      status = "Needs Moderator Review";
      const reason = error instanceof Error ? error.message : "Failed to archive approved .akr to R2.";
      reasons.push("Failed to archive approved .akr to R2; publication is blocked until staff review.");
      await logAudit(input.db, {
        actorId: "bot",
        action: "submission_archive_failed",
        target: input.thread.id,
        details: { threadUrl: input.thread.url, reason }
      });
      await sendLog(input.thread.guild, "bot-alerts", `Approved submission archive failed for ${input.thread.url}: ${reason}`);
    }
  }

  return await finishScan(input, parent, {
    status,
    scope,
    mapUrl: parsed.mapUrl,
    mapSid: archiveMapSid,
    reasons: uniqueReasons(reasons),
    r2PackKey,
    scannedArchiveKey,
    scannedArchiveUrl,
    scannedArchiveSha256,
    starter,
    hasAkrAttachment: Boolean(attachmentPlan.akr),
    hasCaptureImage: Boolean(attachmentPlan.image)
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
    scannedArchiveKey?: string;
    scannedArchiveUrl?: string;
    scannedArchiveSha256?: string;
    starter?: Message<true>;
    hasAkrAttachment?: boolean;
    hasCaptureImage?: boolean;
  }
): Promise<ScanSubmissionResult> {
  const previousState = await input.db.query.scanStates.findFirst({
    where: eq(scanStates.discordThreadId, input.thread.id)
  });
  const repeatedFailure = Boolean(previousState && previousState.status !== "Published" && result.status !== "Published");

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
      r2ImageKey: "",
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
        r2ImageKey: "",
        lastScannedUtc: utcNow()
      }
    });

  const embed = buildScanEmbed(result.status, result.scope, result.reasons, {
    mapSid: result.mapSid,
    scannedArchiveUrl: result.scannedArchiveUrl,
    scannedArchiveSha256: result.scannedArchiveSha256,
    hasAkrAttachment: result.hasAkrAttachment,
    hasCaptureImage: result.hasCaptureImage
  });
  await input.thread.send({
    embeds: [embed],
    files: scanEmbedFiles(result.status),
    components: buildScanComponents(result.status, repeatedFailure)
  });
  await sendLog(input.thread.guild, "scan-log", `${result.status}: ${input.thread.url}`);
  if (result.status === "Flagged") {
    await logAudit(input.db, {
      actorId: "bot",
      action: "submission_flagged",
      target: input.thread.id,
      details: {
        threadUrl: input.thread.url,
        reasons: result.reasons,
        scannedArchiveKey: result.scannedArchiveKey,
        scannedArchiveSha256: result.scannedArchiveSha256
      }
    });
    await sendLog(input.thread.guild, "mod-log", [
      `Flagged submission ${input.thread.url}`,
      result.scannedArchiveKey ? `Archived file: ${publicR2Url(input.config, result.scannedArchiveKey)}` : "",
      result.scannedArchiveSha256 ? `SHA-256: ${result.scannedArchiveSha256}` : "",
      result.reasons.join("\n")
    ].filter(Boolean).join("\n"));
    await input.thread.setLocked(true, "Akron scan flagged this post.");
    await input.thread.setArchived(true, "Akron scan flagged this post.");
  }

  return {
    scanned: true,
    status: result.status,
    message: `Scan completed with status: ${scanValidityLabel(result.status)}.`
  };
}

export async function handleScanButtonInteraction(input: {
  interaction: ButtonInteraction;
  config: AppConfig;
  db: AkronDatabase;
}): Promise<boolean> {
  const { interaction, config, db } = input;
  if (!interaction.customId.startsWith(scanButtonPrefix)) {
    return false;
  }

  const thread = await resolveInteractionThread(interaction);
  if (!thread) {
    await interaction.reply({ content: "This button only works inside an Akron submission thread.", ephemeral: true });
    return true;
  }

  if (!canUseScanButton(interaction, config, thread)) {
    await interaction.reply({ content: "Only the thread author or staff can use this.", ephemeral: true });
    return true;
  }

  if (interaction.customId === scanFixedCustomId) {
    await interaction.reply({ content: "Rescanning this submission now.", ephemeral: true });
    const result = await scanSubmissionThread({ config, db, thread, forceBotAuthored: true });
    await interaction.followUp({
      content: result.scanned ? result.message : `Rescan skipped: ${result.reason}`,
      ephemeral: true
    });
    return true;
  }

  if (interaction.customId === scanCancelCustomId) {
    await interaction.reply({
      content: "This will delete the entire forum post and cannot be undone. Confirm only if you want to remove this submission.",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${scanConfirmCancelPrefix}${thread.id}`)
            .setLabel("Confirm Delete")
            .setStyle(ButtonStyle.Danger)
        )
      ],
      ephemeral: true
    });
    return true;
  }

  if (interaction.customId.startsWith(scanConfirmCancelPrefix)) {
    const expectedThreadId = interaction.customId.slice(scanConfirmCancelPrefix.length);
    if (expectedThreadId !== thread.id) {
      await interaction.reply({ content: "This confirmation belongs to a different thread.", ephemeral: true });
      return true;
    }

    await interaction.reply({ content: "Deleting this submission.", ephemeral: true });
    await thread.delete("Akron submission cancelled by user.");
    return true;
  }

  if (interaction.customId === scanNotifyCustomId) {
    const mention = config.akronAdminRoleId ? `<@&${config.akronAdminRoleId}>` : "Staff";
    await sendLog(thread.guild, "bot-alerts", `${mention} help requested for ${thread.url} by <@${interaction.user.id}> after repeated scan failures.`);
    await interaction.reply({ content: "Staff have been notified.", ephemeral: true });
    return true;
  }

  return false;
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

  if (!response.body) {
    throw new Error(`Failed to download ${attachment.name}.`);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${attachment.name} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
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

export function buildScanEmbed(
  status: ScanStatus,
  scope: AkronProfileSection,
  reasons: string[],
  archive: {
    mapSid?: string;
    scannedArchiveUrl?: string;
    scannedArchiveSha256?: string;
    hasAkrAttachment?: boolean;
    hasCaptureImage?: boolean;
  }
): EmbedBuilder {
  const color = scanEmbedColor(status);
  const validity = scanValidityLabel(status);
  const embed = new EmbedBuilder()
    .setTitle(`Akron Scan: ${validity}`)
    .setColor(color)
    .setThumbnail(embedAssetUrl(scanEmbedAsset(status)))
    .addFields({ name: "Scope", value: formatSection(scope), inline: true });

  embed.setDescription(buildScanChecklist(status, reasons, archive));

  if (archive.mapSid) {
    embed.addFields({ name: "Map SID", value: archive.mapSid, inline: true });
  }

  if (archive.scannedArchiveUrl && status !== "Flagged") {
    embed.addFields({
      name: "Scanned File",
      value: [
        `[Download exact scanned .akr](${archive.scannedArchiveUrl})`,
        archive.scannedArchiveSha256 ? `SHA-256: \`${archive.scannedArchiveSha256}\`` : ""
      ].filter(Boolean).join("\n")
    });
  } else if (archive.scannedArchiveSha256 && status === "Flagged") {
    embed.addFields({
      name: "Scanned File",
      value: "Not uploaded to public R2. SHA-256: `" + archive.scannedArchiveSha256 + "`"
    });
  }

  if (reasons.length > 0) {
    embed.addFields({
      name: status === "Published" ? "Notes" : "What needs attention",
      value: reasons.slice(0, 10).map(reason => `- ${reason}`).join("\n").slice(0, 1024)
    });
  }

  return embed;
}

function buildScanChecklist(
  status: ScanStatus,
  reasons: string[],
  archive: {
    mapSid?: string;
    scannedArchiveUrl?: string;
    scannedArchiveSha256?: string;
    hasAkrAttachment?: boolean;
    hasCaptureImage?: boolean;
  }
): string {
  const ok = status === "Published";
  const attention = status === "Needs Fix" || status === "Needs Moderator Review" || status === "Flagged";
  const lines = [
    `**Result:** ${scanValidityLabel(status)}`,
    "",
    `${checkbox(Boolean(archive.hasAkrAttachment))} `.concat("One `.akr` attachment found"),
    `${checkbox(Boolean(archive.scannedArchiveUrl))} `.concat("Approved public `.akr` stored"),
    "[-] Map link not required for this forum",
    "[-] Map identity not required for this forum",
    `${checkbox(reasons.length === 0 || ok)} Deterministic archive validation passed`,
    `${checkbox(status !== "Flagged")} Malware check did not flag the post`,
    archive.hasCaptureImage ? "[x] Optional capture image attached" : "[-] Optional capture image not attached",
    "[-] Catalog publishing not used for Discord-only packs",
    attention ? "[!] Action needed before this is valid" : "[x] No user action needed"
  ];

  return lines.join("\n").slice(0, 4000);
}

function scanValidityLabel(status: ScanStatus): string {
  if (status === "Published") {
    return "Valid";
  }
  if (status === "Needs Fix") {
    return "Needs Fix";
  }
  if (status === "Needs Moderator Review") {
    return "Needs Review";
  }
  return "Flagged";
}

function checkbox(complete: boolean): string {
  return complete ? "[x]" : "[ ]";
}

function scanEmbedColor(status: ScanStatus): number {
  if (status === "Published") {
    return 0xfee75c;
  }
  if (status === "Flagged") {
    return 0xcf222e;
  }
  return 0x80848e;
}

function scanEmbedAsset(status: ScanStatus): EmbedAssetName {
  if (status === "Published") {
    return embedAssets.akronLeaf;
  }
  if (status === "Flagged") {
    return embedAssets.akronLeafFlagged;
  }
  return embedAssets.akronLeafDesaturated;
}

function scanEmbedFiles(status: ScanStatus): AttachmentBuilder[] {
  return [embedAssetAttachment(scanEmbedAsset(status))];
}

export function buildScanComponents(status: ScanStatus, repeatedFailure: boolean): ActionRowBuilder<ButtonBuilder>[] {
  if (status === "Published" || status === "Flagged") {
    return [];
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId(scanFixedCustomId)
      .setLabel("Fixed")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(scanCancelCustomId)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  ];

  if (repeatedFailure) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(scanNotifyCustomId)
        .setLabel("Notify")
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
}

async function resolveInteractionThread(interaction: ButtonInteraction): Promise<AnyThreadChannel | null> {
  if (interaction.channel?.isThread()) {
    return interaction.channel;
  }

  return null;
}

function canUseScanButton(interaction: ButtonInteraction, config: AppConfig, thread: AnyThreadChannel): boolean {
  const member = interaction.member instanceof Object && "roles" in interaction.member
    ? (interaction.member as GuildMember)
    : null;
  return interaction.user.id === thread.ownerId || Boolean(member && isModerator(member, config));
}

async function archiveScannedAkr(
  config: AppConfig,
  client: S3Client,
  input: {
    parentName: string;
    threadId: string;
    bytes: Buffer;
  }
): Promise<{ key: string; url: string; sha256: string }> {
  const sha256 = hashAkrBytes(input.bytes);
  const key = buildScannedArchiveKey(input.parentName, input.threadId, sha256);
  const url = await putR2Object(config, client, {
    key,
    body: input.bytes,
    contentType: "application/octet-stream"
  });
  return { key, url, sha256 };
}

function hashAkrBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildScannedArchiveKey(parentName: string, threadId: string, sha256: string): string {
  const safeParent = parentName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown-forum";
  return `submissions/${safeParent}/${threadId}/${sha256}.akr`;
}

export function hasMalwareArchiveReason(reasons: string[]): boolean {
  return reasons.some(reason =>
    /suspicious text/i.test(reason)
  );
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
