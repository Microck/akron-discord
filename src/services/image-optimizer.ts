import { imageSize } from "image-size";
import sharp from "sharp";
import { catalogImageMaxBytes, imageSourceMaxBytes } from "../submissions/types.js";

const maxDecodedImageDimension = 32768;
const maxDecodedImagePixels = 500_000_000;

const allowedImageTypes = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"]
]);

const resizeAttempts = [
  { size: 4096, quality: 80 },
  { size: 3584, quality: 76 },
  { size: 3072, quality: 72 },
  { size: 2560, quality: 68 },
  { size: 2048, quality: 64 }
] as const;

export async function optimizeCatalogImage(input: {
  bytes: Buffer;
  contentType: string;
  fileName: string;
}): Promise<{ bytes: Buffer; contentType: string; extension: "webp" }> {
  if (input.bytes.length > imageSourceMaxBytes) {
    throw new Error(`Map capture exceeds ${imageSourceMaxBytes / 1024 / 1024} MiB.`);
  }

  const extension = allowedImageTypes.get(input.contentType);
  if (!extension) {
    throw new Error("Map capture must be PNG, JPEG, or WebP.");
  }

  const dimensions = imageSize(input.bytes);
  if (!dimensions.width || !dimensions.height) {
    throw new Error("Map capture dimensions could not be read.");
  }
  if (dimensions.width > maxDecodedImageDimension || dimensions.height > maxDecodedImageDimension) {
    throw new Error("Map capture dimensions are too large.");
  }
  if (dimensions.width * dimensions.height > maxDecodedImagePixels) {
    throw new Error("Map capture pixel count is too large.");
  }

  for (const attempt of resizeAttempts) {
    const optimized = await sharp(input.bytes, {
      limitInputPixels: maxDecodedImagePixels,
      failOn: "error"
    })
      .rotate()
      .resize({
        width: attempt.size,
        height: attempt.size,
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({
        quality: attempt.quality,
        effort: 3
      })
      .toBuffer();

    if (optimized.length <= catalogImageMaxBytes) {
      return { bytes: optimized, contentType: "image/webp", extension: "webp" };
    }
  }

  throw new Error("Optimized map capture exceeds 4 MiB.");
}
