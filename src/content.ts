import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { AppConfig } from "./config.js";

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

export function buildSubmissionGuideEmbed(config?: AppConfig): EmbedBuilder {
  const githubIssues = githubIssuesMarkdownLink(config);
  return new EmbedBuilder()
    .setTitle("How to Submit Akron Packs")
    .setColor(akronYellow)
    .setDescription("Follow these steps before posting. The bot archives the exact scanned `.akr`, checks it, and sends map packs to moderator review before catalog publication.")
    .addFields(
      {
        name: "1. Pick the forum",
        value: "`startpos-packs`, `auto-kill-areas`, and `auto-deafen-areas` are map catalog packs. `keybind-packs`, `hud-layouts`, `audio-packs`, and `recorder-packs` stay Discord-only."
      },
      {
        name: "2. Export one scoped pack",
        value: "In Akron, export only the matching section. Do not post whole profiles yet."
      },
      {
        name: "3. Add the map link",
        value: "For map-specific forums, include `Map: https://gamebanana.com/mods/...` in the post body."
      },
      {
        name: "4. Add a short description",
        value: "Explain what the pack contains, for example the rooms covered, marker purpose, or layout goal."
      },
      {
        name: "5. Add a capture",
        value: "Optional, but heavily recommended. Use Akron's room or map capture so markers, StartPos points, Auto Kill areas, or Auto Deafen areas are visible. Keep room context in frame and avoid private desktop content."
      },
      {
        name: "6. Post and wait",
        value: "Attach exactly one `.akr`. The bot will reply with the scanned file link, SHA-256, status, and any fixes needed."
      },
      {
        name: "Issues and suggestions",
        value: `Discord forums work when needed, but prefer opening bug reports and feature requests directly on ${githubIssues}.`
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

export function buildFaqEmbed(config?: AppConfig): EmbedBuilder {
  const githubIssues = githubIssuesMarkdownLink(config);
  return new EmbedBuilder()
    .setTitle("FAQ")
    .setColor(akronYellow)
    .setDescription("Short answers for common Akron Discord workflows.")
    .addFields(
      { name: "How do I get access?", value: "Click the button in #verify." },
      { name: "Where do I report bugs?", value: `Prefer ${githubIssues}. Discord \`issues\` posts are synced one-way when needed.` },
      { name: "Can I post whole profiles?", value: "Not yet. Export a scoped `.akr` pack." },
      { name: "Why did my post get flagged?", value: "Staff can review locked flagged posts. The bot preserves the scanned file for evidence." }
    );
}

export type ForumExampleSpec = {
  channelName: string;
  settingKey: string;
  threadTitle: string;
  content: string;
  akrFileName: string;
  akrSection: string;
  includeCapture: boolean;
};

export function buildForumExampleSpecs(): ForumExampleSpec[] {
  return [
    submissionExample("startpos-packs", "StartPos submission", "StartPos", true),
    submissionExample("auto-kill-areas", "Auto Kill submission", "Auto Kill", true),
    submissionExample("auto-deafen-areas", "Auto Deafen submission", "Auto Deafen", true),
    submissionExample("keybind-packs", "Keybind submission", "Keybinds", false),
    submissionExample("hud-layouts", "HUD layout submission", "HUD layout", true),
    submissionExample("audio-packs", "Audio pack submission", "Audio settings", false),
    submissionExample("recorder-packs", "Recorder pack submission", "Recorder settings", false),
    feedbackExample("questions", "Question", [
      "**Example**",
      "`Title:` How do I export only StartPos?",
      "`Body:` I am practicing *Glyph*. I can export a profile, but I only want the StartPos section. Which export option should I use?"
    ]),
    feedbackExample("issues", "Issue report", [
      "**Example**",
      "`Title:` StartPos export fails on Glyph",
      "`Body:` On Akron 0.0.0, exporting a StartPos pack for *Glyph* creates no file. Expected a `.akr` export. Steps: open Glyph, add one StartPos marker, export StartPos."
    ]),
    feedbackExample("suggestions", "Suggestion", [
      "**Example**",
      "`Title:` Add a preview before publishing a capture",
      "`Body:` Before uploading a map capture, show a small preview so I can confirm StartPos markers and room context are visible."
    ])
  ];
}

export function forumGuidelines(scope: string): string {
  const needsMap = ["StartPos", "AutoKill", "AutoDeafen"].includes(scope);
  return [
    `Post one ${scope} pack per forum post. Read #submission-guide before posting.`,
    "",
    "Template",
    "Title: <short pack name>",
    "Level: <level or map name>",
    needsMap
      ? "Map: <supported GameBanana map link or vanilla Celeste chapter name>"
      : "Map: <optional map link when the pack is map-specific>",
    "Description: <what the pack contains and when someone should use it>",
    "Attachments: <one scoped .akr file>, <optional but recommended capture image>",
    "",
    "Requirements",
    "- Attach exactly one scoped .akr file.",
    needsMap ? "- Include a supported map link or vanilla chapter name." : "- Do not attach whole profile exports yet.",
    "- Add a short description.",
    "- Add a room or map capture when it helps show the contents."
  ].join("\n");
}

export function feedbackForumGuidelines(kind: "issue" | "suggestion" | "question", config?: AppConfig): string {
  const githubIssues = githubIssuesMarkdownLink(config);

  if (kind === "question") {
    return [
      "Ask one focused Akron question per post.",
      "",
      "Template",
      "Title: <short question>",
      "Body: What are you trying to do? What did you try? What Akron version/build are you on?",
      "",
      "Tips",
      "- Include screenshots, logs, or pack details when they matter.",
      `- Use issue reports for bugs and suggestions for product ideas. Prefer ${githubIssues} when possible.`
    ].join("\n");
  }

  if (kind === "issue") {
    return [
      "Use one post per bug report.",
      `The bot syncs valid reports one-way to GitHub. Prefer opening reports directly on ${githubIssues} when you are comfortable doing so.`,
      "",
      "Template",
      "Title: <what broke>",
      "Observed: <what happened>",
      "Expected: <what should have happened>",
      "Reproduction: <steps staff can follow>",
      "Version: <Akron version/build>",
      "Attachments: <optional screenshots, logs, or crash text>"
    ].join("\n");
  }

  return [
    "Use one post per feature suggestion.",
    `The bot syncs valid suggestions one-way to GitHub. Prefer opening suggestions directly on ${githubIssues} when you are comfortable doing so.`,
    "",
    "Template",
    "Title: <what should Akron add or change?>",
    "Problem: <what pain or opportunity this addresses>",
    "Proposed behavior: <what you want Akron to do>",
    "Examples: <optional screenshots, mockups, links, or related tools>",
    "Priority: <low, medium, or high if you have a clear reason>"
  ].join("\n");
}

export function githubIssuesMarkdownLink(config?: Pick<AppConfig, "githubOwner" | "githubRepo">): string {
  if (!config?.githubOwner || !config.githubRepo) {
    return "the GitHub issues page";
  }

  return `[the GitHub issues page](https://github.com/${config.githubOwner}/${config.githubRepo}/issues)`;
}

function submissionExample(channelName: string, label: string, packType: string, includeCapture: boolean): ForumExampleSpec {
  const fileSlug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const akrFileName = `glyph-${fileSlug}.akr`;
  return {
    channelName,
    settingKey: `thread.example.${channelName}.id`,
    threadTitle: `Example: ${label}`,
    content: [
      "**Example**",
      `\`Title:\` Glyph ${packType} Pack`,
      "`Level:` *Glyph*",
      "`Map:` <https://gamebanana.com/mods/150453>",
      `\`Description:\` ${packType} setup for practicing Glyph rooms. Replace this with the rooms, markers, or settings your pack actually covers.`,
      `\`Attachments:\` ${akrFileName}` + (includeCapture ? ", akron-map-capture-placeholder.jpg" : ""),
      "",
      "_Use your own export when making a real submission._"
    ].join("\n"),
    akrFileName,
    akrSection: sectionForPackType(packType),
    includeCapture
  };
}

function feedbackExample(channelName: string, label: string, lines: string[]): ForumExampleSpec {
  return {
    channelName,
    settingKey: `thread.example.${channelName}.id`,
    threadTitle: `Example: ${label}`,
    content: lines.join("\n"),
    akrFileName: "",
    akrSection: "",
    includeCapture: false
  };
}

function sectionForPackType(packType: string): string {
  if (packType === "Auto Kill") {
    return "AutoKill";
  }
  if (packType === "Auto Deafen") {
    return "AutoDeafen";
  }
  if (packType === "HUD layout") {
    return "Hud";
  }
  if (packType === "Audio settings") {
    return "Audio";
  }
  if (packType === "Recorder settings") {
    return "Recorder";
  }
  return packType;
}
