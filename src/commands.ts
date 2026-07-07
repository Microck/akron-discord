import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AnyThreadChannel,
  type ChatInputCommandInteraction,
  type Client,
  type ForumChannel,
  type GuildMember
} from "discord.js";
import type { AppConfig } from "./config.js";
import type { AkronDatabase } from "./db/database.js";
import {
  applyGithubClosedTag,
  applyGithubTags,
  githubIssueKindForForum,
  syncGithubForumThread,
  type GithubForumSyncResult
} from "./github-forums.js";
import { isModerator, requireAdmin, requireModerator } from "./permissions.js";
import { logAudit } from "./services/audit.js";
import { applyGithubLabels, closeSyncedGithubIssue, linkGithubIssue, planGithubLabels, unlinkGithubIssue } from "./services/github-sync.js";
import { upsertMapMapping } from "./services/map-resolver.js";
import { createUploadWorkerClient, hasUploadWorkerConfig } from "./services/upload-worker-client.js";
import { applyServerSync, planServerSync } from "./server-sync.js";
import { isSupportedMapUrl, normalizeMapUrl } from "./submissions/post-parser.js";
import { scanSubmissionThread } from "./submissions/scanner.js";
import type { UploadDiscordMessage, UploadDiscordMessages } from "./upload-worker.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("sync-server")
    .setDescription("Plan or apply the canonical Akron Discord server structure.")
    .addStringOption(option =>
      option
        .setName("mode")
        .setDescription("Run a dry run or apply changes.")
        .setRequired(true)
        .addChoices({ name: "dry-run", value: "dry-run" }, { name: "apply", value: "apply" })
    ),
  new SlashCommandBuilder()
    .setName("rescan")
    .setDescription("Rescan an Akron submission forum post.")
    .addStringOption(option =>
      option.setName("thread-id").setDescription("Optional Discord thread ID. Defaults to the current thread.")
    ),
  new SlashCommandBuilder()
    .setName("sync-issue")
    .setDescription("Sync the current issues or suggestions forum post to GitHub.")
    .addStringOption(option =>
      option.setName("thread-id").setDescription("Optional Discord thread ID. Defaults to the current thread.")
    ),
  new SlashCommandBuilder()
    .setName("solved")
    .setDescription("Mark a forum post solved and archive it.")
    .addStringOption(option =>
      option.setName("thread-id").setDescription("Optional Discord thread ID. Defaults to the current thread.")
    ),
  new SlashCommandBuilder()
    .setName("close-synced-issue")
    .setDescription("Close the GitHub issue linked to the current forum thread.")
    .addStringOption(option =>
      option.setName("reason").setDescription("Optional moderator note to post before closing.")
    ),
  new SlashCommandBuilder()
    .setName("link-issue")
    .setDescription("Link the current forum thread to an existing GitHub issue.")
    .addIntegerOption(option =>
      option.setName("issue-number").setDescription("GitHub issue number.").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("unlink-issue")
    .setDescription("Remove the GitHub issue link for the current forum thread."),
  new SlashCommandBuilder()
    .setName("sync-github-labels")
    .setDescription("Plan or apply canonical GitHub labels.")
    .addStringOption(option =>
      option
        .setName("mode")
        .setDescription("Run a dry run or apply changes.")
        .setRequired(true)
        .addChoices({ name: "dry-run", value: "dry-run" }, { name: "apply", value: "apply" })
    ),
  new SlashCommandBuilder()
    .setName("set-map-mapping")
    .setDescription("Map a supported map URL to a Celeste map SID.")
    .addStringOption(option =>
      option.setName("map-url").setDescription("Supported GameBanana map URL.").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("map-sid").setDescription("Canonical Celeste map SID.").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("display-name").setDescription("Human-readable map name.").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("delete-upload-pack")
    .setDescription("Delete an in-game uploaded pack from the catalog and known Discord posts.")
    .addStringOption(option =>
      option.setName("submission-id").setDescription("Upload submission ID to delete. Defaults to the current upload thread.")
    )
    .addStringOption(option =>
      option.setName("reason").setDescription("Optional admin note stored on the deleted submission.")
    )
].map(command => command.toJSON());

export async function handleCommand(input: {
  interaction: ChatInputCommandInteraction;
  client: Client<true>;
  config: AppConfig;
  db: AkronDatabase;
}): Promise<void> {
  const { interaction, client, config, db } = input;

  if (interaction.commandName === "sync-server") {
    if (!await requireAdmin(interaction, config)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const mode = interaction.options.getString("mode", true);
    const guild = await client.guilds.fetch(config.discordGuildId);
    const plan = mode === "apply" ? await applyServerSync(guild, db, config) : await planServerSync(guild, config);
    if (mode === "apply") {
      await logAudit(db, {
        actorId: interaction.user.id,
        action: "server_sync_apply",
        target: guild.id,
        details: { changes: plan.changes }
      });
    }
    await interaction.editReply({ embeds: [buildListEmbed(`Server Sync ${mode}`, plan.changes)] });
    return;
  }

  if (interaction.commandName === "rescan") {
    if (!await requireModerator(interaction, config)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const thread = await resolveThread(interaction, client);
    if (!thread) {
      await interaction.editReply("Run this inside a forum thread or pass `thread-id`.");
      return;
    }

    const result = await scanSubmissionThread({ config, db, thread, forceBotAuthored: true });
    await interaction.editReply(result.scanned ? result.message : `Rescan skipped: ${result.reason}`);
    return;
  }

  if (interaction.commandName === "sync-issue") {
    if (!await requireModerator(interaction, config)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const thread = await resolveThread(interaction, client);
    if (!thread) {
      await interaction.editReply("Run this inside a forum thread or pass `thread-id`.");
      return;
    }

    const result = await syncGithubForumThread({
      config,
      db,
      thread,
      allowBotAuthored: true,
      allowUnsupportedForum: true,
      updateExisting: true
    });
    await interaction.editReply(formatGithubForumSyncResult(result));
    return;
  }

  if (interaction.commandName === "solved") {
    await interaction.deferReply({ ephemeral: true });
    const thread = await resolveThread(interaction, client);
    const parent = thread?.parent;
    if (!thread || !parent || parent.type !== ChannelType.GuildForum) {
      await interaction.editReply("Run this inside a forum thread or pass `thread-id`.");
      return;
    }

    if (!canMarkSolved(interaction, config, thread)) {
      await interaction.editReply("Only the thread author or staff can mark this post solved.");
      return;
    }

    const solvedTag = findSolvedTag(parent);
    if (!solvedTag) {
      await interaction.editReply("This forum needs a completion tag named `Solved`, `Complete`, `Answered`, `GitHub Closed`, or `Published` before `/solved` can close posts.");
      return;
    }

    const botMember = interaction.guild?.members.me ?? await interaction.guild?.members.fetchMe();
    if (!botMember || !thread.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageThreads)) {
      await interaction.editReply("I need Manage Threads in this forum before I can tag and archive posts.");
      return;
    }

    await applySolvedTag(thread, parent, solvedTag.id);
    if (!thread.archived) {
      await thread.setArchived(true, "Akron forum post marked solved");
    }
    await interaction.editReply(`Marked this post as ${solvedTag.name} and archived the thread.`);
    return;
  }

  if (interaction.commandName === "close-synced-issue") {
    if (!await requireModerator(interaction, config)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const thread = await resolveThread(interaction, client);
    if (!thread) {
      await interaction.editReply("Run this inside a linked forum thread or pass `thread-id`.");
      return;
    }

    const result = await closeSyncedGithubIssue(config, db, {
      discordThreadId: thread.id,
      reason: interaction.options.getString("reason") ?? ""
    });
    await logAudit(db, {
      actorId: interaction.user.id,
      action: "github_issue_closed",
      target: thread.id,
      details: { issueNumber: result.issueNumber, issueUrl: result.issueUrl }
    });
    await applyGithubClosedTag(thread);
    await interaction.editReply(`Closed GitHub issue #${result.issueNumber}: ${result.issueUrl}`);
    return;
  }

  if (interaction.commandName === "link-issue") {
    if (!await requireModerator(interaction, config)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const thread = await resolveThread(interaction, client);
    const parent = thread?.parent;
    if (!thread || !parent || parent.type !== ChannelType.GuildForum) {
      await interaction.editReply("Run this inside an issues/suggestions forum thread or pass `thread-id`.");
      return;
    }

    const kind = githubIssueKindForForum(parent.name);
    if (!kind) {
      await interaction.editReply("This command only applies to `issues` and `suggestions` forum threads.");
      return;
    }

    const issueNumber = interaction.options.getInteger("issue-number", true);
    const issueUrl = `https://github.com/${config.githubOwner}/${config.githubRepo}/issues/${issueNumber}`;
    await linkGithubIssue(db, {
      discordThreadId: thread.id,
      githubIssueNumber: issueNumber,
      githubIssueUrl: issueUrl,
      kind
    });
    await logAudit(db, {
      actorId: interaction.user.id,
      action: "github_issue_linked",
      target: thread.id,
      details: { issueNumber, issueUrl, kind }
    });
    await applyGithubTags(thread, parent);
    await interaction.editReply(`Linked to GitHub issue #${issueNumber}: ${issueUrl}`);
    return;
  }

  if (interaction.commandName === "unlink-issue") {
    if (!await requireModerator(interaction, config)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const thread = await resolveThread(interaction, client);
    if (!thread) {
      await interaction.editReply("Run this inside a linked forum thread or pass `thread-id`.");
      return;
    }

    const removed = await unlinkGithubIssue(db, thread.id);
    if (removed) {
      await logAudit(db, {
        actorId: interaction.user.id,
        action: "github_issue_unlinked",
        target: thread.id
      });
    }
    await interaction.editReply(removed ? "GitHub link removed." : "No GitHub link existed for this thread.");
    return;
  }

  if (interaction.commandName === "sync-github-labels") {
    if (!await requireAdmin(interaction, config)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const mode = interaction.options.getString("mode", true);
    const changes = mode === "apply" ? await applyGithubLabels(config) : await planGithubLabels(config);
    await interaction.editReply({ embeds: [buildListEmbed(`GitHub Labels ${mode}`, changes)] });
    return;
  }

  if (interaction.commandName === "set-map-mapping") {
    if (!await requireModerator(interaction, config)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const mapUrl = normalizeMapUrl(interaction.options.getString("map-url", true));
    if (!isSupportedMapUrl(mapUrl)) {
      await interaction.editReply("Map URL must be a supported GameBanana mod URL.");
      return;
    }

    const mapSid = interaction.options.getString("map-sid", true).trim();
    const displayName = interaction.options.getString("display-name", true).trim();
    await upsertMapMapping(db, { mapUrl, mapSid, displayName }, interaction.user.id);
    await logAudit(db, {
      actorId: interaction.user.id,
      action: "map_mapping_set",
      target: mapUrl,
      details: { mapSid, displayName }
    });
    await interaction.editReply(`Stored mapping: ${mapUrl} -> ${mapSid}. Rescan affected posts when ready.`);
    return;
  }

  if (interaction.commandName === "delete-upload-pack") {
    if (!await requireAdmin(interaction, config)) {
      return;
    }
    if (!hasUploadWorkerConfig(config)) {
      await interaction.reply({ content: "Upload Worker integration is not configured.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const submissionId = interaction.options.getString("submission-id")?.trim() ?? "";
    const reason = interaction.options.getString("reason")?.trim() || `Deleted by ${interaction.user.username}.`;
    const worker = createUploadWorkerClient(config);
    const currentThread = interaction.channel?.isThread() ? interaction.channel : null;
    if (!submissionId && !currentThread) {
      await interaction.editReply("Run this inside an uploaded pack thread or pass `submission-id`.");
      return;
    }
    const currentThreadId = currentThread?.id;
    const deleted = submissionId
      ? await worker.deleteSubmission(submissionId, reason)
      : await worker.deleteSubmissionByDiscordThread(currentThreadId ?? "", reason);
    const deletingCurrentThread = Boolean(currentThreadId && deleted.discord?.publication?.threadId === currentThreadId);
    const discordResults = await deleteKnownDiscordMessages(
      client,
      deleted.discord,
      deletingCurrentThread && currentThreadId ? { skipPublicationThreadId: currentThreadId } : {}
    );
    if (deletingCurrentThread) {
      discordResults.push(`public post: deleting current thread ${currentThreadId} after response`);
    }
    await interaction.editReply(formatDeleteUploadPackResult({
      submissionId: deleted.submissionId,
      removedCatalogPack: Boolean(deleted.publication?.packId),
      discordResults
    }));
    await logAudit(db, {
      actorId: interaction.user.id,
      action: "upload_pack_deleted",
      target: deleted.submissionId,
      details: {
        batchId: deleted.batchId,
        previousStatus: deleted.previousStatus,
        packId: deleted.publication?.packId ?? "",
        discordResults
      }
    });
    if (deletingCurrentThread && deleted.discord?.publication) {
      const currentThreadDeleteResult = await deleteDiscordMessageReference(client, "public post", deleted.discord.publication);
      const failedDiscordResults = [...discordResults.slice(0, -1), currentThreadDeleteResult];
      if (!isSuccessfulThreadDeleteResult(currentThreadDeleteResult)) {
        await interaction.editReply(formatDeleteUploadPackResult({
          submissionId: deleted.submissionId,
          removedCatalogPack: Boolean(deleted.publication?.packId),
          discordResults: failedDiscordResults
        }));
        await logAudit(db, {
          actorId: interaction.user.id,
          action: "upload_pack_discord_cleanup_failed",
          target: deleted.submissionId,
          details: {
            batchId: deleted.batchId,
            previousStatus: deleted.previousStatus,
            packId: deleted.publication?.packId ?? "",
            discordResults: failedDiscordResults
          }
        });
      }
    }
  }
}

async function resolveThread(interaction: ChatInputCommandInteraction, client: Client<true>): Promise<AnyThreadChannel | null> {
  const requestedId = interaction.options.getString("thread-id");
  if (requestedId) {
    const channel = await client.channels.fetch(requestedId);
    return channel?.isThread() ? channel : null;
  }

  return interaction.channel?.isThread() ? interaction.channel : null;
}

const solvedTagNames = [
  "Solved",
  "Complete",
  "Completed",
  "Resolved",
  "Answered",
  "GitHub Closed",
  "Published",
  "Done",
  "Fixed"
];

function canMarkSolved(interaction: ChatInputCommandInteraction, config: AppConfig, thread: AnyThreadChannel): boolean {
  const member = interaction.member instanceof Object && "roles" in interaction.member
    ? (interaction.member as GuildMember)
    : null;
  return interaction.user.id === thread.ownerId || Boolean(member && isModerator(member, config));
}

function findSolvedTag(parent: ForumChannel): { id: string; name: string } | undefined {
  const tagByNormalizedName = new Map(parent.availableTags.map(tag => [normalizeTagName(tag.name), tag]));
  for (const tagName of solvedTagNames) {
    const tag = tagByNormalizedName.get(normalizeTagName(tagName));
    if (tag) {
      return { id: tag.id, name: tag.name };
    }
  }
  return undefined;
}

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function deleteKnownDiscordMessages(
  client: Client<true>,
  discord: UploadDiscordMessages | undefined,
  options: { skipPublicationThreadId?: string } = {}
): Promise<string[]> {
  const refs = [
    ["public post", discord?.publication],
    ["review message", discord?.review]
  ] as const;
  const results: string[] = [];
  for (const [label, ref] of refs) {
    if (!ref) {
      results.push(`${label}: no recorded message`);
      continue;
    }
    if (label === "public post" && ref.threadId && ref.threadId === options.skipPublicationThreadId) {
      continue;
    }
    results.push(await deleteDiscordMessageReference(client, label, ref));
  }
  return results;
}

async function deleteDiscordMessageReference(client: Client<true>, label: string, ref: UploadDiscordMessage): Promise<string> {
  try {
    if (ref.threadId) {
      const thread = await client.channels.fetch(ref.threadId);
      if (thread?.isThread()) {
        await thread.delete("Akron uploaded pack deleted by admin");
        return `${label}: deleted thread ${ref.threadId}`;
      }
    }

    const channel = await client.channels.fetch(ref.channelId);
    if (channel?.isTextBased() && "messages" in channel) {
      const message = await channel.messages.fetch(ref.messageId);
      await message.delete();
      return `${label}: deleted message ${ref.messageId}`;
    }
    return `${label}: recorded channel was not found`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${label}: delete failed (${message})`;
  }
}

function isSuccessfulThreadDeleteResult(result: string): boolean {
  return /^public post: deleted thread \d+$/.test(result);
}

function formatDeleteUploadPackResult(input: {
  submissionId: string;
  removedCatalogPack: boolean;
  discordResults: string[];
}): string {
  return [
    `Deleted upload submission ${input.submissionId}.`,
    input.removedCatalogPack ? "Catalog/R2 pack was removed." : "No published catalog pack was recorded.",
    ...input.discordResults
  ].join("\n");
}

async function applySolvedTag(thread: AnyThreadChannel, parent: ForumChannel, solvedTagId: string): Promise<void> {
  const solvedTagIds = new Set(parent.availableTags
    .filter(tag => solvedTagNames.some(name => normalizeTagName(name) === normalizeTagName(tag.name)))
    .map(tag => tag.id));
  const next = thread.appliedTags.filter(tagId => !solvedTagIds.has(tagId));
  next.push(solvedTagId);
  await thread.setAppliedTags(next, "Akron forum post marked solved");
}

function buildListEmbed(title: string, items: string[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0xc42a30)
    .setDescription(items.map(item => `- ${item}`).join("\n").slice(0, 4000));
}

export function formatGithubForumSyncResult(result: GithubForumSyncResult): string {
  if (result.status === "created") {
    return `Created GitHub issue #${result.issueNumber}: ${result.issueUrl}`;
  }
  if (result.status === "updated") {
    return `Updated GitHub issue #${result.issueNumber}: ${result.issueUrl}`;
  }
  if (result.status === "already-linked") {
    return `Already linked to GitHub issue #${result.issueNumber}: ${result.issueUrl}`;
  }
  return `GitHub sync skipped: ${result.reason}.`;
}
