import { eq } from "drizzle-orm";
import {
  ChannelType,
  EmbedBuilder,
  type AnyThreadChannel,
  type ForumChannel,
  type TextChannel
} from "discord.js";
import type { AppConfig } from "./config.js";
import type { AkronDatabase } from "./db/database.js";
import { githubLinks } from "./db/schema.js";
import { logAudit } from "./services/audit.js";
import { syncForumPostToGithub, type GithubIssueKind } from "./services/github-sync.js";

export function githubIssueKindForForum(name: string): GithubIssueKind | null {
  if (name === "issues") {
    return "issue";
  }
  if (name === "suggestions") {
    return "suggestion";
  }
  return null;
}

export async function syncGithubForumThread(input: {
  config: AppConfig;
  db: AkronDatabase;
  thread: AnyThreadChannel;
}): Promise<void> {
  if (input.thread.ownerId === input.thread.client.user.id) {
    return;
  }

  const parent = input.thread.parent;
  if (!parent || parent.type !== ChannelType.GuildForum) {
    return;
  }

  const kind = githubIssueKindForForum(parent.name);
  if (!kind) {
    return;
  }

  const existing = await input.db.query.githubLinks.findFirst({ where: eq(githubLinks.discordThreadId, input.thread.id) });
  if (existing) {
    await applyGithubTags(input.thread, parent);
    return;
  }

  const starter = await input.thread.fetchStarterMessage();
  if (!starter) {
    await input.thread.send({ embeds: [buildGithubSyncEmbed("Needs moderator review: could not fetch starter message.")] });
    return;
  }

  let result: { issueNumber: number; issueUrl: string };
  try {
    result = await syncForumPostToGithub(input.config, input.db, {
      discordThreadId: input.thread.id,
      discordUrl: input.thread.url,
      kind,
      title: input.thread.name,
      body: starter.content
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub sync failed.";
    await input.thread.send({ embeds: [buildGithubSyncEmbed("GitHub sync failed. Staff have been alerted.")] });
    await sendGithubLog(input.thread, `GitHub sync failed for ${input.thread.url}: ${message}`);
    await logAudit(input.db, {
      actorId: "bot",
      action: "github_sync_failed",
      target: input.thread.id,
      details: { threadUrl: input.thread.url, kind, reason: message }
    });
    throw error;
  }

  await applyGithubTags(input.thread, parent);
  await input.thread.send({
    embeds: [
      buildGithubSyncEmbed(`Synced to [GitHub issue #${result.issueNumber}](${result.issueUrl}).`, result.issueUrl)
    ]
  });
  await logAudit(input.db, {
    actorId: "bot",
    action: "github_issue_synced",
    target: input.thread.id,
    details: { issueNumber: result.issueNumber, issueUrl: result.issueUrl, kind }
  });
  await sendGithubLog(input.thread, `Synced ${kind} ${input.thread.url} to ${result.issueUrl}`);
}

export async function applyGithubTags(thread: AnyThreadChannel, parent: ForumChannel): Promise<void> {
  const tagByName = new Map(parent.availableTags.map(tag => [tag.name, tag.id]));
  const next = [...thread.appliedTags];
  for (const name of ["Synced", "GitHub Open"]) {
    const tagId = tagByName.get(name);
    if (tagId && !next.includes(tagId)) {
      next.push(tagId);
    }
  }

  if (typeof thread.setAppliedTags === "function") {
    await thread.setAppliedTags(next, "Akron GitHub sync status update");
  }
}

export function buildGithubSyncEmbed(message: string, url?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("GitHub Sync")
    .setDescription(message)
    .setColor(0x5865f2);
  if (url) {
    embed.setURL(url);
  }
  return embed;
}

async function sendGithubLog(thread: AnyThreadChannel, content: string): Promise<void> {
  const channel = thread.guild.channels.cache.find(candidate => candidate.name === "github-sync-log" && candidate.type === ChannelType.GuildText) as TextChannel | undefined;
  if (channel) {
    await channel.send({ content: content.slice(0, 1900) });
  }
}
