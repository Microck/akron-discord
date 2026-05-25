import { ChannelType, PermissionsBitField } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildPermissionOverwrites } from "../src/server-sync.js";
import type { ChannelSpec } from "../src/server-spec.js";

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

  it("allows members to create forum posts in submission channels", () => {
    const forum = overwriteFor("member-role", buildPermissionOverwrites("guild", roles, channelSpec({
      name: "startpos-packs",
      category: "map-catalog",
      visibility: "member",
      type: ChannelType.GuildForum
    })));

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
