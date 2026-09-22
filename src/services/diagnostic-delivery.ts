import { ChannelType, EmbedBuilder, PermissionFlagsBits, type Client, type MessageCreateOptions, type TextChannel } from "discord.js";
import { diagnosticChannelId, type AppConfig } from "../config.js";
import type { DiagnosticDeliveryJob, DiagnosticReport } from "../upload-diagnostics.js";
import { createUploadWorkerClient, hasUploadWorkerConfig, type UploadWorkerClient } from "./upload-worker-client.js";

let diagnosticPollInFlight: Promise<void> | undefined;

type DiagnosticPollInput = {
  client: Client<true>;
  config: AppConfig;
  onError: (error: unknown) => Promise<void>;
  worker?: UploadWorkerClient;
};

export function pollDiagnosticQueue(input: DiagnosticPollInput): Promise<void> {
  if (diagnosticPollInFlight) return diagnosticPollInFlight;
  const poll = pollDiagnosticQueueOnce(input).finally(() => {
    if (diagnosticPollInFlight === poll) diagnosticPollInFlight = undefined;
  });
  diagnosticPollInFlight = poll;
  return poll;
}

async function pollDiagnosticQueueOnce(input: DiagnosticPollInput): Promise<void> {
  if (!hasUploadWorkerConfig(input.config)) return;
  try {
    const worker = input.worker ?? createUploadWorkerClient(input.config);
    const guild = await input.client.guilds.fetch(input.config.discordGuildId);
    const channel = await guild.channels.fetch(diagnosticChannelId);
    const member = await guild.members.fetchMe();
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== input.config.discordGuildId ||
        !channel.permissionsFor(member)?.has([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory
        ])) {
      throw new Error("Diagnostic channel is unavailable or missing bot permissions.");
    }

    // Claim one at a time so a busy Discord rate-limit bucket cannot age out
    // leases for reports that have not started delivery yet.
    for (let count = 0; count < 10; count++) {
      const job = await worker.claimDiagnostic();
      if (!job) break;
      await deliverDiagnostic({ ...input, worker, channel, job });
    }
  } catch {
    await reportDiagnosticError(input, "Diagnostic polling failed; accepted reports remain queued.");
  }
}

async function deliverDiagnostic(input: DiagnosticPollInput & {
  worker: UploadWorkerClient;
  channel: TextChannel;
  job: DiagnosticDeliveryJob;
}): Promise<void> {
  const { worker, channel, job } = input;
  let leaseLost = false;
  let renewal: Promise<void> | undefined;
  const renew = (): Promise<void> => {
    if (leaseLost) return Promise.reject(new Error("Diagnostic claim lost."));
    return renewal ??= worker.renewDiagnostic(job).catch(() => {
      leaseLost = true;
      throw new Error("Diagnostic claim could not be renewed.");
    }).finally(() => { renewal = undefined; });
  };
  const heartbeat = setInterval(() => { void renew().catch(() => undefined); }, 30_000);
  try {
    const filename = `akron-diagnostic-${job.reportId}.json`;
    const existingId = job.attempts > 1
      ? await findDeliveredDiagnostic(channel, input.client.user.id, filename, job.firstAttemptUtc, renew)
      : undefined;
    await renew();
    let messageId = existingId;
    if (!messageId) {
      const { report, bytes } = await worker.getDiagnosticReport(job.reportId);
      if (report.reportId !== job.reportId) throw new Error("Diagnostic report ID mismatch.");
      await renew();
      const message = await channel.send(diagnosticMessage(report, bytes, filename));
      messageId = message.id;
    }
    await renew();
    await worker.acknowledgeDiagnostic(job, messageId);
  } catch {
    // Includes uncertain sends and failed acknowledgements. Retries reconcile
    // channel history before sending, even after Discord's nonce window ends.
    if (!leaseLost) {
      await worker.retryDiagnostic(job).catch(() => undefined);
    }
    await reportDiagnosticError(input, `Diagnostic ${job.reportId} delivery could not be confirmed; unacknowledged reports will be retried.`);
  } finally {
    clearInterval(heartbeat);
    await renewal?.catch(() => undefined);
  }
}

function diagnosticMessage(report: DiagnosticReport, bytes: Buffer, filename: string): MessageCreateOptions {
  const summary = (values: Record<string, string>) => Object.entries(values)
    .map(([key, value]) => `${key}: ${value}`).join("\n").slice(0, 700) || "Not reported";
  const embed = new EmbedBuilder()
    .setTitle("Akron diagnostic report")
    .setDescription(report.description || "No problem description provided.")
    .addFields(
      { name: "Map / context", value: summary(report.context) },
      { name: "Versions", value: summary(report.versions) },
      { name: "Installed mods", value: String(report.mods.length), inline: true }
    )
    .setFooter({ text: `Report ${report.reportId}` });
  return {
    content: `Diagnostic report ${report.reportId}`,
    embeds: [embed],
    files: [{ attachment: bytes, name: filename }],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    // A 128-bit report ID fits losslessly in Discord's 25-character nonce limit.
    nonce: BigInt(`0x${report.reportId}`).toString(36),
    enforceNonce: true
  };
}

async function findDeliveredDiagnostic(
  channel: TextChannel,
  botId: string,
  filename: string,
  firstAttemptUtc: string,
  renew: () => Promise<void>
): Promise<string | undefined> {
  // Server-owned first-attempt time, never the player's clock. Allow clock skew.
  const cutoff = Date.parse(firstAttemptUtc) - 60_000;
  let before: string | undefined;
  while (true) {
    await renew();
    const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
    if (messages.size === 0) return undefined;
    for (const message of messages.values()) {
      if (message.author.id === botId && message.attachments.some(attachment => attachment.name === filename)) {
        return message.id;
      }
    }
    const oldest = messages.reduce((left, right) => BigInt(left.id) < BigInt(right.id) ? left : right);
    if (oldest.createdTimestamp < cutoff) return undefined;
    before = oldest.id;
  }
}

async function reportDiagnosticError(input: DiagnosticPollInput, message: string): Promise<void> {
  // Discord exceptions can contain the entire request, including private logs.
  await input.onError(new Error(message)).catch(() => console.error(message));
}
