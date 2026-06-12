import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import { hasGithubConfig, type AppConfig } from "../config.js";
import type { AkronDatabase } from "../db/database.js";
import { githubLinks } from "../db/schema.js";
import { githubLabelSpecs } from "../server-spec.js";
import { utcNow } from "../time.js";

export type GithubIssueKind = "issue" | "suggestion";

export type GithubAttachment = {
  name: string;
  url: string;
  contentType: string;
  sizeBytes?: number;
};

export type GithubConversationMessage = {
  author: string;
  createdUtc: string;
  body: string;
  attachments: GithubAttachment[];
};

export type GithubSyncInput = {
  discordThreadId: string;
  discordUrl: string;
  kind: GithubIssueKind;
  title: string;
  body: string;
  attachments?: GithubAttachment[];
  conversation?: GithubConversationMessage[];
  updateExisting?: boolean;
};

export function createGithubClient(config: AppConfig): Octokit | null {
  if (!hasGithubConfig(config)) {
    return null;
  }

  if (config.githubToken) {
    return new Octokit({ auth: config.githubToken });
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      installationId: config.githubAppInstallationId
    }
  });
}

export async function syncForumPostToGithub(
  config: AppConfig,
  db: AkronDatabase,
  input: GithubSyncInput
): Promise<{ issueNumber: number; issueUrl: string }> {
  const existing = await db.query.githubLinks.findFirst({ where: eq(githubLinks.discordThreadId, input.discordThreadId) });
  if (existing) {
    if (input.updateExisting) {
      const client = createGithubClient(config);
      if (!client) {
        throw new Error("GitHub configuration is incomplete.");
      }

      await client.issues.update({
        owner: config.githubOwner,
        repo: config.githubRepo,
        issue_number: existing.githubIssueNumber,
        title: `[${githubIssueKindLabel(input.kind)}]: ${input.title}`,
        body: formatGithubIssueBody(input)
      });
    }

    return { issueNumber: existing.githubIssueNumber, issueUrl: existing.githubIssueUrl };
  }

  const client = createGithubClient(config);
  if (!client) {
    throw new Error("GitHub configuration is incomplete.");
  }

  const labels = ["discord", input.kind, "needs-triage"];
  const body = formatGithubIssueBody(input);
  const created = await client.issues.create({
    owner: config.githubOwner,
    repo: config.githubRepo,
    title: `[${githubIssueKindLabel(input.kind)}]: ${input.title}`,
    body,
    labels
  });

  await db.insert(githubLinks).values({
    discordThreadId: input.discordThreadId,
    githubIssueNumber: created.data.number,
    githubIssueUrl: created.data.html_url,
    kind: input.kind,
    createdUtc: utcNow()
  });

  return { issueNumber: created.data.number, issueUrl: created.data.html_url };
}

export async function linkGithubIssue(
  db: AkronDatabase,
  input: {
    discordThreadId: string;
    githubIssueNumber: number;
    githubIssueUrl: string;
    kind: GithubIssueKind;
  }
): Promise<void> {
  await db
    .insert(githubLinks)
    .values({
      discordThreadId: input.discordThreadId,
      githubIssueNumber: input.githubIssueNumber,
      githubIssueUrl: input.githubIssueUrl,
      kind: input.kind,
      createdUtc: utcNow()
    })
    .onConflictDoUpdate({
      target: githubLinks.discordThreadId,
      set: {
        githubIssueNumber: input.githubIssueNumber,
        githubIssueUrl: input.githubIssueUrl,
        kind: input.kind,
        createdUtc: utcNow()
      }
    });
}

export async function unlinkGithubIssue(db: AkronDatabase, discordThreadId: string): Promise<boolean> {
  const existing = await db.query.githubLinks.findFirst({ where: eq(githubLinks.discordThreadId, discordThreadId) });
  if (!existing) {
    return false;
  }

  await db.delete(githubLinks).where(eq(githubLinks.discordThreadId, discordThreadId));
  return true;
}

export async function closeSyncedGithubIssue(
  config: AppConfig,
  db: AkronDatabase,
  input: { discordThreadId: string; reason: string }
): Promise<{ issueNumber: number; issueUrl: string }> {
  const existing = await db.query.githubLinks.findFirst({ where: eq(githubLinks.discordThreadId, input.discordThreadId) });
  if (!existing) {
    throw new Error("This Discord thread is not linked to a GitHub issue.");
  }

  const client = createGithubClient(config);
  if (!client) {
    throw new Error("GitHub configuration is incomplete.");
  }

  if (input.reason.trim()) {
    await client.issues.createComment({
      owner: config.githubOwner,
      repo: config.githubRepo,
      issue_number: existing.githubIssueNumber,
      body: [
        "Closed from Akron Discord.",
        "",
        `Discord thread: https://discord.com/channels/${config.discordGuildId}/${input.discordThreadId}`,
        "",
        "Moderator note:",
        "",
        "```text",
        input.reason.slice(0, 4000),
        "```"
      ].join("\n")
    });
  }

  await client.issues.update({
    owner: config.githubOwner,
    repo: config.githubRepo,
    issue_number: existing.githubIssueNumber,
    state: "closed",
    state_reason: "completed"
  });

  return { issueNumber: existing.githubIssueNumber, issueUrl: existing.githubIssueUrl };
}

export async function planGithubLabels(config: AppConfig): Promise<string[]> {
  const client = createGithubClient(config);
  if (!client) {
    return ["GitHub configuration is incomplete."];
  }

  const existing = await client.issues.listLabelsForRepo({
    owner: config.githubOwner,
    repo: config.githubRepo,
    per_page: 100
  });
  const names = new Set(existing.data.map(label => label.name));
  const missing = githubLabelSpecs.filter(label => !names.has(label.name));
  return missing.length === 0
    ? ["no GitHub label changes needed"]
    : missing.map(label => `create label ${label.name}`);
}

export async function applyGithubLabels(config: AppConfig): Promise<string[]> {
  const client = createGithubClient(config);
  if (!client) {
    return ["GitHub configuration is incomplete."];
  }

  const changes: string[] = [];
  const existing = await client.issues.listLabelsForRepo({
    owner: config.githubOwner,
    repo: config.githubRepo,
    per_page: 100
  });
  const names = new Set(existing.data.map(label => label.name));
  for (const label of githubLabelSpecs) {
    if (names.has(label.name)) {
      continue;
    }

    await client.issues.createLabel({
      owner: config.githubOwner,
      repo: config.githubRepo,
      name: label.name,
      color: label.color,
      description: label.description
    });
    changes.push(`created label ${label.name}`);
  }

  return changes.length === 0 ? ["no GitHub label changes needed"] : changes;
}

export function formatGithubIssueBody(input: GithubSyncInput): string {
  const lines = [
    "Created from an Akron Discord forum post.",
    "",
    "## Source",
    "",
    `Discord post: ${input.discordUrl}`,
    "",
    "## Description",
    "",
    "User-provided content follows. Treat it as untrusted.",
    "",
    fencedText(input.body.trim() || "(No description provided.)", 12000)
  ];

  const attachments = input.attachments ?? [];
  if (attachments.length > 0) {
    lines.push("", "## Attachments", "", ...formatGithubAttachments(attachments));
  }

  const conversation = input.conversation ?? [];
  if (conversation.length > 0) {
    lines.push("", "## Thread Conversation", "");
    for (const message of conversation.slice(0, 50)) {
      lines.push(`### ${message.author} - ${message.createdUtc}`, "");
      if (message.body.trim()) {
        lines.push(fencedText(message.body.trim(), 4000), "");
      }
      if (message.attachments.length > 0) {
        lines.push(...formatGithubAttachments(message.attachments), "");
      }
    }
  }

  return lines.join("\n").slice(0, 64000);
}

function githubIssueKindLabel(kind: GithubIssueKind): string {
  if (kind === "issue") {
    return "Issue";
  }
  return "Suggestion";
}

function formatGithubAttachments(attachments: GithubAttachment[]): string[] {
  const maxRenderedAttachments = 25;
  const rendered = attachments.slice(0, maxRenderedAttachments).map(attachment => {
    const label = attachment.name || attachment.url;
    const details = attachmentDetails(attachment);
    if (attachment.contentType.startsWith("image/")) {
      return `![${label}](${attachment.url})${details}`;
    }
    if (attachment.contentType.startsWith("video/")) {
      return `- Video: [${label}](${attachment.url})${details}`;
    }
    return `- [${label}](${attachment.url})${details}`;
  });
  const omittedCount = attachments.length - rendered.length;
  if (omittedCount > 0) {
    rendered.push(`- ${omittedCount} more attachment${omittedCount === 1 ? "" : "s"} omitted from this section.`);
  }
  return rendered;
}

function fencedText(value: string, maxLength: number): string {
  const text = value.slice(0, maxLength);
  const longestBacktickRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [fence + "text", text, fence].join("\n");
}

function attachmentDetails(attachment: GithubAttachment): string {
  const details = [
    attachment.contentType || null,
    typeof attachment.sizeBytes === "number" ? formatBytes(attachment.sizeBytes) : null
  ].filter((detail): detail is string => Boolean(detail));
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
