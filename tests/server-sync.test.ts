import { ChannelType, PermissionsBitField } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildForumExampleSpecs, buildSubmissionGuideEmbed, forumGuidelines } from "../src/content.js";
import { buildPermissionOverwrites } from "../src/server-sync.js";
import { channelSpecs, type ChannelSpec } from "../src/server-spec.js";

describe("server sync permission policy", () => {
  const roles = new Map([
    ["admin", "admin-role"],
    ["moderator", "mod-role"],
    ["member", "member-role"],
    ["tester", "tester-role"]
  ]);

  it("keeps rules and verify read-only for members", () => {
    const rules = overwriteFor("member-role", buildPermissionOverwrites("guild", roles, channelSpec({
      name: "rules",
      category: "info",
      visibility: "public",
      type: ChannelType.GuildText
    })));

    expect(hasFlag(rules.allow, PermissionsBitField.Flags.ViewChannel)).toBe(true);
    expect(hasFlag(rules.allow, PermissionsBitField.Flags.ReadMessageHistory)).toBe(true);
    expect(hasFlag(rules.deny, PermissionsBitField.Flags.SendMessages)).toBe(true);
  });

  it("keeps info channels read-only for members after verification", () => {
    const guide = overwriteFor("member-role", buildPermissionOverwrites("guild", roles, channelSpec({
      name: "submission-guide",
      category: "info",
      visibility: "member",
      type: ChannelType.GuildText
    })));

    expect(hasFlag(guide.allow, PermissionsBitField.Flags.ViewChannel)).toBe(true);
    expect(hasFlag(guide.deny, PermissionsBitField.Flags.SendMessages)).toBe(true);
  });

  it("limits map catalog members to replies", () => {
    const overwrites = buildPermissionOverwrites("guild", roles, requiredChannelSpec("startpos-packs"));
    const everyone = overwriteFor("guild", overwrites);
    const member = overwriteFor("member-role", overwrites);

    expect(hasFlag(member.allow, PermissionsBitField.Flags.SendMessagesInThreads)).toBe(true);
    expect(hasFlag(member.deny, PermissionsBitField.Flags.SendMessages)).toBe(false);
    expect(hasFlag(member.deny, PermissionsBitField.Flags.CreatePublicThreads)).toBe(false);
    expect(hasFlag(everyone.deny, PermissionsBitField.Flags.SendMessages)).toBe(true);
    expect(hasFlag(everyone.deny, PermissionsBitField.Flags.CreatePublicThreads)).toBe(true);
  });

  it.each(["mod-role", "admin-role"])("lets staff role %s create map showcase posts", roleId => {
    const overwrites = buildPermissionOverwrites("guild", roles, requiredChannelSpec("startpos-packs"));
    const member = overwriteFor("member-role", overwrites);
    const staff = overwriteFor(roleId, overwrites);

    expect(hasFlag(member.deny, PermissionsBitField.Flags.SendMessages)).toBe(false);
    expect(hasFlag(member.deny, PermissionsBitField.Flags.CreatePublicThreads)).toBe(false);
    expect(hasFlag(staff.allow, PermissionsBitField.Flags.SendMessages)).toBe(true);
    expect(hasFlag(staff.allow, PermissionsBitField.Flags.CreatePublicThreads)).toBe(true);
  });

  it("lets members create posts in general pack forums", () => {
    const forum = overwriteFor(
      "member-role",
      buildPermissionOverwrites("guild", roles, requiredChannelSpec("keybind-packs"))
    );

    expect(hasFlag(forum.allow, PermissionsBitField.Flags.SendMessages)).toBe(true);
    expect(hasFlag(forum.allow, PermissionsBitField.Flags.CreatePublicThreads)).toBe(true);
  });

  it("keeps playtester channels gated to Tester", () => {
    const overwrites = buildPermissionOverwrites("guild", roles, channelSpec({
      name: "chat",
      category: "playtesters",
      visibility: "tester",
      type: ChannelType.GuildText
    }));
    const everyone = overwriteFor("guild", overwrites);
    const tester = overwriteFor("tester-role", overwrites);

    expect(hasFlag(everyone.deny, PermissionsBitField.Flags.ViewChannel)).toBe(true);
    expect(hasFlag(tester.allow, PermissionsBitField.Flags.ViewChannel)).toBe(true);
    expect(hasFlag(tester.allow, PermissionsBitField.Flags.SendMessages)).toBe(true);
  });

  it("keeps playtest announcements read-only for Tester", () => {
    const tester = overwriteFor("tester-role", buildPermissionOverwrites("guild", roles, channelSpec({
      name: "announcements",
      category: "playtesters",
      visibility: "tester",
      type: ChannelType.GuildText
    })));

    expect(hasFlag(tester.allow, PermissionsBitField.Flags.ViewChannel)).toBe(true);
    expect(hasFlag(tester.deny, PermissionsBitField.Flags.SendMessages)).toBe(true);
    expect(hasFlag(tester.deny, PermissionsBitField.Flags.AttachFiles)).toBe(true);
  });
});

describe("pack submission copy", () => {
  it("directs map packs to the moderated in-game upload flow", () => {
    expect(forumGuidelines("StartPos")).toContain("Interface > Upload Pack");
    expect(forumGuidelines("StartPos")).toContain("cannot create posts");
    expect(JSON.stringify(buildSubmissionGuideEmbed().toJSON())).toContain("Interface > Upload Pack");

    const mapExample = buildForumExampleSpecs().find(spec => spec.channelName === "startpos-packs");
    expect(mapExample?.content).toContain("Approved packs appear here automatically");
  });

  it("keeps direct Discord posts for general packs", () => {
    expect(forumGuidelines("Keybinds")).toContain("Post one Keybinds pack per forum post");
    expect(JSON.stringify(buildSubmissionGuideEmbed().toJSON())).toContain("Keybinds, HUD, Audio, or Recorder");
  });
});

function channelSpec(overrides: Partial<ChannelSpec>): ChannelSpec {
  return {
    name: "channel",
    type: ChannelType.GuildText,
    category: "info",
    visibility: "member",
    ...overrides
  };
}

function requiredChannelSpec(name: string): ChannelSpec {
  const spec = channelSpecs.find(channel => channel.name === name);
  if (!spec) {
    throw new Error("Missing channel spec for " + name);
  }
  return spec;
}

function overwriteFor(id: string, overwrites: unknown[]): { allow?: bigint[]; deny?: bigint[] } {
  const found = overwrites.find(overwrite => (overwrite as { id?: string }).id === id) as { allow?: bigint[]; deny?: bigint[] } | undefined;
  if (!found) {
    throw new Error("Missing overwrite for " + id);
  }
  return found;
}

function hasFlag(values: bigint[] | undefined, flag: bigint): boolean {
  return values?.includes(flag) ?? false;
}
