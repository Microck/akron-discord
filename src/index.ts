import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type AnyThreadChannel,
  type GuildMember,
  type Message,
  type PartialMessage,
  type TextChannel
} from "discord.js";
import { eq } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { handleCommand } from "./commands.js";
import { buildVerifyComponents, buildVerifyEmbed, verifyButtonCustomId } from "./content.js";
import { createDatabase } from "./db/database.js";
import { scanStates, verificationLogs } from "./db/schema.js";
import { syncGithubForumThread } from "./github-forums.js";
import { startGithubWebhookServer } from "./github-webhook.js";
import { handlePlaytestingInteraction, handlePlaytestingMessage } from "./services/playtesting.js";
import { handleUploadModerationInteraction, pollUploadModerationQueue } from "./services/upload-moderation.js";
import { handleScanButtonInteraction, scanSubmissionThread } from "./submissions/scanner.js";
import { utcNow } from "./time.js";

const config = loadConfig();
const database = createDatabase(config.databasePath);
const scanTimers = new Map<string, NodeJS.Timeout>();
let uploadModerationTimer: NodeJS.Timeout | null = null;
let githubWebhookServer: ReturnType<typeof startGithubWebhookServer> = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, readyClient => {
  readyClient.user.setActivity("akron.micr.dev", { type: ActivityType.Watching });
  console.log(`Akron Discord bot ready as ${readyClient.user.tag}`);
  uploadModerationTimer = setInterval(() => {
    void pollUploadModerationQueue({ client: readyClient, config, onError: reportRuntimeError });
  }, 30_000);
  void pollUploadModerationQueue({ client: readyClient, config, onError: reportRuntimeError });
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton() && interaction.customId === verifyButtonCustomId) {
      await handleVerifyButton(interaction.member as GuildMember | null);
      await interaction.reply({ embeds: [buildVerifyEmbed()], components: buildVerifyComponents(), ephemeral: true });
      return;
    }

    if (interaction.isButton() && await handleScanButtonInteraction({ interaction, config, db: database.db })) {
      return;
    }

    if (interaction.isButton() && await handleUploadModerationInteraction({ interaction, config })) {
      return;
    }

    if (await handlePlaytestingInteraction({ interaction, config, db: database.db })) {
      return;
    }

    if (interaction.isChatInputCommand() && client.isReady()) {
      await handleCommand({ interaction, client, config, db: database.db });
    }
  } catch (error) {
    await reportRuntimeError(error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Akron bot action failed. Staff have been alerted.", ephemeral: true });
    } else if (interaction.isRepliable()) {
      await interaction.followUp({ content: "Akron bot action failed. Staff have been alerted.", ephemeral: true });
    }
  }
});

client.on(Events.ThreadCreate, thread => {
  if (thread.guild.id === config.discordGuildId) {
    scheduleForumThread(thread);
  }
});

client.on(Events.MessageCreate, async message => {
  try {
    if (message.guildId !== config.discordGuildId) {
      return;
    }

    await handlePlaytestingMessage({ message, config, db: database.db });
    if (isForumStarterMessage(message)) {
      scheduleForumThread(message.channel as AnyThreadChannel);
    }
  } catch (error) {
    await reportRuntimeError(error);
  }
});

client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
  try {
    const message = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (message.guildId === config.discordGuildId && isForumStarterMessage(message)) {
      const thread = message.channel as AnyThreadChannel;
      if (await shouldSkipAutoRescan(thread)) {
        return;
      }
      scheduleForumThread(thread);
    }
  } catch (error) {
    await reportRuntimeError(error);
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await client.login(config.discordToken);
githubWebhookServer = startGithubWebhookServer({
  client,
  config,
  db: database.db,
  onError: reportRuntimeError
});

async function handleVerifyButton(member: GuildMember | null): Promise<void> {
  if (!member) {
    throw new Error("Verify button used without a guild member.");
  }
  if (!config.akronMemberRoleId) {
    throw new Error("AKRON_MEMBER_ROLE_ID is not configured.");
  }

  await member.roles.add(config.akronMemberRoleId, "Akron button verification");
  const accountAgeMs = Date.now() - member.user.createdTimestamp;
  await database.db.insert(verificationLogs).values({
    userId: member.user.id,
    username: member.user.username,
    displayName: member.displayName,
    accountAgeDays: Math.max(0, Math.floor(accountAgeMs / 86_400_000)),
    verifiedUtc: utcNow()
  });
}

function isForumStarterMessage(message: Message | PartialMessage): boolean {
  if (!message.channel?.isThread()) {
    return false;
  }
  return message.id === message.channel.id;
}

function scheduleForumThread(thread: AnyThreadChannel): void {
  if (thread.guild.id !== config.discordGuildId) {
    return;
  }

  const existing = scanTimers.get(thread.id);
  if (existing) {
    clearTimeout(existing);
  }

  scanTimers.set(thread.id, setTimeout(() => {
    scanTimers.delete(thread.id);
    void handleForumThread(thread).catch(reportRuntimeError);
  }, 2000));
}

async function handleForumThread(thread: AnyThreadChannel): Promise<void> {
  await scanSubmissionThread({ config, db: database.db, thread });
  await syncGithubForumThread({ config, db: database.db, thread });
}

async function shouldSkipAutoRescan(thread: AnyThreadChannel): Promise<boolean> {
  if (!thread.archived || !thread.locked) {
    return false;
  }

  const state = await database.db.query.scanStates.findFirst({
    where: eq(scanStates.discordThreadId, thread.id)
  });
  return state?.status === "Flagged";
}

async function reportRuntimeError(error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(message);
  const guild = client.guilds.cache.get(config.discordGuildId);
  const channel = guild?.channels.cache.find(candidate => candidate.name === "bot-alerts" && candidate.type === ChannelType.GuildText) as TextChannel | undefined;
  if (channel) {
    await channel.send({ content: message.slice(0, 1900) });
  }
}

async function shutdown(): Promise<void> {
  for (const timer of scanTimers.values()) {
    clearTimeout(timer);
  }
  if (uploadModerationTimer) {
    clearInterval(uploadModerationTimer);
  }
  githubWebhookServer?.close();
  client.destroy();
  database.sqlite.close();
  process.exit(0);
}
