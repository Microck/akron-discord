import { join } from "node:path";
import { AttachmentBuilder } from "discord.js";

export const embedAssets = {
  akronDash: "akrondash.png",
  akronLeaf: "akronleaf.png",
  akronLeafDesaturated: "akronleaf-desaturated.png",
  akronLeafFlagged: "akronleaf-flagged.png",
  akronPillar: "akronpillar.png"
} as const;

export type EmbedAssetName = (typeof embedAssets)[keyof typeof embedAssets];

export function embedAssetAttachment(name: EmbedAssetName): AttachmentBuilder {
  return new AttachmentBuilder(join(process.cwd(), "assets", name), { name });
}

export function embedAssetUrl(name: EmbedAssetName): string {
  return `attachment://${name}`;
}
