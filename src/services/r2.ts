import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, NotFound, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";

export type R2Object = {
  key: string;
  body: Buffer | string;
  contentType: string;
};

export function createR2Client(config: AppConfig): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.cloudflareR2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.cloudflareR2AccessKeyId,
      secretAccessKey: config.cloudflareR2SecretAccessKey
    }
  });
}

export async function putR2Object(config: AppConfig, client: S3Client, object: R2Object): Promise<string> {
  await client.send(new PutObjectCommand({
    Bucket: config.cloudflareR2Bucket,
    Key: object.key,
    Body: object.body,
    ContentType: object.contentType
  }));
  return publicR2Url(config, object.key);
}

export async function r2ObjectExists(config: AppConfig, client: S3Client, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.cloudflareR2Bucket, Key: key }));
    return true;
  } catch (error) {
    if (error instanceof NotFound || (error as { name?: string }).name === "NotFound") {
      return false;
    }
    throw error;
  }
}

export async function getR2Text(config: AppConfig, client: S3Client, key: string): Promise<string | null> {
  try {
    const result = await client.send(new GetObjectCommand({
      Bucket: config.cloudflareR2Bucket,
      Key: key
    }));
    return result.Body?.transformToString("utf8") ?? null;
  } catch (error) {
    if (error instanceof NoSuchKey || (error as { name?: string }).name === "NoSuchKey") {
      return null;
    }
    throw error;
  }
}

export async function deleteR2Object(config: AppConfig, client: S3Client, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: config.cloudflareR2Bucket, Key: key }));
}

export function publicR2Url(config: AppConfig, key: string): string {
  const brandedBaseUrl = config.akronPublicAssetBaseUrl.trim();
  if (brandedBaseUrl) {
    return brandedBaseUrl.replace(/\/$/, "") + publicAssetPath(key);
  }

  return config.cloudflareR2PublicBaseUrl.replace(/\/$/, "") + "/" + encodePathSegments(key);
}

export function publicAssetPath(key: string): string {
  const parts = key.split("/").filter(Boolean);

  if (key === "catalog/index.json") {
    return "/catalog/index.json";
  }

  if (parts[0] === "packs" && parts.length === 3) {
    return "/maps/" + encodePathSegments(parts.slice(1).join("/"));
  }

  if (parts[0] === "captures" && parts.length === 3) {
    const captureName = parts[2].replace(/\.webp$/i, "");
    return "/maps/" + encodePathSegments(`${parts[1]}/${captureName}/capture.webp`);
  }

  if (parts[0] === "submissions") {
    return "/submissions/" + encodePathSegments(parts.slice(1).join("/"));
  }

  return "/r2-assets/" + encodePathSegments(key);
}

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
