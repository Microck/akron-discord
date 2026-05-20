import { eq } from "drizzle-orm";
import {
  AttachmentBuilder,
  ChannelType,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
  type GuildForumTagData,
  type PublicThreadChannel,
  type OverwriteResolvable,
  OverwriteType,
  PermissionsBitField,
  type TextChannel
} from "discord.js";
import { botSettings } from "./db/schema.js";
import type { AkronDatabase } from "./db/database.js";
import { categorySpecs, channelSpecs, roleSpecs, submissionChannelScopes, type ChannelSpec } from "./server-spec.js";
import {
  buildFaqEmbed,
  buildForumExampleSpecs,
  buildRulesEmbed,
  buildSubmissionGuideEmbed,
  buildVerifyComponents,
  buildVerifyEmbed,
  buildWelcomeEmbed,
  feedbackForumGuidelines,
  forumGuidelines
} from "./content.js";
import type { AppConfig } from "./config.js";
import { embedAssets, embedAssetAttachment, type EmbedAssetName } from "./embed-assets.js";
import { utcNow } from "./time.js";

export type ServerSyncPlan = {
  changes: string[];
};

export async function planServerSync(guild: Guild, config?: AppConfig): Promise<ServerSyncPlan> {
  await guild.roles.fetch();
  await guild.channels.fetch();
  const changes: string[] = [];
  const roles = new Map<string, string>();
  for (const role of roleSpecs) {
    const existing = guild.roles.cache.find(candidate => candidate.name === role.name);
    if (!existing) {
      changes.push(`create role ${role.name}`);
    } else {
      roles.set(role.key, existing.id);
      if (existing.color !== role.color) {
        changes.push(`update color for role ${role.name}`);
      }
    }
  }

  for (const category of categorySpecs) {
    if (!guild.channels.cache.find(channel => channel.type === ChannelType.GuildCategory && channel.name === category.name)) {
      changes.push(`create category ${category.name}`);
    }
  }

  for (const channel of channelSpecs) {
    const existing = findAccessibleNamedChannel(guild, channel.name);
    if (!existing) {
      changes.push(`create ${describeChannelType(channel.type)} channel ${channel.name}`);
      continue;
    }

    if (existing.type !== channel.type) {
      changes.push(`replace ${channel.name} type ${describeChannelType(existing.type)} -> ${describeChannelType(channel.type)}`);
      continue;
    }

    const expectedParentName = channel.category
      ? categorySpecs.find(category => category.key === channel.category)?.name
      : null;
    if (existing.parent?.name !== expectedParentName) {
      changes.push(`move ${channel.name} to ${expectedParentName ?? "top level"}`);
    }

    const topic = buildChannelTopic(channel, config);
    if ("topic" in existing && topic && existing.topic !== topic) {
      changes.push(`update topic for ${channel.name}`);
    }

    if (existing.type === ChannelType.GuildForum && !forumTagsMatch(existing.availableTags.map(tag => tag.name), channel.forumTags ?? [])) {
      changes.push(`update forum tags for ${channel.name}`);
    }

    if (roles.size === roleSpecs.length && "permissionOverwrites" in existing) {
      const expected = buildPermissionOverwrites(guild.id, roles, channel, guild.client.user.id);
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

export async function applyServerSync(guild: Guild, db: AkronDatabase, config?: AppConfig): Promise<ServerSyncPlan> {
  await guild.roles.fetch();
  await guild.channels.fetch();
  const changes: string[] = [];
  const roles = new Map<string, string>();
  for (const role of roleSpecs) {
    const existing = guild.roles.cache.find(candidate => candidate.name === role.name);
    const resolved = existing ?? await guild.roles.create({ name: role.name, colors: { primaryColor: role.color }, reason: "Akron server sync" });
    roles.set(role.key, resolved.id);
    if (!existing) {
      changes.push(`created role ${role.name}`);
    } else if (existing.color !== role.color) {
      try {
        await existing.setColors({ primaryColor: role.color }, "Akron server sync");
        changes.push(`updated role color ${role.name}`);
      } catch (error) {
        changes.push(`skipped role color ${role.name}: ${formatDiscordSyncError(error)}`);
      }
    }
  }

  await configureBotRoleColor(guild, changes);

  for (const [key, id] of roles) {
    await upsertSetting(db, `role.${key}.id`, id);
  }
  await assignBotRole(guild, roles, changes);

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
    const hasInaccessibleSameType = guild.channels.cache.some(channel =>
      channel.name === channelSpec.name &&
      channel.type === channelSpec.type &&
      !isChannelAccessible(channel)
    );
    const existing = findAccessibleNamedChannel(guild, channelSpec.name);
    if (existing && existing.type !== channelSpec.type) {
      changes.push(`skipped ${channelSpec.name}: existing channel has incompatible type`);
      continue;
    }

    const parent = channelSpec.category ? categories.get(channelSpec.category) : undefined;
    const permissionOverwrites = buildPermissionOverwrites(guild.id, roles, channelSpec, guild.client.user.id);
    const channel = existing ?? await guild.channels.create({
      name: channelSpec.name,
      type: channelSpec.type,
      parent,
      topic: buildChannelTopic(channelSpec, config),
      availableTags: buildForumTags(channelSpec),
      reason: "Akron server sync",
      permissionOverwrites
    });

    if (!existing) {
      changes.push(hasInaccessibleSameType
        ? `created channel ${channelSpec.name} because an existing channel is inaccessible`
        : `created channel ${channelSpec.name}`);
    }

    try {
      await configureExistingChannel(channel, channelSpec, parent, permissionOverwrites, config);
    } catch (error) {
      changes.push(`skipped ${channelSpec.name}: ${formatDiscordSyncError(error)}`);
    }
  }

  await runContentSync(changes, "verify", () => ensureVerifyMessage(guild, db));
  await runContentSync(changes, "rules", () => ensureRulesMessage(guild, db));
  await runContentSync(changes, "welcome", () => ensureWelcomeMessage(guild, db));
  await runContentSync(changes, "faq", () => ensureFaqMessage(guild, db, config));
  await runContentSync(changes, "links", () => removeStoredMessage(guild, db, "links", "message.links.id"));
  await runContentSync(changes, "announcements", () => removeStoredMessage(guild, db, "announcements", "message.announcements.id"));
  await runContentSync(changes, "submission-guide", () => ensureSubmissionGuideMessage(guild, db, config));
  await runContentSync(changes, "forum examples", () => ensureForumExampleThreads(guild, db));

  if (changes.length === 0) {
    changes.push("no structural changes needed");
  }

  return { changes };
}

async function configureExistingChannel(
  channel: GuildBasedChannel,
  spec: ChannelSpec,
  parent: string | undefined,
  permissionOverwrites: OverwriteResolvable[],
  config?: AppConfig
): Promise<void> {
  if ("setParent" in channel && channel.parentId !== (parent ?? null)) {
    await channel.setParent(parent ?? null, { lockPermissions: false, reason: "Akron server sync" });
  }

  if (spec.name === "verify" && "setPosition" in channel && channel.position !== 0) {
    await channel.setPosition(0, { reason: "Akron server sync" });
  }

  const topic = buildChannelTopic(spec, config);
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

export function buildPermissionOverwrites(guildId: string, roles: Map<string, string>, spec: ChannelSpec, botUserId = ""): OverwriteResolvable[] {
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
  const botAllow = botUserId
    ? [{
        id: botUserId,
        type: OverwriteType.Member,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.SendMessagesInThreads,
          PermissionsBitField.Flags.CreatePublicThreads,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ManageThreads,
          PermissionsBitField.Flags.AttachFiles,
          PermissionsBitField.Flags.EmbedLinks
        ]
      }]
    : [];

  if (spec.name === "verify" || spec.name === "rules") {
    return [
      {
        id: guildId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
        deny: [PermissionsBitField.Flags.SendMessages]
      },
      memberReadAllow,
      moderatorAllow,
      adminAllow,
      ...botAllow
    ];
  }

  if (spec.visibility === "public") {
    return [memberPostAllow, moderatorAllow, adminAllow, ...botAllow];
  }

  if (spec.category === "info") {
    return [everyoneDeny, memberReadAllow, moderatorAllow, adminAllow, ...botAllow];
  }

  if (spec.visibility === "member") {
    return [everyoneDeny, memberPostAllow, moderatorAllow, adminAllow, ...botAllow];
  }

  if (spec.visibility === "staff") {
    return [everyoneDeny, moderatorAllow, adminAllow, ...botAllow];
  }

  return [everyoneDeny, adminAllow, ...botAllow];
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

function buildChannelTopic(spec: ChannelSpec, config?: AppConfig): string | undefined {
  if (spec.type === ChannelType.GuildForum && submissionChannelScopes.has(spec.name)) {
    return forumGuidelines(submissionChannelScopes.get(spec.name) ?? "Akron");
  }

  if (spec.name === "issues") {
    return feedbackForumGuidelines("issue", config);
  }

  if (spec.name === "suggestions") {
    return feedbackForumGuidelines("suggestion", config);
  }

  if (spec.name === "questions") {
    return feedbackForumGuidelines("question", config);
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
  const verify = findAccessibleTextChannel(guild, "verify");
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
  const rules = findAccessibleTextChannel(guild, "rules");
  if (!rules) {
    return;
  }

  const setting = await db.query.botSettings.findFirst({ where: eq(botSettings.key, "message.rules.id") });
  if (setting) {
    try {
      const message = await rules.messages.fetch(setting.value);
      await message.edit(embedEditOptions(buildRulesEmbed(), embedAssets.akronPillar));
      return;
    } catch {
      // The stored message was deleted or moved. Recreate it below.
    }
  }

  const message = await rules.send(embedCreateOptions(buildRulesEmbed(), embedAssets.akronPillar));
  await upsertSetting(db, "message.rules.id", message.id);
}

async function ensureSubmissionGuideMessage(guild: Guild, db: AkronDatabase, config?: AppConfig): Promise<void> {
  const guide = findAccessibleTextChannel(guild, "submission-guide");
  if (!guide) {
    return;
  }

  const setting = await db.query.botSettings.findFirst({ where: eq(botSettings.key, "message.submission-guide.id") });
  if (setting) {
    try {
      const message = await guide.messages.fetch(setting.value);
      await message.edit(embedEditOptions(buildSubmissionGuideEmbed(config), embedAssets.akronDash));
      return;
    } catch {
      // The stored message was deleted or moved. Recreate it below.
    }
  }

  const message = await guide.send(embedCreateOptions(buildSubmissionGuideEmbed(config), embedAssets.akronDash));
  await upsertSetting(db, "message.submission-guide.id", message.id);
}

async function ensureWelcomeMessage(guild: Guild, db: AkronDatabase): Promise<void> {
  const channel = findAccessibleTextChannel(guild, "welcome");
  if (!channel) {
    return;
  }
  await ensureStoredEmbedMessage(db, channel, "message.welcome.id", buildWelcomeEmbed());
}

async function ensureFaqMessage(guild: Guild, db: AkronDatabase, config?: AppConfig): Promise<void> {
  const channel = findAccessibleTextChannel(guild, "faq");
  if (!channel) {
    return;
  }
  await ensureStoredEmbedMessage(db, channel, "message.faq.id", buildFaqEmbed(config));
}

async function ensureStoredEmbedMessage(db: AkronDatabase, channel: TextChannel, settingKey: string, embed: ReturnType<typeof buildRulesEmbed>): Promise<void> {
  const setting = await db.query.botSettings.findFirst({ where: eq(botSettings.key, settingKey) });
  if (setting) {
    try {
      const message = await channel.messages.fetch(setting.value);
      await message.edit({ embeds: [embed] });
      return;
    } catch {
      // The stored message was deleted or moved. Recreate it below.
    }
  }

  const message = await channel.send({ embeds: [embed] });
  await upsertSetting(db, settingKey, message.id);
}

function embedCreateOptions(embed: ReturnType<typeof buildRulesEmbed>, asset?: EmbedAssetName) {
  return asset
    ? { embeds: [embed], files: [embedAssetAttachment(asset)] }
    : { embeds: [embed] };
}

function embedEditOptions(embed: ReturnType<typeof buildRulesEmbed>, asset?: EmbedAssetName) {
  return asset
    ? { embeds: [embed], files: [embedAssetAttachment(asset)], attachments: [] }
    : { embeds: [embed] };
}

async function removeStoredMessage(guild: Guild, db: AkronDatabase, channelName: string, settingKey: string): Promise<void> {
  const setting = await db.query.botSettings.findFirst({ where: eq(botSettings.key, settingKey) });
  if (!setting) {
    return;
  }

  const channel = findAccessibleTextChannel(guild, channelName);
  if (channel) {
    try {
      const message = await channel.messages.fetch(setting.value);
      await message.delete();
    } catch {
      // The message may already be gone, or it may be in an inaccessible stale channel.
    }
  }

  await db.delete(botSettings).where(eq(botSettings.key, settingKey));
}

async function ensureForumExampleThreads(guild: Guild, db: AkronDatabase): Promise<void> {
  for (const spec of buildForumExampleSpecs()) {
    const forum = findAccessibleForumChannel(guild, spec.channelName);
    if (!forum) {
      continue;
    }

    const message = await buildForumExampleMessage(spec);
    const setting = await db.query.botSettings.findFirst({ where: eq(botSettings.key, spec.settingKey) });
    if (setting) {
      const existing = await fetchStoredExampleThread(guild, forum.id, setting.value);
      if (existing) {
        await existing.setName(spec.threadTitle, "Akron server sync");
        const starter = await existing.fetchStarterMessage();
        if (starter) {
          await starter.edit({ ...message, attachments: [], embeds: [] });
          await starter.suppressEmbeds(true);
        }
        await cleanExampleThread(existing);
        continue;
      }
    }

    const thread = await forum.threads.create({
      name: spec.threadTitle,
      message,
      reason: "Akron server sync"
    });
    await cleanExampleThread(thread);
    await upsertSetting(db, spec.settingKey, thread.id);
  }
}

async function buildForumExampleMessage(spec: ReturnType<typeof buildForumExampleSpecs>[number]) {
  const files = [];
  if (spec.akrFileName) {
    files.push(new AttachmentBuilder(buildExampleAkrBytes(spec), { name: spec.akrFileName }));
  }
  if (spec.includeCapture) {
    files.push(new AttachmentBuilder(await buildPlaceholderCaptureBytes(), { name: "akron-map-capture-placeholder.jpg" }));
  }
  return { content: spec.content, files };
}

function buildExampleAkrBytes(spec: ReturnType<typeof buildForumExampleSpecs>[number]): Buffer {
  const manifest = {
    kind: "profile",
    format: "akr-v1",
    section: spec.akrSection,
    name: spec.threadTitle.replace(/^Example: /, ""),
    target: {
      mapSid: "Glyph/Glyph",
      displayName: "Glyph"
    },
    exportedBy: "Akron Discord",
    notes: "Example forum attachment generated by the Akron Discord bot."
  };
  const profile = {
    format: "akr-v1",
    section: spec.akrSection,
    name: spec.threadTitle.replace(/^Example: /, ""),
    target: {
      mapSid: "Glyph/Glyph",
      displayName: "Glyph"
    },
    data: exampleProfileData(spec.akrSection)
  };

  return buildStoredZip([
    { name: "manifest.json", content: JSON.stringify(manifest, null, 2) + "\n" },
    { name: "profile.json", content: JSON.stringify(profile, null, 2) + "\n" }
  ]);
}

function exampleProfileData(section: string): unknown {
  if (section === "StartPos") {
    return {
      startPositions: [
        { room: "glyph/a-00", label: "Opening room", x: 48, y: 128 },
        { room: "glyph/a-03", label: "Dream block practice", x: 176, y: 96 }
      ]
    };
  }
  if (section === "AutoKill") {
    return {
      zones: [
        { room: "glyph/a-04", label: "Retry pit", x: 112, y: 144, width: 64, height: 24 }
      ]
    };
  }
  if (section === "AutoDeafen") {
    return {
      zones: [
        { room: "glyph/a-06", label: "Focus room", x: 32, y: 48, width: 160, height: 120 }
      ]
    };
  }
  if (section === "Keybinds") {
    return {
      bindings: [
        { action: "quick_restart", key: "R" },
        { action: "capture_room", key: "F8" }
      ]
    };
  }
  if (section === "Hud") {
    return {
      widgets: [
        { id: "timer", x: 16, y: 16, visible: true },
        { id: "room_name", x: 16, y: 44, visible: true }
      ]
    };
  }
  if (section === "Audio") {
    return {
      masterVolume: 0.8,
      musicVolume: 0.65,
      sfxVolume: 0.9
    };
  }
  return {
    recorder: {
      preset: "1080p60",
      includeHud: true,
      clipBufferSeconds: 30
    }
  };
}

function buildStoredZip(files: { name: string; content: string }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name);
    const content = Buffer.from(file.content);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function buildPlaceholderCaptureBytes(): Promise<Buffer> {
  const response = await fetch("https://files.catbox.moe/3fq1l4.jpg")
    .catch(() => null);
  if (response?.ok) {
    return Buffer.from(await response.arrayBuffer());
  }

  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAASwAAACWCAIAAADrOSKFAAABfklEQVR4nO3UMQ0AIBDAMMC/5+ONAvZoFSzZnZkZuAvwWwIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAQeAgcBA4CBwEDgIHgYPAAW7aAqFRf0gTAAAAAElFTkSuQmCC",
    "base64"
  );
}

async function cleanExampleThread(thread: PublicThreadChannel): Promise<void> {
  if (thread.archived) {
    await thread.setArchived(false, "Akron server sync");
  }

  const starter = await thread.fetchStarterMessage();
  if (starter) {
    await starter.suppressEmbeds(true);
  }

  if (typeof thread.setAppliedTags === "function" && thread.appliedTags.length > 0) {
    await thread.setAppliedTags([], "Akron server sync");
  }

  const messages = await thread.messages.fetch({ limit: 20 });
  for (const message of messages.values()) {
    const isBotCleanupMessage = message.author.id === thread.client.user.id &&
      message.id !== thread.id &&
      message.embeds.some(embed => embed.title?.startsWith("Akron Scan") || embed.title === "GitHub Sync");
    if (isBotCleanupMessage) {
      await message.delete();
    }
  }

  const maybePinned = thread as PublicThreadChannel & { pinned?: boolean };
  if (maybePinned.pinned !== true) {
    await thread.pin("Akron server sync");
  }
  if (!thread.locked) {
    await thread.setLocked(true, "Akron server sync");
  }
}

async function fetchStoredExampleThread(guild: Guild, parentId: string, threadId: string): Promise<PublicThreadChannel | undefined> {
  const channel = await guild.client.channels.fetch(threadId).catch(() => null);
  if (!channel?.isThread() || channel.parentId !== parentId || channel.type !== ChannelType.PublicThread) {
    return undefined;
  }
  return channel;
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
    case ChannelType.GuildText:
      return "text";
    default:
      return `type-${type}`;
  }
}

function findAccessibleNamedChannel(guild: Guild, name: string): GuildBasedChannel | undefined {
  return guild.channels.cache.find(channel => channel.name === name && isChannelAccessible(channel));
}

function findAccessibleTextChannel(guild: Guild, name: string): TextChannel | undefined {
  return guild.channels.cache.find(channel =>
    channel.name === name &&
    channel.type === ChannelType.GuildText &&
    isChannelAccessible(channel)
  ) as TextChannel | undefined;
}

function findAccessibleForumChannel(guild: Guild, name: string): ForumChannel | undefined {
  return guild.channels.cache.find(channel =>
    channel.name === name &&
    channel.type === ChannelType.GuildForum &&
    isChannelAccessible(channel)
  ) as ForumChannel | undefined;
}

function isChannelAccessible(channel: GuildBasedChannel): boolean {
  return !("viewable" in channel) || channel.viewable;
}

async function assignBotRole(guild: Guild, roles: Map<string, string>, changes: string[]): Promise<void> {
  const botRoleId = roles.get("bot");
  if (!botRoleId) {
    return;
  }

  const member = await guild.members.fetchMe();
  if (member.roles.cache.has(botRoleId)) {
    return;
  }

  try {
    await member.roles.add(botRoleId, "Akron server sync");
    changes.push("assigned Bot role to Akron bot");
  } catch (error) {
    changes.push(`skipped Bot role assignment: ${formatDiscordSyncError(error)}`);
  }
}

async function configureBotRoleColor(guild: Guild, changes: string[]): Promise<void> {
  const member = await guild.members.fetchMe();
  const botRole = member.roles.cache.find(role => role.managed && role.tags?.botId === guild.client.user.id);
  if (!botRole || botRole.color === 0xfee75c) {
    return;
  }

  try {
    await botRole.setColors({ primaryColor: 0xfee75c }, "Akron server sync");
    changes.push("updated role color Akron bot");
  } catch (error) {
    changes.push(`skipped role color Akron bot: ${formatDiscordSyncError(error)}`);
  }
}

async function runContentSync(changes: string[], label: string, sync: () => Promise<void>): Promise<void> {
  try {
    await sync();
  } catch (error) {
    changes.push(`skipped ${label} content: ${formatDiscordSyncError(error)}`);
  }
}

function formatDiscordSyncError(error: unknown): string {
  const code = (error as { code?: number | string }).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 50001) {
    return "bot is missing channel access";
  }
  if (code === 50013) {
    return "bot is missing permissions or role hierarchy";
  }
  return message;
}
