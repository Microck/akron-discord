import { imageSize } from "image-size";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catalogImageMaxBytes, catalogImageResizeTarget, imageSourceMaxBytes } from "../submissions/types.js";

const maxDecodedImageDimension = 32768;
const maxDecodedImagePixels = 80_000_000;

const allowedImageTypes = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"]
]);

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

  const directory = await mkdtemp(join(tmpdir(), "akron-image-"));
  try {
    const source = join(directory, "source." + extension);
    await writeFile(source, input.bytes);
    await runOptimo(source);
    const output = join(directory, "source.webp");
    const optimized = await readFile(output);
    if (optimized.length > catalogImageMaxBytes) {
      throw new Error("Optimized map capture exceeds 4 MiB.");
    }

    return { bytes: optimized, contentType: "image/webp", extension: "webp" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runOptimo(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const optimoBin = resolveLocalOptimoBin();
    const child = spawn(
      optimoBin,
      [path, "--format", "webp", "--lossy", "--resize", catalogImageResizeTarget],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error("optimo failed: " + Buffer.concat(stderr).toString("utf8")));
    });
  });
}

function resolveLocalOptimoBin(): string {
  const binaryName = process.platform === "win32" ? "optimo.cmd" : "optimo";
  let current = dirname(fileURLToPath(import.meta.url));
  const root = parse(current).root;

  while (true) {
    const candidate = join(current, "node_modules", ".bin", binaryName);
    if (existsSync(candidate)) {
      return candidate;
    }

    if (current === root) {
      throw new Error("Local optimo binary not found. Run npm install before scanning catalog images.");
    }

    current = dirname(current);
  }
}
