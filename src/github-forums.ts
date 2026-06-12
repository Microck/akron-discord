import { eq } from "drizzle-orm";
import {
  ChannelType,
  EmbedBuilder,
  type AnyThreadChannel,
  type ForumChannel,
  type Message,
  type TextChannel
} from "discord.js";
import type { AppConfig } from "./config.js";
import type { AkronDatabase } from "./db/database.js";
import { githubLinks } from "./db/schema.js";
import { logAudit } from "./services/audit.js";
import {
  syncForumPostToGithub,
  type GithubAttachment,
  type GithubConversationMessage,
  type GithubIssueKind
} from "./services/github-sync.js";

export type GithubForumSyncResult =
  | { status: "created"; issueNumber: number; issueUrl: string }
  | { status: "updated"; issueNumber: number; issueUrl: string }
  | { status: "already-linked"; issueNumber: number; issueUrl: string }
  | { status: "skipped"; reason: string };

export function githubIssueKindForForum(name: string): GithubIssueKind | null {
  if (name === "issues") {
    return "issue";
  }
  if (name === "suggestions") {
    return "suggestion";
  }
  return null;
}

export function githubIssueKindForForumSync(name: string, allowUnsupportedForum: boolean): GithubIssueKind | null {
  return githubIssueKindForForum(name) ?? (allowUnsupportedForum ? "issue" : null);
}

export async function syncGithubForumThread(input: {
  config: AppConfig;
  db: AkronDatabase;
  thread: AnyThreadChannel;
  allowBotAuthored?: boolean;
  allowUnsupportedForum?: boolean;
  updateExisting?: boolean;
}): Promise<GithubForumSyncResult> {
  if (!input.allowBotAuthored && input.thread.ownerId === input.thread.client.user.id) {
    return { status: "skipped", reason: "automatic sync skips bot-authored forum posts" };
  }

  const parent = input.thread.parent;
  if (!parent || parent.type !== ChannelType.GuildForum) {
    return { status: "skipped", reason: "thread is not inside a forum channel" };
  }

  const kind = githubIssueKindForForumSync(parent.name, input.allowUnsupportedForum ?? false);
  if (!kind) {
    return { status: "skipped", reason: "parent forum is not `issues` or `suggestions`" };
  }

  const existing = await input.db.query.githubLinks.findFirst({ where: eq(githubLinks.discordThreadId, input.thread.id) });
  if (existing && !input.updateExisting) {
    await applyGithubTags(input.thread, parent);
    return {
      status: "already-linked",
      issueNumber: existing.githubIssueNumber,
      issueUrl: existing.githubIssueUrl
    };
  }

  const starter = await input.thread.fetchStarterMessage();
  if (!starter) {
    await input.thread.send({ embeds: [buildGithubSyncEmbed("Needs moderator review: could not fetch starter message.")] });
    return { status: "skipped", reason: "could not fetch starter message" };
  }

  const threadContext = await collectGithubThreadContext(input.thread, starter);
  let result: { issueNumber: number; issueUrl: string };
  try {
    result = await syncForumPostToGithub(input.config, input.db, {
      discordThreadId: input.thread.id,
      discordUrl: input.thread.url,
      kind,
      title: input.thread.name,
      body: starter.content,
      attachments: threadContext.attachments,
      conversation: threadContext.conversation,
      updateExisting: input.updateExisting
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
  return {
    status: existing ? "updated" : "created",
    issueNumber: result.issueNumber,
    issueUrl: result.issueUrl
  };
}

async function collectGithubThreadContext(
  thread: AnyThreadChannel,
  starter: Message
): Promise<{ attachments: GithubAttachment[]; conversation: GithubConversationMessage[] }> {
  const messages = await thread.messages.fetch({ after: starter.id, limit: 100 });
  const conversation = Array.from(messages.values())
    .filter(message => message.id !== starter.id && !message.author.bot)
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(message => ({
      author: message.member?.displayName ?? message.author.username,
      createdUtc: message.createdAt.toISOString(),
      body: message.cleanContent || message.content,
      attachments: githubAttachmentsFromMessage(message)
    }));

  return {
    attachments: githubAttachmentsFromMessage(starter),
    conversation
  };
}

function githubAttachmentsFromMessage(message: Message): GithubAttachment[] {
  return Array.from(message.attachments.values()).map(attachment => ({
    name: attachment.name ?? "attachment",
    url: attachment.url,
    contentType: attachment.contentType ?? "",
    sizeBytes: attachment.size
  }));
}

export async function applyGithubTags(thread: AnyThreadChannel, parent: ForumChannel): Promise<void> {
  await applyGithubOpenTag(thread, parent);
}

export async function applyGithubOpenTag(thread: AnyThreadChannel, parent: ForumChannel): Promise<void> {
  const tagByName = new Map(parent.availableTags.map(tag => [tag.name, tag.id]));
  const closedId = tagByName.get("GitHub Closed");
  const next = thread.appliedTags.filter(tag => tag !== closedId);
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

export async function applyGithubClosedTag(thread: AnyThreadChannel): Promise<void> {
  const parent = thread.parent;
  if (!parent || parent.type !== ChannelType.GuildForum) {
    return;
  }

  const tagByName = new Map(parent.availableTags.map(tag => [tag.name, tag.id]));
  const openId = tagByName.get("GitHub Open");
  const closedId = tagByName.get("GitHub Closed");
  const next = thread.appliedTags.filter(tag => tag !== openId);
  if (closedId && !next.includes(closedId)) {
    next.push(closedId);
  }
  if (typeof thread.setAppliedTags === "function") {
    await thread.setAppliedTags(next, "Akron GitHub close status update");
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
