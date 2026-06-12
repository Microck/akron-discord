import "dotenv/config";
import { z } from "zod";

const optionalId = z.string().trim().optional().default("");

const configSchema = z.object({
  discordToken: z.string().min(1),
  discordClientId: z.string().min(1),
  discordGuildId: z.string().min(1),
  akronAdminRoleId: optionalId,
  akronModRoleId: optionalId,
  akronMemberRoleId: optionalId,
  cloudflareR2AccountId: z.string().min(1),
  cloudflareR2AccessKeyId: z.string().min(1),
  cloudflareR2SecretAccessKey: z.string().min(1),
  cloudflareR2Bucket: z.string().min(1),
  cloudflareR2PublicBaseUrl: z.string().url(),
  akronPublicAssetBaseUrl: optionalId,
  nvidiaNimApiKey: optionalId,
  nvidiaNimBaseUrl: z.string().url().default("https://integrate.api.nvidia.com/v1"),
  nvidiaNimModel: optionalId,
  githubAppId: optionalId,
  githubAppPrivateKey: optionalId,
  githubAppInstallationId: optionalId,
  githubToken: optionalId,
  githubOwner: optionalId,
  githubRepo: optionalId,
  githubWebhookSecret: optionalId,
  githubWebhookPort: z.coerce.number().int().positive().default(3005),
  databasePath: z.string().trim().default("data/akron-discord.sqlite")
});

export type AppConfig = z.infer<typeof configSchema>;

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value == null || value.trim() === "" ? undefined : value;
}

export function loadConfig(): AppConfig {
  return configSchema.parse({
    discordToken: envValue("DISCORD_TOKEN"),
    discordClientId: envValue("DISCORD_CLIENT_ID"),
    discordGuildId: envValue("DISCORD_GUILD_ID"),
    akronAdminRoleId: envValue("AKRON_ADMIN_ROLE_ID"),
    akronModRoleId: envValue("AKRON_MOD_ROLE_ID"),
    akronMemberRoleId: envValue("AKRON_MEMBER_ROLE_ID"),
    cloudflareR2AccountId: envValue("CLOUDFLARE_R2_ACCOUNT_ID"),
    cloudflareR2AccessKeyId: envValue("CLOUDFLARE_R2_ACCESS_KEY_ID"),
    cloudflareR2SecretAccessKey: envValue("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    cloudflareR2Bucket: envValue("CLOUDFLARE_R2_BUCKET"),
    cloudflareR2PublicBaseUrl: envValue("CLOUDFLARE_R2_PUBLIC_BASE_URL"),
    akronPublicAssetBaseUrl: envValue("AKRON_PUBLIC_ASSET_BASE_URL"),
    nvidiaNimApiKey: envValue("NVIDIA_NIM_API_KEY"),
    nvidiaNimBaseUrl: envValue("NVIDIA_NIM_BASE_URL"),
    nvidiaNimModel: envValue("NVIDIA_NIM_MODEL"),
    githubAppId: envValue("GITHUB_APP_ID"),
    githubAppPrivateKey: envValue("GITHUB_APP_PRIVATE_KEY")?.replace(/\\n/g, "\n"),
    githubAppInstallationId: envValue("GITHUB_APP_INSTALLATION_ID"),
    githubToken: envValue("GITHUB_TOKEN"),
    githubOwner: envValue("GITHUB_OWNER"),
    githubRepo: envValue("GITHUB_REPO"),
    githubWebhookSecret: envValue("GITHUB_WEBHOOK_SECRET"),
    githubWebhookPort: envValue("GITHUB_WEBHOOK_PORT"),
    databasePath: envValue("DATABASE_PATH")
  });
}

export function hasGithubConfig(config: AppConfig): boolean {
  return Boolean(
    config.githubOwner &&
      config.githubRepo &&
      (config.githubToken || (config.githubAppId && config.githubAppPrivateKey && config.githubAppInstallationId))
  );
}

export function hasNimConfig(config: AppConfig): boolean {
  return Boolean(config.nvidiaNimApiKey && config.nvidiaNimModel);
}
