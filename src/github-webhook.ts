import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { ChannelType, type AnyThreadChannel, type Client } from "discord.js";
import type { AppConfig } from "./config.js";
import type { AkronDatabase } from "./db/database.js";
import { githubLinks } from "./db/schema.js";
import { applyGithubClosedTag, applyGithubOpenTag } from "./github-forums.js";

type GithubIssuePayload = {
  action: string;
  issue: {
    number: number;
    html_url: string;
    title: string;
  };
  sender?: {
    login?: string;
  };
};

type GithubIssueCommentPayload = {
  action: string;
  issue: {
    number: number;
    html_url: string;
    title: string;
  };
  comment: {
    body: string;
    html_url: string;
    user?: {
      login?: string;
    };
  };
};

export function startGithubWebhookServer(input: {
  client: Client;
  config: AppConfig;
  db: AkronDatabase;
  onError: (error: unknown) => Promise<void>;
}): Server | null {
  if (!input.config.githubWebhookSecret) {
    console.log("GitHub webhook server disabled: GITHUB_WEBHOOK_SECRET is not configured.");
    return null;
  }

  const server = createServer((request, response) => {
    void handleGithubWebhookRequest(input, request, response).catch(async error => {
      await input.onError(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "webhook failed" }));
    });
  });
  server.listen(input.config.githubWebhookPort, "0.0.0.0", () => {
    console.log(`GitHub webhook server listening on port ${input.config.githubWebhookPort}`);
  });
  return server;
}

async function handleGithubWebhookRequest(
  input: {
    client: Client;
    config: AppConfig;
    db: AkronDatabase;
  },
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/github/webhook") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const body = await readRequestBody(request, 1024 * 1024);
  const signature = request.headers["x-hub-signature-256"];
  if (typeof signature !== "string" || !verifyGithubWebhookSignature(input.config.githubWebhookSecret, body, signature)) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid signature" }));
    return;
  }

  const eventName = request.headers["x-github-event"];
  const payload = JSON.parse(body.toString("utf8")) as unknown;
  if (eventName === "issues") {
    await handleGithubIssuesWebhook(input, payload as GithubIssuePayload);
  } else if (eventName === "issue_comment") {
    await handleGithubIssueCommentWebhook(input, payload as GithubIssueCommentPayload);
  }

  response.writeHead(202, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
}

export function verifyGithubWebhookSignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBytes = Buffer.from(expected, "utf8");
  const signatureBytes = Buffer.from(signature, "utf8");
  return expectedBytes.length === signatureBytes.length && timingSafeEqual(expectedBytes, signatureBytes);
}

async function handleGithubIssueCommentWebhook(
  input: {
    client: Client;
    db: AkronDatabase;
  },
  payload: GithubIssueCommentPayload
): Promise<void> {
  if (payload.action !== "created") {
    return;
  }
  if (payload.comment.body.startsWith("Closed from Akron Discord.")) {
    return;
  }

  const thread = await fetchLinkedThread(input, payload.issue.number);
  if (!thread) {
    return;
  }

  const wasArchived = thread.archived;
  const wasLocked = thread.locked;
  if (thread.archived) {
    await thread.setArchived(false, "Akron GitHub comment sync");
  }
  if (thread.locked) {
    await thread.setLocked(false, "Akron GitHub comment sync");
  }

  await thread.send({
    content: truncateDiscordMessage([
      `GitHub comment by ${payload.comment.user?.login ?? "unknown"} on #${payload.issue.number}:`,
      payload.comment.html_url,
      "",
      payload.comment.body.trim() || "(No comment body.)"
    ].join("\n"))
  });
  if (wasLocked) {
    await thread.setLocked(true, "Akron GitHub comment sync");
  }
  if (wasArchived) {
    await thread.setArchived(true, "Akron GitHub comment sync");
  }
}

async function handleGithubIssuesWebhook(
  input: {
    client: Client;
    db: AkronDatabase;
  },
  payload: GithubIssuePayload
): Promise<void> {
  if (payload.action !== "closed" && payload.action !== "reopened") {
    return;
  }

  const thread = await fetchLinkedThread(input, payload.issue.number);
  if (!thread) {
    return;
  }

  if (payload.action === "closed") {
    if (thread.archived) {
      await thread.setArchived(false, "Akron GitHub issue closed");
    }
    await applyGithubClosedTag(thread);
    await thread.send({
      content: truncateDiscordMessage(`GitHub issue #${payload.issue.number} was closed by ${payload.sender?.login ?? "unknown"}: ${payload.issue.html_url}`)
    });
    if (!thread.locked) {
      await thread.setLocked(true, "Akron GitHub issue closed");
    }
    if (!thread.archived) {
      await thread.setArchived(true, "Akron GitHub issue closed");
    }
    return;
  }

  if (thread.archived) {
    await thread.setArchived(false, "Akron GitHub issue reopened");
  }
  if (thread.locked) {
    await thread.setLocked(false, "Akron GitHub issue reopened");
  }
  const parent = thread.parent;
  if (parent?.type === ChannelType.GuildForum) {
    await applyGithubOpenTag(thread, parent);
  }
  await thread.send({
    content: truncateDiscordMessage(`GitHub issue #${payload.issue.number} was reopened by ${payload.sender?.login ?? "unknown"}: ${payload.issue.html_url}`)
  });
}

async function fetchLinkedThread(
  input: {
    client: Client;
    db: AkronDatabase;
  },
  issueNumber: number
): Promise<AnyThreadChannel | null> {
  const link = await input.db.query.githubLinks.findFirst({
    where: eq(githubLinks.githubIssueNumber, issueNumber)
  });
  if (!link) {
    return null;
  }

  const channel = await input.client.channels.fetch(link.discordThreadId);
  return channel?.isThread() ? channel : null;
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error("GitHub webhook payload exceeded 1 MB.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function truncateDiscordMessage(content: string): string {
  return content.length <= 1900 ? content : `${content.slice(0, 1897)}...`;
}
