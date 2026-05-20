import {
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  type AnyThreadChannel,
  type ChatInputCommandInteraction,
  type Client,
  type ForumChannel
} from "discord.js";
import type { AppConfig } from "./config.js";
import type { AkronDatabase } from "./db/database.js";
import { applyGithubTags, githubIssueKindForForum, syncGithubForumThread } from "./github-forums.js";
import { requireAdmin, requireModerator } from "./permissions.js";
import { logAudit } from "./services/audit.js";
import { applyGithubLabels, closeSyncedGithubIssue, linkGithubIssue, planGithubLabels, unlinkGithubIssue } from "./services/github-sync.js";
import { upsertMapMapping } from "./services/map-resolver.js";
import { applyServerSync, planServerSync } from "./server-sync.js";
import { isSupportedMapUrl, normalizeMapUrl } from "./submissions/post-parser.js";
import { scanSubmissionThread } from "./submissions/scanner.js";

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
      await interaction.editReply("Run this inside an issues/suggestions forum thread or pass `thread-id`.");
      return;
    }

    await syncGithubForumThread({ config, db, thread });
    await interaction.editReply("GitHub sync completed.");
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
    await applyClosedGithubTag(thread);
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

function buildListEmbed(title: string, items: string[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0xc42a30)
    .setDescription(items.map(item => `- ${item}`).join("\n").slice(0, 4000));
}

async function applyClosedGithubTag(thread: AnyThreadChannel): Promise<void> {
  const parent = thread.parent;
  if (!parent || parent.type !== ChannelType.GuildForum) {
    return;
  }

  const forum = parent as ForumChannel;
  const tagByName = new Map(forum.availableTags.map(tag => [tag.name, tag.id]));
  const openId = tagByName.get("GitHub Open");
  const closedId = tagByName.get("GitHub Closed");
  const next = thread.appliedTags.filter(tag => tag !== openId);
  if (closedId && !next.includes(closedId)) {
    next.push(closedId);
  }
  await thread.setAppliedTags(next, "Akron GitHub close status update");
}
