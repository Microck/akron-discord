import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { AkronProfileSection } from "./submissions/types.js";

export const roleSpecs = [
  { key: "admin", name: "Admin", color: 0xed4245 },
  { key: "moderator", name: "Moderator", color: 0x9b59b6 },
  { key: "member", name: "Member", color: 0x57f287 },
  { key: "tester", name: "Tester", color: 0x5dade2 },
  { key: "beta", name: "Beta", color: 0xff66c4 },
  { key: "bot", name: "Bot", color: 0xfee75c }
] as const;

export type RoleKey = (typeof roleSpecs)[number]["key"];

export type ChannelSpec = {
  name: string;
  type: ChannelType.GuildText | ChannelType.GuildForum;
  category?: "info" | "feedback" | "map-catalog" | "general-packs" | "playtesters" | "staff";
  visibility: "public" | "member" | "tester" | "staff" | "admin";
  memberPosting?: "post" | "reply";
  topic?: string;
  forumTags?: string[];
};

export const categorySpecs = [
  { key: "info", name: "Info" },
  { key: "feedback", name: "Feedback" },
  { key: "map-catalog", name: "Map Catalog" },
  { key: "general-packs", name: "General Packs" },
  { key: "playtesters", name: "playtesters" },
  { key: "staff", name: "Staff" }
] as const;

export const statusForumTags = [
  "Pending Scan",
  "Published",
  "Needs Fix",
  "Needs Moderator Review",
  "Flagged"
];

export const channelSpecs: ChannelSpec[] = [
  {
    name: "rules",
    type: ChannelType.GuildText,
    category: "info",
    visibility: "public",
    topic: "Server rules and submission policy."
  },
  {
    name: "verify",
    type: ChannelType.GuildText,
    visibility: "public",
    topic: "Click Verify Me to unlock the Akron Discord."
  },
  {
    name: "announcements",
    type: ChannelType.GuildText,
    category: "info",
    visibility: "member",
    topic: "Official Akron announcements."
  },
  {
    name: "links",
    type: ChannelType.GuildText,
    category: "info",
    visibility: "member",
    topic: "Official Akron links and resources."
  },
  {
    name: "welcome",
    type: ChannelType.GuildText,
    category: "info",
    visibility: "member",
    topic: "Post-verification orientation."
  },
  {
    name: "faq",
    type: ChannelType.GuildText,
    category: "info",
    visibility: "member",
    topic: "Common questions and links."
  },
  {
    name: "submission-guide",
    type: ChannelType.GuildText,
    category: "info",
    visibility: "member",
    topic: "How to make .akr submissions and map captures."
  },
  {
    name: "questions",
    type: ChannelType.GuildForum,
    category: "feedback",
    visibility: "member",
    topic: "Ask one Akron question per post.",
    forumTags: ["Akron Setup", ".akr Packs", "Map Catalog", "Bug Help", "Answered", "Needs Staff"]
  },
  {
    name: "playtesting",
    type: ChannelType.GuildText,
    category: "feedback",
    visibility: "member",
    topic: "Apply to help test Akron beta builds."
  },
  {
    name: "issues",
    type: ChannelType.GuildForum,
    category: "feedback",
    visibility: "member",
    topic: "Bug reports synced with GitHub.",
    forumTags: ["Needs Info", "Synced", "GitHub Open", "GitHub Closed", "Duplicate", "Invalid", "Not Planned"]
  },
  {
    name: "suggestions",
    type: ChannelType.GuildForum,
    category: "feedback",
    visibility: "member",
    topic: "Feature suggestions synced with GitHub.",
    forumTags: ["Needs Info", "Synced", "GitHub Open", "GitHub Closed", "Duplicate", "Invalid", "Not Planned"]
  },
  {
    name: "startpos-packs",
    type: ChannelType.GuildForum,
    category: "map-catalog",
    visibility: "member",
    memberPosting: "reply",
    topic: "StartPos .akr packs tied to a map.",
    forumTags: [...statusForumTags, "StartPos"]
  },
  {
    name: "auto-kill-areas",
    type: ChannelType.GuildForum,
    category: "map-catalog",
    visibility: "member",
    memberPosting: "reply",
    topic: "Auto Kill .akr packs tied to a map.",
    forumTags: [...statusForumTags, "Auto Kill"]
  },
  {
    name: "auto-deafen-areas",
    type: ChannelType.GuildForum,
    category: "map-catalog",
    visibility: "member",
    memberPosting: "reply",
    topic: "Auto Deafen .akr packs tied to a map.",
    forumTags: [...statusForumTags, "Auto Deafen"]
  },
  {
    name: "keybind-packs",
    type: ChannelType.GuildForum,
    category: "general-packs",
    visibility: "member",
    topic: "Discord-only keybind .akr packs.",
    forumTags: statusForumTags
  },
  {
    name: "hud-layouts",
    type: ChannelType.GuildForum,
    category: "general-packs",
    visibility: "member",
    topic: "Discord-only HUD layout .akr packs.",
    forumTags: statusForumTags
  },
  {
    name: "audio-packs",
    type: ChannelType.GuildForum,
    category: "general-packs",
    visibility: "member",
    topic: "Discord-only audio .akr packs.",
    forumTags: statusForumTags
  },
  {
    name: "recorder-packs",
    type: ChannelType.GuildForum,
    category: "general-packs",
    visibility: "member",
    topic: "Discord-only recorder .akr packs.",
    forumTags: statusForumTags
  },
  {
    name: "announcements",
    type: ChannelType.GuildText,
    category: "playtesters",
    visibility: "tester",
    topic: "Playtester build announcements and beta downloads."
  },
  {
    name: "chat",
    type: ChannelType.GuildText,
    category: "playtesters",
    visibility: "tester",
    topic: "Playtester discussion."
  },
  {
    name: "tester-feedback",
    type: ChannelType.GuildForum,
    category: "playtesters",
    visibility: "tester",
    topic: "Playtester feedback for beta builds.",
    forumTags: ["UI/UX", "Ruleset", "Docs", "Performance", "Answered"]
  },
  {
    name: "tester-bugs-n-issues",
    type: ChannelType.GuildForum,
    category: "playtesters",
    visibility: "tester",
    topic: "Playtester bug reports for beta builds.",
    forumTags: ["Needs Info", "Reproduced", "Fixed", "Duplicate", "Invalid"]
  },
  {
    name: "staff-chat",
    type: ChannelType.GuildText,
    category: "staff",
    visibility: "staff",
    topic: "Staff discussion."
  },
  {
    name: "mod-log",
    type: ChannelType.GuildText,
    category: "staff",
    visibility: "staff",
    topic: "Moderation actions and overrides."
  },
  {
    name: "scan-log",
    type: ChannelType.GuildText,
    category: "staff",
    visibility: "staff",
    topic: "Submission scan summaries."
  },
  {
    name: "audit-log",
    type: ChannelType.GuildText,
    category: "staff",
    visibility: "admin",
    topic: "Server sync, catalog writes, and high-risk actions."
  },
  {
    name: "bot-alerts",
    type: ChannelType.GuildText,
    category: "staff",
    visibility: "admin",
    topic: "Runtime failures and storage/API errors."
  },
  {
    name: "catalog-overrides",
    type: ChannelType.GuildForum,
    category: "staff",
    visibility: "staff",
    topic: "Manual map-link to map SID mappings."
  },
  {
    name: "playtester-applications",
    type: ChannelType.GuildForum,
    category: "staff",
    visibility: "staff",
    topic: "Private staff review queue for playtester applications.",
    forumTags: ["Open", "Accepted", "Denied"]
  },
  {
    name: "github-sync-log",
    type: ChannelType.GuildText,
    category: "staff",
    visibility: "staff",
    topic: "GitHub issue sync failures and backfills."
  }
];

export const packChannelScopes = new Map<string, Exclude<AkronProfileSection, "Whole">>([
  ["startpos-packs", "StartPos"],
  ["auto-kill-areas", "AutoKill"],
  ["auto-deafen-areas", "AutoDeafen"],
  ["keybind-packs", "Keybinds"],
  ["hud-layouts", "Hud"],
  ["audio-packs", "Audio"],
  ["recorder-packs", "Recorder"]
]);

export const mapCatalogScopes = new Set<AkronProfileSection>(["StartPos", "AutoKill", "AutoDeafen"]);

export const directSubmissionChannelScopes = new Map(
  [...packChannelScopes].filter(([, scope]) => !mapCatalogScopes.has(scope))
);

export const githubLabelSpecs = [
  { name: "discord", color: "5865F2", description: "Created from an Akron Discord forum post." },
  { name: "issue", color: "d73a4a", description: "Bug or broken behavior." },
  { name: "suggestion", color: "a2eeef", description: "Feature suggestion or product idea." },
  { name: "needs-triage", color: "fbca04", description: "Needs maintainer review." },
  { name: "needs-info", color: "d876e3", description: "More information is needed." },
  { name: "accepted", color: "4f801a", description: "Accepted for future work." },
  { name: "not-planned", color: "ffffff", description: "Not planned." },
  { name: "duplicate", color: "cfd3d7", description: "Duplicate issue or suggestion." },
  { name: "invalid", color: "e4e669", description: "Invalid or not actionable." },
  { name: "high-prio", color: "b60205", description: "High priority." },
  { name: "medium-prio", color: "fbca04", description: "Medium priority." },
  { name: "low-prio", color: "0e8a16", description: "Low priority." }
];

export const botPermissions = [
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks
];
