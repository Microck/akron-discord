import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { AppConfig } from "./config.js";
import { embedAssets, embedAssetUrl } from "./embed-assets.js";
import { mapCatalogScopes } from "./server-spec.js";
import { formatSection } from "./submissions/sections.js";
import type { AkronProfileSection } from "./submissions/types.js";

export const verifyButtonCustomId = "akron:verify";
export const playtesterApplyButtonCustomId = "akron:playtester:apply";
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
    .setThumbnail(embedAssetUrl(embedAssets.akronPillar))
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

export function buildPlaytestingEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Apply to Playtest Akron")
    .setDescription([
      "Playtesters get access to beta builds before public release.",
      "",
      "Good playtesting means trying new builds and sending useful feedback: bugs, confusing UI, awkward workflows, unclear text, performance issues, or suggestions for behavior that should change.",
      "",
      "Applications are private. Staff review each request and may deny it with a reason. Accepted users receive the Tester role automatically.",
      "",
      "Tester activity is checked across beta releases. Users accepted through this flow may lose Tester after missing 3 consecutive beta releases."
    ].join("\n"))
    .setColor(0xff66c4);
}

export function buildPlaytestingComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(playtesterApplyButtonCustomId)
        .setLabel("Apply")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

export function buildSubmissionGuideEmbed(config?: AppConfig): EmbedBuilder {
  const githubIssues = githubIssuesMarkdownLink(config);
  return new EmbedBuilder()
    .setTitle("How to Submit Akron Packs")
    .setColor(akronYellow)
    .setThumbnail(embedAssetUrl(embedAssets.akronDash))
    .setDescription("Map catalog packs use Akron's moderated in-game upload. General setup packs can be posted in their matching Discord forum.")
    .addFields(
      {
        name: "Map catalog packs",
        value: "Submit StartPos, Auto Kill, and Auto Deafen packs from **Interface > Upload Pack** while inside the target map. Do not create a post in the showcase forums."
      },
      {
        name: "Map pack review",
        value: "Akron creates the scoped `.akr`, captures marked rooms, and sends the upload to staff. Approved packs appear in the matching showcase forum and Community Packs browser."
      },
      {
        name: "General packs",
        value: "Post Keybinds, HUD, Audio, or Recorder packs in `keybind-packs`, `hud-layouts`, `audio-packs`, or `recorder-packs`. These packs stay Discord-only."
      },
      {
        name: "General pack requirements",
        value: "Export one matching scoped `.akr`, add a short description, and attach at most one helpful PNG, JPEG, or WebP capture. Whole setup packs are not accepted."
      },
      {
        name: "General pack scan",
        value: "The bot checks the starter post and replies with the exact scanned file link, SHA-256, status, and any fixes needed."
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
      { name: "Start Here", value: "Read #submission-guide before submitting or posting `.akr` packs." },
      { name: "Need Help?", value: "Use `questions` for focused support threads." },
      { name: "Website", value: "akron.micr.dev" }
    );
}

export function buildFaqEmbed(config?: AppConfig): EmbedBuilder {
  const githubIssues = githubIssuesMarkdownLink(config);
  return new EmbedBuilder()
    .setTitle("FAQ")
    .setColor(akronYellow)
    .addFields(
      { name: "How do I get access?", value: "Click the button in #verify." },
      { name: "Where do I report bugs?", value: `Prefer ${githubIssues}. Discord \`issues\` posts are synced with GitHub when needed.` },
      { name: "Can I post whole setup packs?", value: "Akron can export and import whole `.akr` setup packs for backup or direct sharing, but the public Discord catalog only accepts scoped packs such as StartPos, Auto Kill, Auto Deafen, Keybinds, HUD, Audio, and Recorder." },
      { name: "Where do community packs show up?", value: "Approved map packs appear in Akron's Community Packs browser and the matching showcase forum. Keybinds, HUD, Audio, and Recorder packs stay in Discord." },
      { name: "How do I open Akron?", value: "The default overlay bind is `Tab`. If it does not open, check Everest controls for Akron actions and look for bind conflicts with Celeste or other mods." },
      { name: "Why are Community Packs empty?", value: "Open the target map first, refresh the catalog, then check category filters, search text, catalog URL, and whether the pack's map SID matches the current map." },
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
      "`Body:` I am practicing *Glyph*. I can export a setup pack, but I only want the StartPos section. Which export option should I use?"
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

export function forumGuidelines(scope: Exclude<AkronProfileSection, "Whole"> | "Akron"): string {
  const needsMap = scope !== "Akron" && mapCatalogScopes.has(scope);

  if (needsMap) {
    return [
      `Approved ${formatSection(scope)} packs are showcased here.`,
      "Submit from Interface > Upload Pack in Akron while inside the target map.",
      "Staff review each upload before the bot creates a post.",
      "Members can reply to showcase threads but cannot create posts."
    ].join("\n");
  }

  return [
    `Post one ${scope} pack per forum post. Read #submission-guide before posting.`,
    "",
    "Template",
    "Title: <short pack name>",
    "Level: <level or map name>",
    "Map: <optional map link when the pack is map-specific>",
    "Description: <what the pack contains and when someone should use it>",
    "Attachments: <one scoped .akr file>, <optional but recommended capture image>",
    "",
    "Requirements",
    "- Attach exactly one scoped .akr file.",
    "- Do not attach whole setup exports yet.",
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
      `The bot syncs valid reports with GitHub. Prefer opening reports directly on ${githubIssues} when you are comfortable doing so.`,
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
    `The bot syncs valid suggestions with GitHub. Prefer opening suggestions directly on ${githubIssues} when you are comfortable doing so.`,
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
  const akrSection = sectionForPackType(packType) as AkronProfileSection;
  const mapCatalogPack = mapCatalogScopes.has(akrSection);
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
      mapCatalogPack
        ? "_Submit this pack type from Interface > Upload Pack in Akron. Approved packs appear here automatically._"
        : "_Use your own export when making a real submission._"
    ].join("\n"),
    akrFileName,
    akrSection,
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
