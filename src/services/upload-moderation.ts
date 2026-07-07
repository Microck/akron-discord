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
import { requireModerator } from "../permissions.js";
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

const customIdPrefix = "upload-review";

type UploadModerationAction = "approve" | "reject" | "changes" | "confirm";

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
      { name: "Attribution", value: job.attribution.label, inline: true },
      { name: "Submission ID", value: job.submissionId, inline: false }
    );
  if (job.aiReview) {
    embed.addFields({ name: "AI Review", value: formatAiReview(job.aiReview), inline: false });
  }
  return embed;
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

export async function pollUploadModerationQueue(input: {
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
          const user = await input.client.users.fetch(job.attribution.discordUserId);
          await user.send({
            embeds: [buildUploadModerationEmbed(job)],
            components: buildUploadModerationComponents(job)
          });
        } else {
          const reviewedJob = await prepareUploadReviewJob({
            config: input.config,
            worker,
            job
          });
          const message = await channel.send({
            embeds: [buildUploadModerationEmbed(reviewedJob)],
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
}): Promise<boolean> {
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
      await prepareUploadReviewJob({
        config: input.config,
        worker,
        job: await worker.getSubmissionContext(parsed.submissionId)
      });
      const approved = await worker.approve(parsed.submissionId);
      uploadWasApproved = true;
      await publishApprovedUploadToDiscord({
        client: input.interaction.client as Client<true>,
        config: input.config,
        worker,
        status: approved,
        submissionId: parsed.submissionId
      });
    } else if (parsed.action === "reject") {
      await worker.reject(parsed.submissionId, `Rejected by ${input.interaction.user.username}.`);
    } else {
      await worker.requestChanges(parsed.submissionId, `Changes requested by ${input.interaction.user.username}.`);
    }
  } catch (error) {
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

  if (job.captureSourceUrl && !job.hasOptimizedCapture) {
    const capture = await fetchCaptureForOptimization(job.captureSourceUrl);
    const optimized = await optimizeCatalogImage({
      bytes: capture.bytes,
      contentType: capture.contentType,
      fileName: "akron-map-capture"
    });
    await input.worker.putOptimizedCapture(job.submissionId, {
      bytes: optimized.bytes,
      contentType: "image/webp"
    });
    job = { ...job, hasOptimizedCapture: true };
  }

  return job;
}

async function fetchCaptureForOptimization(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Capture download failed with HTTP " + response.status + ".");
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
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

  const thread = await forum.threads.create({
    name: forumThreadName(submission.title),
    appliedTags: publishedTagIds(forum),
    message: {
      embeds: [buildPublishedUploadEmbed(submission)],
      components: [buildPublishedUploadComponents(submission)]
    }
  });
  const starterMessage = await fetchStarterMessage(thread);
  await input.worker.recordDiscordMessage({
    submissionId: input.submissionId,
    kind: "publication",
    guildId: input.config.discordGuildId,
    channelId: forum.id,
    threadId: thread.id,
    messageId: starterMessage?.id ?? thread.id
  });
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

function buildPublishedUploadEmbed(submission: UploadWorkerStatusSubmission): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(submission.title)
    .setDescription(submission.description || "No description provided.")
    .setColor(0x57f287)
    .addFields(
      { name: "Section", value: submission.section, inline: true },
      { name: "Map SID", value: discordFieldValue(submission.mapSid || "Unknown"), inline: true },
      { name: "Attribution", value: publishedAttributionLabel(submission), inline: true }
    );
  if (submission.publication?.imageUrl) {
    embed.setImage(submission.publication.imageUrl);
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

function buildPublishedUploadComponents(submission: UploadWorkerStatusSubmission): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Download .akr")
      .setStyle(ButtonStyle.Link)
      .setURL(submission.publication?.downloadUrl ?? "https://akron.micr.dev/catalog/index.json")
  );
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
