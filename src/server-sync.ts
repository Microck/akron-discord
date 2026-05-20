import { eq } from "drizzle-orm";
import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type GuildForumTagData,
  type OverwriteResolvable,
  PermissionsBitField,
  type TextChannel
} from "discord.js";
import { botSettings } from "./db/schema.js";
import type { AkronDatabase } from "./db/database.js";
import { categorySpecs, channelSpecs, roleSpecs, submissionChannelScopes, type ChannelSpec } from "./server-spec.js";
import { buildRulesEmbed, buildSubmissionGuideEmbed, buildVerifyComponents, buildVerifyEmbed, feedbackForumGuidelines, forumGuidelines } from "./content.js";
import { utcNow } from "./time.js";

export type ServerSyncPlan = {
  changes: string[];
};

export async function planServerSync(guild: Guild): Promise<ServerSyncPlan> {
  const changes: string[] = [];
  const roles = new Map<string, string>();
  for (const role of roleSpecs) {
    const existing = guild.roles.cache.find(candidate => candidate.name === role.name);
    if (!existing) {
      changes.push(`create role ${role.name}`);
    } else {
      roles.set(role.key, existing.id);
    }
  }

  for (const category of categorySpecs) {
    if (!guild.channels.cache.find(channel => channel.type === ChannelType.GuildCategory && channel.name === category.name)) {
      changes.push(`create category ${category.name}`);
    }
  }

  for (const channel of channelSpecs) {
    const existing = guild.channels.cache.find(candidate => candidate.name === channel.name);
    if (!existing) {
      changes.push(`create ${describeChannelType(channel.type)} channel ${channel.name}`);
      continue;
    }

    if (existing.type !== channel.type) {
      changes.push(`replace ${channel.name} type ${describeChannelType(existing.type)} -> ${describeChannelType(channel.type)}`);
      continue;
    }

    const topic = buildChannelTopic(channel);
    if ("topic" in existing && topic && existing.topic !== topic) {
      changes.push(`update topic for ${channel.name}`);
    }

    if (existing.type === ChannelType.GuildForum && !forumTagsMatch(existing.availableTags.map(tag => tag.name), channel.forumTags ?? [])) {
      changes.push(`update forum tags for ${channel.name}`);
    }

    if (roles.size === roleSpecs.length && "permissionOverwrites" in existing) {
      const expected = buildPermissionOverwrites(guild.id, roles, channel);
      if (!permissionOverwritesMatch(existing, expected)) {
        changes.push(`update permissions for ${channel.name}`);
      }
    }
  }

  if (changes.length === 0) {
    changes.push("no structural changes needed");
  }

  return { changes };
}

export async function applyServerSync(guild: Guild, db: AkronDatabase): Promise<ServerSyncPlan> {
  const changes: string[] = [];
  const roles = new Map<string, string>();
  for (const role of roleSpecs) {
    const existing = guild.roles.cache.find(candidate => candidate.name === role.name);
    const resolved = existing ?? await guild.roles.create({ name: role.name, reason: "Akron server sync" });
    roles.set(role.key, resolved.id);
    if (!existing) {
      changes.push(`created role ${role.name}`);
    }
  }

  for (const [key, id] of roles) {
    await upsertSetting(db, `role.${key}.id`, id);
  }

  const categories = new Map<string, string>();
  for (const category of categorySpecs) {
    const existing = guild.channels.cache.find(channel => channel.type === ChannelType.GuildCategory && channel.name === category.name);
    const resolved = existing ?? await guild.channels.create({
      name: category.name,
      type: ChannelType.GuildCategory,
      reason: "Akron server sync"
    });
    categories.set(category.key, resolved.id);
    if (!existing) {
      changes.push(`created category ${category.name}`);
    }
  }

  for (const channelSpec of channelSpecs) {
    const existing = guild.channels.cache.find(channel => channel.name === channelSpec.name);
    if (existing && existing.type !== channelSpec.type) {
      changes.push(`skipped ${channelSpec.name}: existing channel has incompatible type`);
      continue;
    }

    const parent = categories.get(channelSpec.category);
    const permissionOverwrites = buildPermissionOverwrites(guild.id, roles, channelSpec);
    const channel = existing ?? await guild.channels.create({
      name: channelSpec.name,
      type: channelSpec.type,
      parent,
      topic: buildChannelTopic(channelSpec),
      availableTags: buildForumTags(channelSpec),
      reason: "Akron server sync",
      permissionOverwrites
    });

    if (!existing) {
      changes.push(`created channel ${channelSpec.name}`);
    }

    await configureExistingChannel(channel, channelSpec, parent, permissionOverwrites);
  }

  await ensureVerifyMessage(guild, db);
  await ensureRulesMessage(guild, db);
  await ensureSubmissionGuideMessage(guild, db);

  if (changes.length === 0) {
    changes.push("no structural changes needed");
  }

  return { changes };
}

async function configureExistingChannel(
  channel: GuildBasedChannel,
  spec: ChannelSpec,
  parent: string | undefined,
  permissionOverwrites: OverwriteResolvable[]
): Promise<void> {
  if ("setParent" in channel && parent && channel.parentId !== parent) {
    await channel.setParent(parent, { lockPermissions: false, reason: "Akron server sync" });
  }

  const topic = buildChannelTopic(spec);
  if ("setTopic" in channel && topic && channel.topic !== topic) {
    await channel.setTopic(topic);
  }

  if ("permissionOverwrites" in channel) {
    await channel.permissionOverwrites.set(permissionOverwrites, "Akron server sync");
  }

  if (channel.type === ChannelType.GuildForum) {
    await channel.setAvailableTags(buildForumTags(spec) ?? []);
    if (spec.category === "map-catalog" || spec.category === "general-packs") {
      await channel.setDefaultThreadRateLimitPerUser(30, "Akron server sync");
    }
  }
}

export function buildPermissionOverwrites(guildId: string, roles: Map<string, string>, spec: ChannelSpec): OverwriteResolvable[] {
  const admin = roles.get("admin") ?? "";
  const moderator = roles.get("moderator") ?? "";
  const member = roles.get("member") ?? "";
  const everyoneDeny = {
    id: guildId,
    deny: [PermissionsBitField.Flags.ViewChannel]
  };
  const memberReadAllow = {
    id: member,
    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
    deny: [PermissionsBitField.Flags.SendMessages]
  };
  const memberPostAllow = {
    id: member,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.SendMessagesInThreads,
      PermissionsBitField.Flags.CreatePublicThreads
    ]
  };
  const moderatorAllow = {
    id: moderator,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.SendMessagesInThreads,
      PermissionsBitField.Flags.CreatePublicThreads,
      PermissionsBitField.Flags.ManageThreads
    ]
  };
  const adminAllow = {
    id: admin,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.SendMessagesInThreads,
      PermissionsBitField.Flags.CreatePublicThreads,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ManageThreads
    ]
  };

  if (spec.name === "verify" || spec.name === "rules") {
    return [
      {
        id: guildId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
        deny: [PermissionsBitField.Flags.SendMessages]
      },
      memberReadAllow,
      moderatorAllow,
      adminAllow
    ];
  }

  if (spec.visibility === "public") {
    return [memberPostAllow, moderatorAllow, adminAllow];
  }

  if (spec.category === "info") {
    return [everyoneDeny, memberReadAllow, moderatorAllow, adminAllow];
  }

  if (spec.visibility === "member") {
    return [everyoneDeny, memberPostAllow, moderatorAllow, adminAllow];
  }

  if (spec.visibility === "staff") {
    return [everyoneDeny, moderatorAllow, adminAllow];
  }

  return [everyoneDeny, adminAllow];
}

function buildForumTags(spec: ChannelSpec): GuildForumTagData[] | undefined {
  if (spec.type !== ChannelType.GuildForum) {
    return undefined;
  }

  return (spec.forumTags ?? []).map(name => ({
    name,
    moderated: ["Published", "Flagged", "Needs Moderator Review", "GitHub Closed", "Duplicate", "Invalid", "Not Planned"].includes(name)
  }));
}

function buildChannelTopic(spec: ChannelSpec): string | undefined {
  if (spec.type === ChannelType.GuildForum && submissionChannelScopes.has(spec.name)) {
    return forumGuidelines(submissionChannelScopes.get(spec.name) ?? "Akron");
  }

  if (spec.name === "issues") {
    return feedbackForumGuidelines("issue");
  }

  if (spec.name === "suggestions") {
    return feedbackForumGuidelines("suggestion");
  }

  return spec.topic;
}

function forumTagsMatch(existing: string[], expected: string[]): boolean {
  if (existing.length !== expected.length) {
    return false;
  }

  return expected.every(name => existing.includes(name));
}

function permissionOverwritesMatch(channel: GuildBasedChannel, expected: OverwriteResolvable[]): boolean {
  if (!("permissionOverwrites" in channel)) {
    return true;
  }

  const expectedMap = new Map(expected.map(overwrite => {
    const data = overwrite as { id: string; allow?: bigint[]; deny?: bigint[] };
    return [data.id, {
      allow: new PermissionsBitField(data.allow ?? []).bitfield.toString(),
      deny: new PermissionsBitField(data.deny ?? []).bitfield.toString()
    }];
  }));

  if (channel.permissionOverwrites.cache.size !== expectedMap.size) {
    return false;
  }

  return channel.permissionOverwrites.cache.every(overwrite => {
    const expectedOverwrite = expectedMap.get(overwrite.id);
    return Boolean(
      expectedOverwrite &&
        overwrite.allow.bitfield.toString() === expectedOverwrite.allow &&
        overwrite.deny.bitfield.toString() === expectedOverwrite.deny
    );
  });
}

async function ensureVerifyMessage(guild: Guild, db: AkronDatabase): Promise<void> {
  const verify = guild.channels.cache.find(channel => channel.name === "verify" && channel.type === ChannelType.GuildText) as TextChannel | undefined;
  if (!verify) {
    return;
  }

  const setting = await db.query.botSettings.findFirst({ where: eq(botSettings.key, "message.verify.id") });
  if (setting) {
    try {
      const message = await verify.messages.fetch(setting.value);
      await message.edit({ embeds: [buildVerifyEmbed()], components: buildVerifyComponents() });
      return;
    } catch {
      // The stored message was deleted or moved. Recreate it below.
    }
  }

  const message = await verify.send({ embeds: [buildVerifyEmbed()], components: buildVerifyComponents() });
  await upsertSetting(db, "message.verify.id", message.id);
}

async function ensureRulesMessage(guild: Guild, db: AkronDatabase): Promise<void> {
  const rules = guild.channels.cache.find(channel => channel.name === "rules" && channel.type === ChannelType.GuildText) as TextChannel | undefined;
  if (!rules) {
    return;
  }

  const setting = await db.query.botSettings.findFirst({ where: eq(botSettings.key, "message.rules.id") });
  if (setting) {
    try {
      const message = await rules.messages.fetch(setting.value);
      await message.edit({ embeds: [buildRulesEmbed()] });
      return;
    } catch {
      // The stored message was deleted or moved. Recreate it below.
    }
  }

  const message = await rules.send({ embeds: [buildRulesEmbed()] });
  await upsertSetting(db, "message.rules.id", message.id);
}

async function ensureSubmissionGuideMessage(guild: Guild, db: AkronDatabase): Promise<void> {
  const guide = guild.channels.cache.find(channel => channel.name === "submission-guide" && channel.type === ChannelType.GuildText) as TextChannel | undefined;
  if (!guide) {
    return;
  }

  const setting = await db.query.botSettings.findFirst({ where: eq(botSettings.key, "message.submission-guide.id") });
  if (setting) {
    try {
      const message = await guide.messages.fetch(setting.value);
      await message.edit({ embeds: [buildSubmissionGuideEmbed()] });
      return;
    } catch {
      // The stored message was deleted or moved. Recreate it below.
    }
  }

  const message = await guide.send({ embeds: [buildSubmissionGuideEmbed()] });
  await upsertSetting(db, "message.submission-guide.id", message.id);
}

async function upsertSetting(db: AkronDatabase, key: string, value: string): Promise<void> {
  await db
    .insert(botSettings)
    .values({ key, value, updatedUtc: utcNow() })
    .onConflictDoUpdate({
      target: botSettings.key,
      set: { value, updatedUtc: utcNow() }
    });
}

function describeChannelType(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildForum:
      return "forum";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildText:
      return "text";
    default:
      return `type-${type}`;
  }
}
