import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ButtonInteraction,
  type Client,
  type ForumChannel,
  type Message,
  type TextChannel
} from "discord.js";
import type { AppConfig } from "../config.js";
import type { AkronDatabase } from "../db/database.js";
import { uploadDiscordPublications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireModerator } from "../permissions.js";
import { logAudit } from "./audit.js";
import { optimizeCatalogImage } from "./image-optimizer.js";
import { reviewWithNim } from "./nim-review.js";
import {
  createUploadWorkerClient,
  hasUploadWorkerConfig,
  type UploadWorkerClient,
  type UploadWorkerJob,
  type UploadWorkerStatusBody,
  type UploadWorkerStatusSubmission
} from "./upload-worker-client.js";
import type { UploadAiReview } from "../upload-worker.js";
import { imageSourceMaxBytes } from "../submissions/types.js";

const customIdPrefix = "upload-review";

type UploadModerationAction = "approve" | "reject" | "changes" | "confirm";
let moderationPollInFlight: Promise<void> | undefined;

export function uploadModerationButtonId(action: UploadModerationAction, submissionId: string): string {
  return `${customIdPrefix}:${action}:${submissionId}`;
}

export function buildUploadModerationEmbed(job: UploadWorkerJob): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(job.title)
    .setDescription(job.description || "No description provided.")
    .setColor(job.status === "awaiting_attribution" ? 0xfee75c : 0x5865f2)
    .addFields(
      { name: "Section", value: job.section, inline: true },
      { name: "Map SID", value: discordFieldValue(job.mapSid || "Unknown"), inline: true },
      { name: "Author", value: job.attribution.label, inline: true },
      { name: "Submission ID", value: job.submissionId, inline: false }
    );
  if (job.aiReview) {
    embed.addFields({ name: "AI Review", value: formatAiReview(job.aiReview), inline: false });
  }
  return embed;
}

export function buildUploadModerationEmbeds(job: UploadWorkerJob): EmbedBuilder[] {
  const primary = buildUploadModerationEmbed(job);
  if (job.captures.length === 0) {
    return [primary];
  }

  const total = job.captures.length;
  primary
    .setImage(job.captures[0]?.sourceUrl ?? "")
    .setFooter({ text: captureLabel(job.captures[0]?.roomName ?? "", 0, total) });
  return [
    primary,
    ...job.captures.slice(1).map((capture, index) => new EmbedBuilder()
      .setColor(0x5865f2)
      .setImage(capture.sourceUrl)
      .setFooter({ text: captureLabel(capture.roomName, index + 1, total) }))
  ];
}

function discordFieldValue(value: string): string {
  const trimmed = value.trim() || "Unknown";
  return trimmed.length <= 1024 ? trimmed : trimmed.slice(0, 1021) + "...";
}

export function buildUploadModerationComponents(job: UploadWorkerJob): ActionRowBuilder<ButtonBuilder>[] {
  if (job.attribution.mode === "discord" && !job.attribution.confirmed) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(uploadModerationButtonId("confirm", job.submissionId))
          .setLabel("Confirm attribution")
          .setStyle(ButtonStyle.Primary)
      )
    ];
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(uploadModerationButtonId("approve", job.submissionId))
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(uploadModerationButtonId("changes", job.submissionId))
        .setLabel("Request changes")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(uploadModerationButtonId("reject", job.submissionId))
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

export function pollUploadModerationQueue(input: {
  client: Client<true>;
  config: AppConfig;
  onError: (error: unknown) => Promise<void>;
}): Promise<void> {
  if (moderationPollInFlight) {
    return moderationPollInFlight;
  }
  const poll = pollUploadModerationQueueOnce(input).finally(() => {
    if (moderationPollInFlight === poll) {
      moderationPollInFlight = undefined;
    }
  });
  moderationPollInFlight = poll;
  return poll;
}

async function pollUploadModerationQueueOnce(input: {
  client: Client<true>;
  config: AppConfig;
  onError: (error: unknown) => Promise<void>;
}): Promise<void> {
  if (!hasUploadWorkerConfig(input.config)) {
    return;
  }

  try {
    const worker = createUploadWorkerClient(input.config);
    const channel = await findScanLogChannel(input.client, input.config);
    if (!channel) {
      throw new Error("scan-log channel was not found for upload moderation jobs.");
    }
    const jobs = await worker.claimJobs(10);
    if (jobs.length === 0) {
      return;
    }

    for (const job of jobs) {
      try {
        if (job.attribution.mode === "discord" && !job.attribution.confirmed) {
          if (!job.attribution.discordUserId) {
            throw new Error("Discord attribution job did not include a Discord user ID.");
          }
          // Resolve attribution only through the configured guild. A public
          // caller must not be able to turn the bot into an arbitrary-user DM
          // relay by supplying an unrelated Discord snowflake.
          const guild = await input.client.guilds.fetch(input.config.discordGuildId);
          const member = await guild.members.fetch(job.attribution.discordUserId);
          await member.send({
            embeds: buildUploadModerationEmbeds(job),
            components: buildUploadModerationComponents(job)
          });
        } else {
          const reviewedJob = await prepareUploadReviewJob({
            config: input.config,
            worker,
            job
          });
          const message = await channel.send({
            embeds: buildUploadModerationEmbeds(reviewedJob),
            components: buildUploadModerationComponents(reviewedJob)
          });
          await recordReviewMessage({ worker, config: input.config, job: reviewedJob, message, onError: input.onError });
        }
        try {
          await worker.acknowledgeDelivered([job.submissionId]);
        } catch (acknowledgeError) {
          await input.onError(acknowledgeError);
        }
      } catch (error) {
        if (shouldRequeueFailedDeliveryImmediately(job)) {
          try {
            await worker.requeueJobs([job.submissionId]);
          } catch (requeueError) {
            await input.onError(requeueError);
          }
        }
        await input.onError(error);
      }
    }
  } catch (error) {
    await input.onError(error);
  }
}

function shouldRequeueFailedDeliveryImmediately(job: UploadWorkerJob): boolean {
  // Failed attribution DMs are often permanent user settings problems. Leave
  // them on the normal review lease so the next retry is delayed instead of
  // requeueing every poll interval.
  return !(job.attribution.mode === "discord" && !job.attribution.confirmed);
}

export async function handleUploadModerationInteraction(input: {
  interaction: ButtonInteraction;
  config: AppConfig;
  db: AkronDatabase;
}): Promise<boolean> {
  const gallery = parseUploadGalleryButtonId(input.interaction.customId);
  if (gallery) {
    if (!hasUploadWorkerConfig(input.config)) {
      await input.interaction.reply({ content: "Upload Worker integration is not configured.", ephemeral: true });
      return true;
    }
    await input.interaction.deferUpdate();
    const submission = await createUploadWorkerClient(input.config).getSubmissionContext(gallery.submissionId);
    if (!submission.publication) {
      await input.interaction.editReply({ content: "This upload gallery is no longer available.", components: [] });
      return true;
    }
    const imageIndex = clampGalleryIndex(gallery.imageIndex, submission.publication.images.length);
    await input.interaction.editReply({
      embeds: [buildPublishedUploadEmbed(submission, imageIndex)],
      components: [buildPublishedUploadComponents(submission, imageIndex)]
    });
    return true;
  }

  const parsed = parseUploadModerationButtonId(input.interaction.customId);
  if (!parsed) {
    return false;
  }

  if (parsed.action !== "confirm" && !await requireModerator(input.interaction, input.config)) {
    return true;
  }
  if (!hasUploadWorkerConfig(input.config)) {
    await input.interaction.reply({ content: "Upload Worker integration is not configured.", ephemeral: true });
    return true;
  }

  await input.interaction.deferUpdate();
  const worker = createUploadWorkerClient(input.config);
  let uploadWasApproved = false;
  try {
    if (parsed.action === "confirm") {
      await worker.confirmAttribution(parsed.submissionId, input.interaction.user.id);
    } else if (parsed.action === "approve") {
      const job = await prepareUploadReviewJob({
        config: input.config,
        worker,
        job: await worker.getSubmissionContext(parsed.submissionId)
      });
      const approved = await worker.approve(
        parsed.submissionId,
        await resolveUploadCatalogAuthor(input.interaction.client as Client<true>, job)
      );
      uploadWasApproved = true;
      await logAudit(input.db, {
        actorId: input.interaction.user.id,
        action: "upload_catalog_approve",
        target: parsed.submissionId,
        details: { outcome: "succeeded" }
      });
      await publishApprovedUploadToDiscord({
        client: input.interaction.client as Client<true>,
        config: input.config,
        db: input.db,
        worker,
        status: approved,
        submissionId: parsed.submissionId
      });
      await logAudit(input.db, {
        actorId: input.interaction.user.id,
        action: "upload_discord_publish",
        target: parsed.submissionId,
        details: { outcome: "succeeded" }
      });
    } else if (parsed.action === "reject") {
      await worker.reject(parsed.submissionId, `Rejected by ${input.interaction.user.username}.`);
    } else {
      await worker.requestChanges(parsed.submissionId, `Changes requested by ${input.interaction.user.username}.`);
    }
    if (parsed.action !== "approve") {
      await logAudit(input.db, {
        actorId: input.interaction.user.id,
        action: `upload_moderation_${parsed.action}`,
        target: parsed.submissionId,
        details: { outcome: "succeeded" }
      });
    }
  } catch (error) {
    await logAudit(input.db, {
      actorId: input.interaction.user.id,
      action: parsed.action === "approve"
        ? uploadWasApproved ? "upload_discord_publish" : "upload_catalog_approve"
        : `upload_moderation_${parsed.action}`,
      target: parsed.submissionId,
      details: {
        outcome: "failed",
        errorName: error instanceof Error ? error.name : "UnknownError"
      }
    }).catch(() => undefined);
    await input.interaction.editReply({
      content: uploadWasApproved
        ? "Upload approved and cataloged, but the public Discord post failed. Staff have been alerted."
        : "Upload action failed. Staff have been alerted.",
      components: uploadWasApproved ? [] : undefined
    });
    throw error;
  }

  await input.interaction.editReply({
    content: parsed.action === "confirm"
      ? "Attribution confirmed. The upload is queued for moderation."
      : `Upload ${parsed.action === "changes" ? "marked for changes" : parsed.action + "d"}.`,
    components: []
  });
  return true;
}

async function prepareUploadReviewJob(input: {
  config: AppConfig;
  worker: UploadWorkerClient;
  job: UploadWorkerJob;
}): Promise<UploadWorkerJob> {
  let job = input.job;
  if (!job.aiReview) {
    const aiReview = await reviewWithNim(input.config, {
      title: job.title,
      body: job.description,
      archiveFacts: job.archiveFacts ?? {}
    });
    await input.worker.recordAiReview(job.submissionId, aiReview);
    job = { ...job, aiReview: { ...aiReview, reviewedUtc: new Date().toISOString() } };
  }

  for (const captureSource of job.captures.filter(capture => !capture.optimized)) {
    const capture = await fetchCaptureForOptimization(captureSource.sourceUrl);
    const optimized = await optimizeCatalogImage({
      bytes: capture.bytes,
      contentType: capture.contentType,
      fileName: captureSource.roomName || "akron-map-capture"
    });
    await input.worker.putOptimizedCapture(job.submissionId, captureSource.objectId, {
      bytes: optimized.bytes,
      contentType: "image/jpeg"
    });
    job = {
      ...job,
      captures: job.captures.map(candidate =>
        candidate.objectId === captureSource.objectId ? { ...candidate, optimized: true } : candidate
      )
    };
  }

  // Refresh signed source URLs after potentially expensive image processing so
  // Discord receives the full validity window when it resolves the embeds.
  return job.captures.length > 0
    ? await input.worker.getSubmissionContext(job.submissionId)
    : job;
}

async function resolveUploadCatalogAuthor(client: Client<true>, job: UploadWorkerJob) {
  const discordUserId = job.attribution.mode === "discord" ? job.attribution.discordUserId : undefined;
  if (!discordUserId) {
    return undefined;
  }

  const user = await client.users.fetch(discordUserId);
  return {
    name: user.globalName ?? user.username,
    avatarUrl: user.displayAvatarURL({ extension: "jpg", size: 128 })
  };
}

async function fetchCaptureForOptimization(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error("Capture download failed with HTTP " + response.status + ".");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > imageSourceMaxBytes) {
    throw new Error("Capture download exceeds the source image budget.");
  }
  if (!response.body) {
    throw new Error("Capture download returned an empty body.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > imageSourceMaxBytes) {
        await reader.cancel();
        throw new Error("Capture download exceeds the source image budget.");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return {
    bytes: Buffer.concat(chunks),
    contentType: response.headers.get("content-type") ?? ""
  };
}

function formatAiReview(review: UploadAiReview): string {
  const reasons = review.reasons.length > 0
    ? review.reasons.map(reason => `- ${reason}`).join("\n")
    : "- No issues reported.";
  return [`Decision: ${review.decision}`, `Severity: ${review.severity}`, reasons].join("\n").slice(0, 1024);
}

export async function publishApprovedUploadToDiscord(input: {
  client: Client<true>;
  config: AppConfig;
  db: AkronDatabase;
  worker: ReturnType<typeof createUploadWorkerClient>;
  status: UploadWorkerStatusBody;
  submissionId: string;
}): Promise<void> {
  const submission = input.status.submissions.find(candidate => candidate.submissionId === input.submissionId);
  if (!submission || submission.status !== "published" || !submission.publication) {
    throw new Error("Approved upload response did not include a published submission.");
  }

  const forum = await findPublicationForum(input.client, input.config, submission.section);
  if (!forum) {
    throw new Error(`Public upload forum was not found for ${submission.section}.`);
  }


  const existing = await input.db.query.uploadDiscordPublications.findFirst({
    where: eq(uploadDiscordPublications.submissionId, input.submissionId)
  });
  if (existing?.threadId) {
    const existingThread = await forum.threads.fetch(existing.threadId).catch(() => null);
    if (existingThread) {
      await input.worker.recordDiscordMessage({
        submissionId: input.submissionId,
        kind: "publication",
        guildId: existing.guildId,
        channelId: existing.channelId,
        threadId: existing.threadId,
        messageId: existing.messageId || existing.threadId
      });
      await input.db.update(uploadDiscordPublications)
        .set({ status: "recorded", updatedUtc: new Date().toISOString() })
        .where(eq(uploadDiscordPublications.submissionId, input.submissionId));
      return;
    }
    await input.db.delete(uploadDiscordPublications)
      .where(eq(uploadDiscordPublications.submissionId, input.submissionId));
  } else if (existing) {
    const reservationAge = Date.now() - Date.parse(existing.updatedUtc);
    if (!Number.isFinite(reservationAge) || reservationAge < 5 * 60 * 1000) {
      throw new Error("Discord publication is already being created for this submission.");
    }
    await input.db.delete(uploadDiscordPublications)
      .where(eq(uploadDiscordPublications.submissionId, input.submissionId));
  }

  const reserved = await input.db.insert(uploadDiscordPublications).values({
    submissionId: input.submissionId,
    guildId: input.config.discordGuildId,
    channelId: forum.id,
    status: "creating",
    updatedUtc: new Date().toISOString()
  }).onConflictDoNothing().returning({ submissionId: uploadDiscordPublications.submissionId });
  if (reserved.length !== 1) {
    throw new Error("Discord publication is already being created for this submission.");
  }

  let thread: Awaited<ReturnType<typeof forum.threads.create>> | undefined;
  try {
    thread = await forum.threads.create({
      name: forumThreadName(submission.title),
      appliedTags: publishedTagIds(forum),
      message: {
        embeds: [buildPublishedUploadEmbed(submission, 0)],
        components: [buildPublishedUploadComponents(submission, 0)]
      }
    });
    const starterMessage = await fetchStarterMessage(thread);
    const messageId = starterMessage?.id ?? thread.id;
    await input.db.update(uploadDiscordPublications).set({
      threadId: thread.id,
      messageId,
      status: "created",
      updatedUtc: new Date().toISOString()
    }).where(eq(uploadDiscordPublications.submissionId, input.submissionId));
    await input.worker.recordDiscordMessage({
      submissionId: input.submissionId,
      kind: "publication",
      guildId: input.config.discordGuildId,
      channelId: forum.id,
      threadId: thread.id,
      messageId
    });
    await input.db.update(uploadDiscordPublications)
      .set({ status: "recorded", updatedUtc: new Date().toISOString() })
      .where(eq(uploadDiscordPublications.submissionId, input.submissionId));
  } catch (error) {
    const saved = await input.db.query.uploadDiscordPublications.findFirst({
      where: eq(uploadDiscordPublications.submissionId, input.submissionId)
    }).catch(() => undefined);
    if (!saved?.threadId) {
      if (thread) await thread.delete("Akron publication persistence rollback").catch(() => undefined);
      await input.db.delete(uploadDiscordPublications)
        .where(eq(uploadDiscordPublications.submissionId, input.submissionId))
        .catch(() => undefined);
    }
    throw error;
  }
}

async function recordReviewMessage(input: {
  worker: ReturnType<typeof createUploadWorkerClient>;
  config: AppConfig;
  job: UploadWorkerJob;
  message: Message | undefined;
  onError: (error: unknown) => Promise<void>;
}): Promise<void> {
  if (!input.message?.id || !input.message.channelId) {
    return;
  }

  try {
    await input.worker.recordDiscordMessage({
      submissionId: input.job.submissionId,
      kind: "review",
      guildId: input.config.discordGuildId,
      channelId: input.message.channelId,
      messageId: input.message.id
    });
  } catch (error) {
    await input.onError(error);
  }
}

export function buildPublishedUploadEmbed(submission: UploadWorkerStatusSubmission, imageIndex: number): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(submission.title)
    .setDescription(submission.description || "No description provided.")
    .setColor(0x57f287)
    .addFields(
      { name: "Section", value: submission.section, inline: true },
      { name: "Map SID", value: discordFieldValue(submission.mapSid || "Unknown"), inline: true },
      { name: "Author", value: publishedAttributionLabel(submission), inline: true }
    );
  const images = submission.publication?.images ?? [];
  const index = clampGalleryIndex(imageIndex, images.length);
  const image = images[index];
  if (image) {
    embed
      .setImage(image.url)
      .setFooter({ text: captureLabel(image.roomName, index, images.length) });
  }
  return embed;
}

function publishedAttributionLabel(submission: UploadWorkerStatusSubmission): string {
  if (submission.attribution.mode === "discord" &&
      submission.attribution.confirmed &&
      submission.attribution.discordUserId) {
    return `<@${submission.attribution.discordUserId}>`;
  }

  return submission.attribution.label || "Anonymous";
}

export function buildPublishedUploadComponents(submission: UploadWorkerStatusSubmission, imageIndex: number): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const images = submission.publication?.images ?? [];
  const index = clampGalleryIndex(imageIndex, images.length);
  if (images.length > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(uploadGalleryButtonId(submission.submissionId, (index + images.length - 1) % images.length))
        .setEmoji("\u2B05\uFE0F")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setLabel("Download .akr")
      .setStyle(ButtonStyle.Link)
      .setURL(submission.publication?.downloadUrl ?? "https://akron.micr.dev/catalog/index.json")
  );
  if (images.length > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(uploadGalleryButtonId(submission.submissionId, (index + 1) % images.length))
        .setEmoji("\u27A1\uFE0F")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}

export function uploadGalleryButtonId(submissionId: string, imageIndex: number): string {
  return `upload-gallery:${submissionId}:${imageIndex}`;
}

function captureLabel(roomName: string, imageIndex: number, imageCount: number): string {
  const suffix = ` (${imageIndex + 1}/${imageCount})`;
  const label = roomName.trim() || "Preview";
  const maxLabelLength = 2048 - suffix.length;
  const boundedLabel = label.length <= maxLabelLength
    ? label
    : label.slice(0, maxLabelLength - 3) + "...";
  return boundedLabel + suffix;
}

function clampGalleryIndex(imageIndex: number, imageCount: number): number {
  if (imageCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(imageIndex), 0), imageCount - 1);
}

function parseUploadGalleryButtonId(customId: string): { submissionId: string; imageIndex: number } | null {
  const [prefix, submissionId, rawImageIndex] = customId.split(":");
  const imageIndex = Number(rawImageIndex);
  if (prefix !== "upload-gallery" || !submissionId || !Number.isInteger(imageIndex) || imageIndex < 0) {
    return null;
  }
  return { submissionId, imageIndex };
}

async function findPublicationForum(client: Client<true>, config: AppConfig, section: string): Promise<ForumChannel | null> {
  const channelName = forumChannelNameForSection(section);
  if (!channelName) {
    return null;
  }
  const guild = await client.guilds.fetch(config.discordGuildId);
  const channels = await guild.channels.fetch();
  const channel = channels.find(candidate => candidate?.name === channelName && candidate.type === ChannelType.GuildForum);
  return channel as ForumChannel | null;
}

function forumChannelNameForSection(section: string): string {
  if (section === "StartPos") {
    return "startpos-packs";
  }
  if (section === "AutoKill") {
    return "auto-kill-areas";
  }
  if (section === "AutoDeafen") {
    return "auto-deafen-areas";
  }
  return "";
}

function publishedTagIds(forum: ForumChannel): string[] {
  const tag = forum.availableTags.find(candidate => candidate.name.toLowerCase() === "published");
  return tag ? [tag.id] : [];
}

function forumThreadName(title: string): string {
  const trimmed = title.trim() || "Akron Community Pack";
  return trimmed.length <= 100 ? trimmed : trimmed.slice(0, 97) + "...";
}

async function fetchStarterMessage(thread: Awaited<ReturnType<ForumChannel["threads"]["create"]>>): Promise<Message | null> {
  if ("fetchStarterMessage" in thread && typeof thread.fetchStarterMessage === "function") {
    return await thread.fetchStarterMessage();
  }
  return null;
}

function parseUploadModerationButtonId(customId: string): { action: UploadModerationAction; submissionId: string } | null {
  const [prefix, action, submissionId] = customId.split(":");
  if (prefix !== customIdPrefix ||
      (action !== "approve" && action !== "reject" && action !== "changes" && action !== "confirm") ||
      !submissionId) {
    return null;
  }
  return { action, submissionId };
}

async function findScanLogChannel(client: Client<true>, config: AppConfig): Promise<TextChannel | null> {
  const guild = await client.guilds.fetch(config.discordGuildId);
  const channels = await guild.channels.fetch();
  const channel = channels.find(candidate => candidate?.name === "scan-log" && candidate.type === ChannelType.GuildText);
  return channel as TextChannel | null;
}
