import { PermissionFlagsBits, type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { AppConfig } from "./config.js";

type PermissionInteraction = ChatInputCommandInteraction | ButtonInteraction;

export function hasConfiguredRole(member: GuildMember, roleId: string): boolean {
  return Boolean(roleId && member.roles.cache.has(roleId));
}

export function isAdmin(member: GuildMember, config: AppConfig): boolean {
  if (!config.akronAdminRoleId && member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  return hasConfiguredRole(member, config.akronAdminRoleId);
}

export function isModerator(member: GuildMember, config: AppConfig): boolean {
  return isAdmin(member, config) || hasConfiguredRole(member, config.akronModRoleId);
}

export async function requireAdmin(interaction: PermissionInteraction, config: AppConfig): Promise<boolean> {
  const member = interaction.member instanceof Object && "roles" in interaction.member
    ? (interaction.member as GuildMember)
    : null;
  if (member && isAdmin(member, config)) {
    return true;
  }

  await interaction.reply({ content: "Admin role required.", ephemeral: true });
  return false;
}

export async function requireModerator(interaction: PermissionInteraction, config: AppConfig): Promise<boolean> {
  const member = interaction.member instanceof Object && "roles" in interaction.member
    ? (interaction.member as GuildMember)
    : null;
  if (member && isModerator(member, config)) {
    return true;
  }

  await interaction.reply({ content: "Moderator role required.", ephemeral: true });
  return false;
}
