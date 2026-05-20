import type { Guild, TextChannel } from "discord.js";
import { ChannelType } from "discord.js";
import type { AkronDatabase } from "../db/database.js";
import { auditLogs } from "../db/schema.js";
import { utcNow } from "../time.js";

export async function logAudit(db: AkronDatabase, input: {
  actorId: string;
  action: string;
  target: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: input.actorId,
    action: input.action,
    target: input.target,
    detailsJson: JSON.stringify(input.details ?? {}),
    createdUtc: utcNow()
  });
}

export async function sendAuditLog(guild: Guild, content: string): Promise<void> {
  const channel = guild.channels.cache.find(candidate => candidate.name === "audit-log" && candidate.type === ChannelType.GuildText) as TextChannel | undefined;
  if (!channel) {
    return;
  }

  await channel.send({ content: content.slice(0, 1900) });
}
