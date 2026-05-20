import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

export const verifyButtonCustomId = "akron:verify";
const akronYellow = 0xfee75c;

export function buildVerifyEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Verify for Akron Discord")
    .setDescription("Click Verify Me to unlock the server. This gives you the Member role.")
    .setColor(akronYellow);
}

export function buildRulesEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Rules")
    .setColor(akronYellow)
    .setDescription([
      "1. Be respectful. No harassment, hate, or personal attacks.",
      "2. No spam. No flooding, self-promo, or unsolicited DMs.",
      "3. Keep it legal & safe. No doxxing, scams, malware, or hacking help.",
      "4. Stay on-topic. Use the right channels and keep threads focused.",
      "5. No NSFW. Keep it clean.",
      "6. Follow staff. Mods can remove content and take action as needed.",
      "",
      "By staying here, you agree to these rules."
    ].join("\n"));
}

export function buildVerifyComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(verifyButtonCustomId)
        .setLabel("Verify Me")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

export function buildSubmissionGuideEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("How to Submit Akron Packs")
    .setColor(akronYellow)
    .setDescription("Post one scoped `.akr` in the right forum. The bot archives the exact scanned file, validates it, and publishes eligible map packs.")
    .addFields(
      {
        name: "Required",
        value: "One `.akr`, the right forum, and a supported GameBanana map link for map-specific packs."
      },
      {
        name: "Recommended",
        value: "Add a short description and a capture from Akron showing markers, zones, or relevant rooms."
      },
      {
        name: "Catalog",
        value: "`startpos-packs`, `auto-kill-areas`, and `auto-deafen-areas` can publish to Akron's in-game catalog."
      },
      {
        name: "Discord-only",
        value: "`keybind-packs`, `hud-layouts`, `audio-packs`, and `recorder-packs` are scanned and kept here."
      },
      {
        name: "Example",
        value: "`Map: https://gamebanana.com/mods/150453`\n`Description: Start positions for common practice rooms.`"
      }
    );
}

export function buildWelcomeEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Welcome to Akron")
    .setColor(akronYellow)
    .setDescription("This is the official Discord for Akron support, community packs, issues, and suggestions.")
    .addFields(
      { name: "Start Here", value: "Read #submission-guide before posting `.akr` packs." },
      { name: "Need Help?", value: "Use `questions` for focused support threads." },
      { name: "Website", value: "akron.micr.dev" }
    );
}

export function buildFaqEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("FAQ")
    .setColor(akronYellow)
    .setDescription("Short answers for common Akron Discord workflows.")
    .addFields(
      { name: "How do I get access?", value: "Click the button in #verify." },
      { name: "Where do I report bugs?", value: "Prefer GitHub directly. Discord `issues` posts are synced one-way when needed." },
      { name: "Can I post whole profiles?", value: "Not yet. Export a scoped `.akr` pack." },
      { name: "Why did my post get flagged?", value: "Staff can review locked flagged posts. The bot preserves the scanned file for evidence." }
    );
}

export function buildAnnouncementsEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Announcements")
    .setColor(akronYellow)
    .setDescription("Official Akron updates will be posted here.")
    .addFields(
      { name: "Follow", value: "Use this channel for release notes, server changes, and important moderation notices." },
      { name: "Website", value: "akron.micr.dev" }
    );
}

export function forumGuidelines(scope: string): string {
  return [
    `Post one ${scope} pack per forum post.`,
    "Attach one scoped .akr file.",
    "For map-specific packs, include a supported map link.",
    "Add a short description and a map capture when possible.",
    "Read #submission-guide before posting."
  ].join("\n");
}

export function feedbackForumGuidelines(kind: "issue" | "suggestion"): string {
  if (kind === "issue") {
    return [
      "Use one post per bug report.",
      "Include observed behavior, expected behavior, and version/build context when possible.",
      "Attach screenshots, logs, or crash text when useful.",
      "The bot syncs valid reports one-way to GitHub.",
      "Prefer opening the GitHub issue directly when you are comfortable doing so."
    ].join("\n");
  }

  return [
    "Use one post per feature suggestion.",
    "Describe the problem or opportunity and the proposed behavior.",
    "Attach examples, screenshots, or mockups when useful.",
    "The bot syncs valid suggestions one-way to GitHub.",
    "Prefer opening the GitHub issue directly when you are comfortable doing so."
  ].join("\n");
}
