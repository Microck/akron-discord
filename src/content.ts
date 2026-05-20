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

export function buildLinksEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Links")
    .setColor(akronYellow)
    .setDescription("Official Akron links will be posted here.")
    .addFields(
      { name: "Website", value: "akron.micr.dev" }
    );
}

export type ForumExampleSpec = {
  channelName: string;
  settingKey: string;
  threadTitle: string;
  embed: EmbedBuilder;
};

export function buildForumExampleSpecs(): ForumExampleSpec[] {
  return [
    submissionExample("startpos-packs", "StartPos submission", [
      "Map: https://gamebanana.com/mods/150453",
      "Description: Start positions for lobby practice and common room resets.",
      "Attachments: lobby-startpos.akr, lobby-startpos-capture.png"
    ]),
    submissionExample("auto-kill-areas", "Auto Kill submission", [
      "Map: https://gamebanana.com/mods/150453",
      "Description: Auto Kill areas for fast reset practice in the hard rooms.",
      "Attachments: hard-rooms-auto-kill.akr, hard-rooms-capture.png"
    ]),
    submissionExample("auto-deafen-areas", "Auto Deafen submission", [
      "Map: https://gamebanana.com/mods/150453",
      "Description: Auto Deafen areas around music-heavy practice rooms.",
      "Attachments: music-rooms-auto-deafen.akr, music-rooms-capture.png"
    ]),
    submissionExample("keybind-packs", "Keybind submission", [
      "Description: Practice keybinds for quick restart, capture, and marker editing.",
      "Attachments: practice-keybinds.akr"
    ]),
    submissionExample("hud-layouts", "HUD layout submission", [
      "Description: Compact HUD layout for recording and room practice.",
      "Attachments: compact-hud.akr, compact-hud-preview.png"
    ]),
    submissionExample("audio-packs", "Audio pack submission", [
      "Description: Audio settings tuned for practice streams.",
      "Attachments: stream-audio.akr"
    ]),
    submissionExample("recorder-packs", "Recorder pack submission", [
      "Description: Recorder settings for lightweight 1080p clips.",
      "Attachments: 1080p-recorder.akr"
    ]),
    feedbackExample("questions", "Question", [
      "Title: How do I export only StartPos?",
      "Body: Say what you tried, your Akron version, and what part is confusing."
    ]),
    feedbackExample("issues", "Issue report", [
      "Title: StartPos export fails on map X",
      "Body: Include what happened, what you expected, Akron version, logs/screenshots, and reproduction steps.",
      "GitHub: Prefer opening this directly on GitHub when you can."
    ]),
    feedbackExample("suggestions", "Suggestion", [
      "Title: Add a preview before publishing a capture",
      "Body: Describe the problem, proposed behavior, and examples or mockups.",
      "GitHub: Prefer opening this directly on GitHub when you can."
    ])
  ];
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

function submissionExample(channelName: string, label: string, lines: string[]): ForumExampleSpec {
  return {
    channelName,
    settingKey: `thread.example.${channelName}.id`,
    threadTitle: `Example: ${label}`,
    embed: buildExampleEmbed(label, [
      "Use this shape for your own post. Replace the text and attach your real files.",
      "",
      ...lines
    ])
  };
}

function feedbackExample(channelName: string, label: string, lines: string[]): ForumExampleSpec {
  return {
    channelName,
    settingKey: `thread.example.${channelName}.id`,
    threadTitle: `Example: ${label}`,
    embed: buildExampleEmbed(label, [
      "Use one focused forum post. Keep follow-up details in the thread.",
      "",
      ...lines
    ])
  };
}

function buildExampleEmbed(label: string, lines: string[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Example ${label}`)
    .setColor(akronYellow)
    .setDescription(lines.join("\n"));
}
