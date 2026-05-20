import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

export function publicR2Url(config: AppConfig, key: string): string {
  return config.cloudflareR2PublicBaseUrl.replace(/\/$/, "") + "/" + key.split("/").map(encodeURIComponent).join("/");
}
