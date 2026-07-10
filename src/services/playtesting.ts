import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type ButtonInteraction,
  type ForumChannel,
  type Guild,
  type GuildMember,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type PublicThreadChannel,
  type Role,
  type TextChannel
} from "discord.js";
import type { AppConfig } from "../config.js";
import type { AkronDatabase } from "../db/database.js";
import {
  playtestActivity,
  playtestReleases,
  playtesterApplications,
  trackedPlaytesters
} from "../db/schema.js";
import { playtesterApplyButtonCustomId } from "../content.js";
import { isModerator } from "../permissions.js";
import { utcNow } from "../time.js";

const applicationModalCustomId = "akron:playtester:application";
const whyInputId = "why";
const contributionInputId = "contribution";
const availabilityInputId = "availability";
const acceptPrefix = "akron:playtester:accept:";
const denyPrefix = "akron:playtester:deny:";
const denyModalPrefix = "akron:playtester:deny-reason:";
const denialReasonInputId = "reason";
const denialCooldownMs = 14 * 24 * 60 * 60 * 1000;

export async function handlePlaytestingInteraction(input: {
  interaction: Interaction;
  config: AppConfig;
  db: AkronDatabase;
}): Promise<boolean> {
  const { interaction, config, db } = input;

  if (interaction.isButton() && interaction.customId === playtesterApplyButtonCustomId) {
    await handleApplyButton(interaction, db);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === applicationModalCustomId) {
    await handleApplicationModal(interaction, db);
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith(acceptPrefix)) {
    await handleAcceptButton(interaction, config, db, Number(interaction.customId.slice(acceptPrefix.length)));
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith(denyPrefix)) {
    await handleDenyButton(interaction, config, Number(interaction.customId.slice(denyPrefix.length)));
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(denyModalPrefix)) {
    await handleDenyModal(interaction, config, db, Number(interaction.customId.slice(denyModalPrefix.length)));
    return true;
  }

  return false;
}

export async function handlePlaytestingMessage(input: {
  message: Message;
  config: AppConfig;
  db: AkronDatabase;
}): Promise<void> {
  const { message, config, db } = input;
  if (!message.guild || message.author.bot) {
    return;
  }

  if (isPlaytestReleaseMessage(message)) {
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member || !isModerator(member, config)) {
      return;
    }
    await recordPlaytestRelease(message, db);
    return;
  }

  const activityKind = playtestActivityKind(message);
  if (!activityKind) {
    return;
  }

  const tracker = await db.query.trackedPlaytesters.findFirst({
    where: and(eq(trackedPlaytesters.userId, message.author.id), eq(trackedPlaytesters.active, 1))
  });
  if (!tracker) {
    return;
  }

  const currentRelease = await db.query.playtestReleases.findFirst({
    orderBy: desc(playtestReleases.id)
  });
  if (!currentRelease || Date.parse(message.createdAt.toISOString()) < Date.parse(currentRelease.createdUtc)) {
    return;
  }

  await incrementActivity(db, message.author.id, currentRelease.id, activityKind);
}

export function playtestWindowIsActive(activity: { forumCount: number; chatCount: number }): boolean {
  return activity.forumCount > 0 || activity.chatCount >= 3;
}

async function handleApplyButton(interaction: ButtonInteraction, db: AkronDatabase): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Apply from inside the Akron Discord server.", ephemeral: true });
    return;
  }

  const existingTracker = await db.query.trackedPlaytesters.findFirst({
    where: and(eq(trackedPlaytesters.userId, interaction.user.id), eq(trackedPlaytesters.active, 1))
  });
  if (existingTracker || await memberHasRoleNamed(interaction.member as GuildMember | null, "Tester")) {
    await interaction.reply({ content: "You are already a playtester.", ephemeral: true });
    return;
  }

  const openApplication = await db.query.playtesterApplications.findFirst({
    where: and(eq(playtesterApplications.userId, interaction.user.id), eq(playtesterApplications.status, "open"))
  });
  if (openApplication) {
    await interaction.reply({ content: "You already have an open playtester application.", ephemeral: true });
    return;
  }

  const latestDenied = await db.query.playtesterApplications.findFirst({
    where: and(eq(playtesterApplications.userId, interaction.user.id), eq(playtesterApplications.status, "denied")),
    orderBy: desc(playtesterApplications.id)
  });
  const deniedAt = latestDenied?.decidedUtc ? Date.parse(latestDenied.decidedUtc) : 0;
  if (deniedAt && Date.now() - deniedAt < denialCooldownMs) {
    const retryAt = new Date(deniedAt + denialCooldownMs).toISOString().slice(0, 10);
    await interaction.reply({ content: `You can reapply on ${retryAt}.`, ephemeral: true });
    return;
  }

  await interaction.showModal(buildApplicationModal());
}

async function handleApplicationModal(interaction: ModalSubmitInteraction, db: AkronDatabase): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "Apply from inside the Akron Discord server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const reviewForum = findForumChannel(interaction.guild, "playtester-applications", "Staff");
  if (!reviewForum) {
    await interaction.editReply("Staff application review channel is not configured yet.");
    return;
  }

  await recoverPlaytesterApplicationReview({
    db,
    userId: interaction.user.id,
    threadExists: async threadId => Boolean(await reviewForum.threads.fetch(threadId).catch(() => null)),
    findThreadId: async applicationId => {
      const active = await reviewForum.threads.fetchActive().catch(() => null);
      return active?.threads.find(thread => thread.name.startsWith(`Playtester application ${applicationId} -`))?.id;
    }
  });

  const openApplication = await db.query.playtesterApplications.findFirst({
    where: and(eq(playtesterApplications.userId, interaction.user.id), eq(playtesterApplications.status, "open"))
  });
  if (openApplication) {
    await interaction.editReply("You already have an open playtester application.");
    return;
  }

  let applicationId: number;
  try {
    applicationId = await createPlaytesterApplicationReview({
      db,
      application: {
        userId: interaction.user.id,
        username: interaction.user.tag,
        why: interaction.fields.getTextInputValue(whyInputId).trim(),
        contribution: interaction.fields.getTextInputValue(contributionInputId).trim(),
        availability: interaction.fields.getTextInputValue(availabilityInputId).trim()
      },
      createThread: async id => await reviewForum.threads.create({
        name: `Playtester application ${id} - ${interaction.user.username}`,
        message: {
          embeds: [buildApplicationEmbed(id, interaction)],
          components: [buildReviewButtons(id)]
        },
        appliedTags: tagId(reviewForum, "Open") ? [tagId(reviewForum, "Open") as string] : [],
        reason: "Akron playtester application"
      })
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      await interaction.editReply("You already have an open playtester application.");
      return;
    }
    throw error;
  }

  await interaction.editReply("Your playtester application was sent to staff.");
}

export async function createPlaytesterApplicationReview(input: {
  db: AkronDatabase;
  application: Pick<typeof playtesterApplications.$inferInsert, "userId" | "username" | "why" | "contribution" | "availability">;
  createThread: (applicationId: number) => Promise<{ id: string; delete(reason?: string): Promise<unknown> }>;
}): Promise<number> {
  const rows = await input.db.insert(playtesterApplications).values({
    ...input.application,
    status: "creating_thread",
    createdUtc: utcNow()
  }).returning({ id: playtesterApplications.id });
  const applicationId = rows[0]?.id;
  if (!applicationId) throw new Error("Playtester application insert did not return an id.");

  let thread: Awaited<ReturnType<typeof input.createThread>> | undefined;
  let threadIdPersisted = false;
  try {
    thread = await input.createThread(applicationId);
    await input.db.update(playtesterApplications)
      .set({ reviewThreadId: thread.id })
      .where(and(eq(playtesterApplications.id, applicationId), eq(playtesterApplications.status, "creating_thread")));
    threadIdPersisted = true;
    await input.db.update(playtesterApplications)
      .set({ status: "open" })
      .where(and(eq(playtesterApplications.id, applicationId), eq(playtesterApplications.status, "creating_thread")));
    return applicationId;
  } catch (error) {
    if (!threadIdPersisted) {
      if (thread) await thread.delete("Akron playtester application rollback").catch(() => undefined);
      await input.db.delete(playtesterApplications).where(eq(playtesterApplications.id, applicationId)).catch(() => undefined);
    }
    throw error;
  }
}

export async function recoverPlaytesterApplicationReview(input: {
  db: AkronDatabase;
  userId: string;
  threadExists: (threadId: string) => Promise<boolean>;
  findThreadId?: (applicationId: number) => Promise<string | undefined>;
}): Promise<"recovered" | "removed" | "none"> {
  const application = await input.db.query.playtesterApplications.findFirst({
    where: and(eq(playtesterApplications.userId, input.userId), eq(playtesterApplications.status, "creating_thread"))
  });
  if (!application) return "none";
  const reviewThreadId = application.reviewThreadId || await input.findThreadId?.(application.id) || "";
  if (reviewThreadId && await input.threadExists(reviewThreadId)) {
    await input.db.update(playtesterApplications).set({ status: "open", reviewThreadId })
      .where(and(eq(playtesterApplications.id, application.id), eq(playtesterApplications.status, "creating_thread")));
    return "recovered";
  }
  await input.db.delete(playtesterApplications)
    .where(and(eq(playtesterApplications.id, application.id), eq(playtesterApplications.status, "creating_thread")));
  return "removed";
}

async function handleAcceptButton(
  interaction: ButtonInteraction,
  config: AppConfig,
  db: AkronDatabase,
  applicationId: number
): Promise<void> {
  if (!await requireStaffButton(interaction, config)) {
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  let application = await db.query.playtesterApplications.findFirst({
    where: eq(playtesterApplications.id, applicationId)
  });
  if (application && await reconcileFinalApplicationDecision(application, interaction)) {
    await interaction.editReply("Application was already accepted. The review thread is now reconciled.");
    return;
  }
  if (application?.status === "accepting" && interaction.guild) {
    const role = await findRole(interaction.guild, "Tester");
    const applicant = await interaction.guild.members.fetch(application.userId).catch(() => null);
    if (role && applicant?.roles.cache.has(role.id)) {
      await persistAcceptedPlaytester(db, application, interaction.user.id, utcNow());
      await reconcileApplicationThread(interaction, "Accepted", `<@${application.userId}> was accepted and received Tester.`);
      await interaction.editReply("Recovered the prior acceptance and confirmed Tester tracking.");
      return;
    }
    await db.update(playtesterApplications).set({ status: "open", decidedBy: "" })
      .where(and(eq(playtesterApplications.id, application.id), eq(playtesterApplications.status, "accepting")));
    application = { ...application, status: "open", decidedBy: "" };
  }
  if (!application || application.status !== "open") {
    await interaction.editReply("This application is no longer open.");
    return;
  }

  const guild = interaction.guild;
  const testerRole = guild ? await findRole(guild, "Tester") : null;
  const member = guild ? await guild.members.fetch(application.userId).catch(() => null) : null;
  if (!guild || !testerRole || !member) {
    await interaction.editReply("Could not find the applicant or Tester role.");
    return;
  }

  const now = utcNow();
  const reserved = await db
    .update(playtesterApplications)
    .set({ status: "accepting", decidedBy: interaction.user.id })
    .where(and(eq(playtesterApplications.id, application.id), eq(playtesterApplications.status, "open")))
    .returning({ id: playtesterApplications.id });
  if (reserved.length !== 1) {
    await interaction.editReply("This application is no longer open.");
    return;
  }

  let roleAdded = false;
  try {
    await member.roles.add(testerRole, "Akron playtester application accepted");
    roleAdded = true;
    await persistAcceptedPlaytester(db, application, interaction.user.id, now);
  } catch (error) {
    let rollbackError: unknown;
    const refreshedMember = roleAdded
      ? member
      : await guild.members.fetch(application.userId).catch(() => null);
    const roleIsPresent = roleAdded || Boolean(refreshedMember?.roles.cache.has(testerRole.id));
    if (roleIsPresent && refreshedMember) {
      try {
        await refreshedMember.roles.remove(testerRole, "Akron playtester acceptance rollback");
      } catch (caught) {
        rollbackError = caught;
      }
    }
    if (rollbackError) {
      // A Tester role without its tracker would silently bypass inactivity
      // enforcement. If Discord rollback fails, make the granted role the
      // canonical result and surface the reconciliation failure to staff.
      await persistAcceptedPlaytester(db, application, interaction.user.id, now);
      throw new AggregateError([error, rollbackError], "Acceptance failed and role rollback failed; reconciled as accepted.");
    }
    await db.delete(trackedPlaytesters).where(and(
      eq(trackedPlaytesters.userId, application.userId),
      eq(trackedPlaytesters.acceptedApplicationId, application.id)
    ));
    await db
      .update(playtesterApplications)
      .set({ status: "open", decidedBy: "" })
      .where(and(eq(playtesterApplications.id, application.id), eq(playtesterApplications.status, "accepting")));
    throw error;
  }

  await reconcileApplicationThread(interaction, "Accepted", `<@${application.userId}> was accepted and received Tester.`);
  await interaction.editReply("Application accepted and Tester role granted.");
}

async function persistAcceptedPlaytester(
  db: AkronDatabase,
  application: typeof playtesterApplications.$inferSelect,
  decidedBy: string,
  acceptedUtc: string
): Promise<void> {
  await db.insert(trackedPlaytesters).values({
    userId: application.userId,
    acceptedApplicationId: application.id,
    acceptedUtc,
    missedReleases: 0,
    active: 1
  }).onConflictDoUpdate({
    target: trackedPlaytesters.userId,
    set: { acceptedApplicationId: application.id, acceptedUtc, missedReleases: 0, active: 1 }
  });
  await db.update(playtesterApplications)
    .set({ status: "accepted", decidedUtc: acceptedUtc, decidedBy })
    .where(eq(playtesterApplications.id, application.id));
}

async function handleDenyButton(interaction: ButtonInteraction, config: AppConfig, applicationId: number): Promise<void> {
  if (!await requireStaffButton(interaction, config)) {
    return;
  }
  await interaction.showModal(buildDenyModal(applicationId));
}

async function handleDenyModal(
  interaction: ModalSubmitInteraction,
  config: AppConfig,
  db: AkronDatabase,
  applicationId: number
): Promise<void> {
  if (!await requireStaffModal(interaction, config)) {
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const application = await db.query.playtesterApplications.findFirst({
    where: eq(playtesterApplications.id, applicationId)
  });
  if (application && await reconcileFinalApplicationDecision(application, interaction)) {
    await interaction.editReply("Application was already denied. The review thread is now reconciled.");
    return;
  }
  if (application?.status === "denying") {
    await db.update(playtesterApplications).set({ status: "denied", decidedUtc: utcNow() })
      .where(and(eq(playtesterApplications.id, application.id), eq(playtesterApplications.status, "denying")));
    await reconcileApplicationThread(interaction, "Denied", `<@${application.userId}> was denied by <@${application.decidedBy}>.\nReason: ${application.denialReason}`);
    await interaction.editReply("Recovered the prior denial decision.");
    return;
  }
  if (!application || application.status !== "open") {
    await interaction.editReply("This application is no longer open.");
    return;
  }

  const reason = interaction.fields.getTextInputValue(denialReasonInputId).trim();
  const now = utcNow();
  const reserved = await db
    .update(playtesterApplications)
    .set({
      status: "denying",
      denialReason: reason,
      decidedBy: interaction.user.id
    })
    .where(and(eq(playtesterApplications.id, application.id), eq(playtesterApplications.status, "open")))
    .returning({ id: playtesterApplications.id });
  if (reserved.length !== 1) {
    await interaction.editReply("This application is no longer open.");
    return;
  }

  await db
    .update(playtesterApplications)
    .set({ status: "denied", decidedUtc: now })
    .where(and(eq(playtesterApplications.id, application.id), eq(playtesterApplications.status, "denying")));

  const applicant = await interaction.client.users.fetch(application.userId).catch(() => null);
  const dmDelivered = await applicant?.send([
    "Your Akron playtester application was denied.",
    "",
    `Reason: ${reason}`,
    "",
    "You can reapply after 14 days."
  ].join("\n")).then(() => true).catch(() => false) ?? false;

  await reconcileApplicationThread(
    interaction,
    "Denied",
    `<@${application.userId}> was denied by <@${interaction.user.id}>.\nDM delivery: ${dmDelivered ? "sent" : "failed"}.\nReason: ${reason}`
  );
  await interaction.editReply(dmDelivered
    ? "Application denied and the applicant was DM'd."
    : "Application denied, but the applicant could not be DM'd.");
}

async function recordPlaytestRelease(message: Message, db: AkronDatabase): Promise<void> {
  const existing = await db.query.playtestReleases.findFirst({
    where: eq(playtestReleases.messageId, message.id)
  });
  if (existing) {
    return;
  }

  const attachment = Array.from(message.attachments.values()).find(candidate =>
    candidate.name?.toLowerCase().endsWith(".zip")
  );
  if (!attachment) {
    return;
  }

  const inserted = await db
    .insert(playtestReleases)
    .values({
      messageId: message.id,
      channelId: message.channelId,
      attachmentName: attachment.name ?? "playtest.zip",
      createdUtc: message.createdAt.toISOString()
    })
    .returning({ id: playtestReleases.id });
  const releaseId = inserted[0]?.id;
  if (!releaseId) {
    return;
  }

  const previousRelease = await db.query.playtestReleases.findFirst({
    where: lt(playtestReleases.id, releaseId),
    orderBy: desc(playtestReleases.id)
  });
  if (previousRelease && message.guild) {
    await evaluateReleaseWindow(message.guild, db, previousRelease);
  }
}

async function evaluateReleaseWindow(
  guild: Guild,
  db: AkronDatabase,
  release: typeof playtestReleases.$inferSelect
): Promise<void> {
  const testers = await db.query.trackedPlaytesters.findMany({
    where: eq(trackedPlaytesters.active, 1)
  });
  for (const tester of testers) {
    if (Date.parse(tester.acceptedUtc) > Date.parse(release.createdUtc)) {
      continue;
    }

    const activity = await activityForRelease(db, tester.userId, release.id);
    if (playtestWindowIsActive(activity)) {
      await db
        .update(trackedPlaytesters)
        .set({ missedReleases: 0 })
        .where(eq(trackedPlaytesters.userId, tester.userId));
      continue;
    }

    const nextMissed = tester.missedReleases + 1;
    const member = await guild.members.fetch(tester.userId).catch(() => null);
    if (member && await memberHasRoleNamed(member, "Beta")) {
      await db
        .update(trackedPlaytesters)
        .set({ missedReleases: 0 })
        .where(eq(trackedPlaytesters.userId, tester.userId));
      continue;
    }

    if (nextMissed >= 3 && member) {
      const testerRole = await findRole(guild, "Tester");
      if (testerRole && member.roles.cache.has(testerRole.id)) {
        await member.roles.remove(testerRole, "Akron playtester inactivity");
      }
      await db
        .update(trackedPlaytesters)
        .set({ missedReleases: nextMissed, active: 0 })
        .where(eq(trackedPlaytesters.userId, tester.userId));
      await logInactiveRemoval(guild, tester.userId, release, nextMissed);
      continue;
    }

    await db
      .update(trackedPlaytesters)
      .set({ missedReleases: nextMissed })
      .where(eq(trackedPlaytesters.userId, tester.userId));
  }
}

async function activityForRelease(db: AkronDatabase, userId: string, releaseId: number): Promise<{ forumCount: number; chatCount: number }> {
  const rows = await db.query.playtestActivity.findMany({
    where: and(eq(playtestActivity.userId, userId), eq(playtestActivity.releaseId, releaseId))
  });
  return {
    forumCount: rows.filter(row => row.kind === "forum").reduce((sum, row) => sum + row.count, 0),
    chatCount: rows.filter(row => row.kind === "chat").reduce((sum, row) => sum + row.count, 0)
  };
}

async function incrementActivity(db: AkronDatabase, userId: string, releaseId: number, kind: "chat" | "forum"): Promise<void> {
  await db
    .insert(playtestActivity)
    .values({ userId, releaseId, kind, count: 1, updatedUtc: utcNow() })
    .onConflictDoUpdate({
      target: [playtestActivity.userId, playtestActivity.releaseId, playtestActivity.kind],
      set: {
        count: sql`${playtestActivity.count} + 1`,
        updatedUtc: utcNow()
      }
    });
}

function buildApplicationModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(applicationModalCustomId)
    .setTitle("Playtester Application")
    .addComponents(
      textInputRow("Why do you want to be a playtester?", whyInputId),
      textInputRow("What feedback can you contribute?", contributionInputId),
      textInputRow("How often can you test new builds?", availabilityInputId)
    );
}

function buildDenyModal(applicationId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${denyModalPrefix}${applicationId}`)
    .setTitle("Deny Playtester Application")
    .addComponents(
      textInputRow("Reason to send to the applicant", denialReasonInputId)
    );
}

function textInputRow(label: string, customId: string): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(20)
      .setMaxLength(1000)
      .setRequired(true)
  );
}

function buildApplicationEmbed(applicationId: number, interaction: ModalSubmitInteraction): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Playtester Application #${applicationId}`)
    .setColor(0xff66c4)
    .setDescription(`Applicant: <@${interaction.user.id}> (${interaction.user.tag})`)
    .addFields(
      { name: "Why", value: safeField(interaction.fields.getTextInputValue(whyInputId)) },
      { name: "Contribution", value: safeField(interaction.fields.getTextInputValue(contributionInputId)) },
      { name: "Availability", value: safeField(interaction.fields.getTextInputValue(availabilityInputId)) }
    )
    .setTimestamp(new Date());
}

function buildReviewButtons(applicationId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${acceptPrefix}${applicationId}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${denyPrefix}${applicationId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
  );
}

export async function reconcileApplicationThread(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  tagName: "Accepted" | "Denied",
  message: string
): Promise<void> {
  const thread = interaction.channel?.isThread() ? interaction.channel as PublicThreadChannel : null;
  if (!thread) {
    return;
  }

  await thread.send(message);
  const parent = thread.parent;
  if (parent?.type === ChannelType.GuildForum) {
    const targetTagId = tagId(parent, tagName);
    const openTagId = tagId(parent, "Open");
    const next = thread.appliedTags.filter(id => id !== openTagId);
    if (targetTagId && !next.includes(targetTagId)) {
      next.push(targetTagId);
    }
    await thread.setAppliedTags(next, "Akron playtester application reviewed");
  }
  await thread.setArchived(true, "Akron playtester application reviewed");
}

export async function reconcileFinalApplicationDecision(
  application: Pick<typeof playtesterApplications.$inferSelect, "status" | "userId" | "decidedBy" | "denialReason">,
  interaction: ButtonInteraction | ModalSubmitInteraction
): Promise<boolean> {
  if (application.status === "accepted") {
    await reconcileApplicationThread(
      interaction,
      "Accepted",
      `<@${application.userId}> was accepted and received Tester.`
    );
    return true;
  }
  if (application.status === "denied") {
    await reconcileApplicationThread(
      interaction,
      "Denied",
      `<@${application.userId}> was denied by <@${application.decidedBy}>.\nReason: ${application.denialReason}`
    );
    return true;
  }
  return false;
}

async function requireStaffButton(interaction: ButtonInteraction, config: AppConfig): Promise<boolean> {
  if (interaction.member instanceof Object && "roles" in interaction.member && isModerator(interaction.member as GuildMember, config)) {
    return true;
  }
  await interaction.reply({ content: "Moderator role required.", ephemeral: true });
  return false;
}

async function requireStaffModal(interaction: ModalSubmitInteraction, config: AppConfig): Promise<boolean> {
  if (interaction.member instanceof Object && "roles" in interaction.member && isModerator(interaction.member as GuildMember, config)) {
    return true;
  }
  await interaction.reply({ content: "Moderator role required.", ephemeral: true });
  return false;
}

function isPlaytestReleaseMessage(message: Message): boolean {
  return message.channel.type === ChannelType.GuildText &&
    message.channel.name === "announcements" &&
    message.channel.parent?.name === "playtesters" &&
    message.attachments.some(attachment => attachment.name?.toLowerCase().endsWith(".zip"));
}

function playtestActivityKind(message: Message): "chat" | "forum" | null {
  if (message.channel.type === ChannelType.GuildText &&
    message.channel.name === "chat" &&
    message.channel.parent?.name === "playtesters") {
    return "chat";
  }

  if (message.channel.isThread()) {
    const thread = message.channel as AnyThreadChannel;
    const parent = thread.parent;
    if (parent?.type === ChannelType.GuildForum &&
      ["tester-feedback", "tester-bugs-n-issues"].includes(parent.name)) {
      return "forum";
    }
  }

  return null;
}

async function logInactiveRemoval(
  guild: Guild,
  userId: string,
  release: typeof playtestReleases.$inferSelect,
  missedReleases: number
): Promise<void> {
  const staffChat = findTextChannel(guild, "staff-chat", "Staff");
  if (!staffChat) {
    return;
  }

  await staffChat.send([
    `<@${userId}> lost Tester for missing ${missedReleases} consecutive playtest releases.`,
    `Latest evaluated release: https://discord.com/channels/${guild.id}/${release.channelId}/${release.messageId}`,
    `Attachment: ${release.attachmentName}`
  ].join("\n"));
}

function findForumChannel(guild: Guild, name: string, parentName?: string): ForumChannel | undefined {
  return guild.channels.cache.find(channel =>
    channel.name === name &&
    channel.type === ChannelType.GuildForum &&
    (!parentName || channel.parent?.name === parentName)
  ) as ForumChannel | undefined;
}

function findTextChannel(guild: Guild, name: string, parentName?: string): TextChannel | undefined {
  return guild.channels.cache.find(channel =>
    channel.name === name &&
    channel.type === ChannelType.GuildText &&
    (!parentName || channel.parent?.name === parentName)
  ) as TextChannel | undefined;
}

async function findRole(guild: Guild, name: string): Promise<Role | null> {
  await guild.roles.fetch();
  return guild.roles.cache.find(role => role.name === name) ?? null;
}

async function memberHasRoleNamed(member: GuildMember | null, name: string): Promise<boolean> {
  if (!member) {
    return false;
  }
  return member.roles.cache.some(role => role.name === name);
}

function isUniqueConstraintError(error: unknown): boolean {
  return /constraint|unique/i.test(error instanceof Error ? error.message : String(error));
}

function tagId(forum: ForumChannel, name: string): string | undefined {
  return forum.availableTags.find(tag => tag.name === name)?.id;
}

function safeField(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1000 ? `${trimmed.slice(0, 997)}...` : trimmed;
}
