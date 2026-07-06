import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ButtonInteraction,
  type Client,
  type TextChannel
} from "discord.js";
import type { AppConfig } from "../config.js";
import { requireModerator } from "../permissions.js";
import { createUploadWorkerClient, hasUploadWorkerConfig, type UploadWorkerJob } from "./upload-worker-client.js";

const customIdPrefix = "upload-review";

type UploadModerationAction = "approve" | "reject" | "changes" | "confirm";

export function uploadModerationButtonId(action: UploadModerationAction, submissionId: string): string {
  return `${customIdPrefix}:${action}:${submissionId}`;
}

export function buildUploadModerationEmbed(job: UploadWorkerJob): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(job.title)
    .setDescription(job.description || "No description provided.")
    .setColor(job.status === "awaiting_attribution" ? 0xfee75c : 0x5865f2)
    .addFields(
      { name: "Section", value: job.section, inline: true },
      { name: "Map SID", value: discordFieldValue(job.mapSid || "Unknown"), inline: true },
      { name: "Attribution", value: job.attribution.label, inline: true },
      { name: "Submission ID", value: job.submissionId, inline: false }
    );
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
          await channel.send({
            embeds: [buildUploadModerationEmbed(job)],
            components: buildUploadModerationComponents(job)
          });
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
  try {
    if (parsed.action === "confirm") {
      await worker.confirmAttribution(parsed.submissionId, input.interaction.user.id);
    } else if (parsed.action === "approve") {
      await worker.approve(parsed.submissionId);
    } else if (parsed.action === "reject") {
      await worker.reject(parsed.submissionId, `Rejected by ${input.interaction.user.username}.`);
    } else {
      await worker.requestChanges(parsed.submissionId, `Changes requested by ${input.interaction.user.username}.`);
    }
  } catch (error) {
    await input.interaction.editReply({
      content: "Upload action failed. Staff have been alerted."
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
