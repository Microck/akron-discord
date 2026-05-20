import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

export const verifyButtonCustomId = "akron:verify";

export function buildVerifyEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Verify for Akron Discord")
    .setDescription("Click Verify Me to unlock the server. This gives you the Member role.")
    .setColor(0xc42a30);
}

export function buildRulesEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Akron Discord Rules")
    .setColor(0xc42a30)
    .setDescription("Use this server for Akron support, submissions, issues, and suggestions. Keep posts actionable and safe.")
    .addFields(
      {
        name: "Community",
        value: "Be respectful, stay on topic, and do not harass, impersonate, scam, spam, dox, or post hateful content."
      },
      {
        name: "Submissions",
        value: "Only post scoped `.akr` packs in the matching forum. `Whole` profile packs are not accepted publicly yet."
      },
      {
        name: "Safety",
        value: "Do not include credentials, tokens, private overlays, suspicious commands, nested archives, or unrelated files in submissions."
      },
      {
        name: "Moderation",
        value: "`Needs Fix` means edit the post and rescan. `Needs Moderator Review` means staff must resolve it. `Flagged` posts are locked for safety."
      },
      {
        name: "Feedback",
        value: "Issues and suggestions can be posted in Discord, but GitHub is preferred when you are comfortable opening them there directly."
      }
    );
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
    .setColor(0xc42a30)
    .setDescription("Use the right forum, attach one scoped .akr pack, and include enough map context for other players to trust it.")
    .addFields(
      {
        name: "Map catalog packs",
        value: "`startpos-packs`, `auto-kill-areas`, and `auto-deafen-areas` publish to Akron's in-game catalog after validation."
      },
      {
        name: "Discord-only packs",
        value: "`keybind-packs`, `hud-layouts`, `audio-packs`, and `recorder-packs` are scanned and kept on Discord only."
      },
      {
        name: "Required",
        value: "Attach exactly one `.akr`, include a supported map link for map-specific packs, and choose the matching forum/tag."
      },
      {
        name: "Exporting",
        value: "Export a scoped pack from Akron instead of a whole profile. `Whole` profile packs are disabled for public posting in this first version."
      },
      {
        name: "Map captures",
        value: "Map captures are optional but heavily recommended. Akron can generate room or map captures easily. Show StartPos markers, Auto Kill areas, or Auto Deafen areas clearly, and avoid private desktop content."
      },
      {
        name: "Example",
        value: "Title: `Beginner Lobby StartPos Pack`\nMap: `https://gamebanana.com/mods/150453`\nDescription: `Start positions for common lobby practice rooms.`\nAttachments: `beginner-startpos.akr`, `beginner-startpos-capture.png`"
      },
      {
        name: "Bot feedback",
        value: "`Needs Fix` means you can edit the post. `Needs Moderator Review` means staff must resolve something. `Flagged` means the post was locked or hidden for safety."
      }
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
