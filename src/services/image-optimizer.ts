import { imageSize } from "image-size";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { imageMaxBytes } from "../submissions/types.js";

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
  if (input.bytes.length > imageMaxBytes) {
    throw new Error("Map capture exceeds 8 MB.");
  }

  const extension = allowedImageTypes.get(input.contentType);
  if (!extension) {
    throw new Error("Map capture must be PNG, JPEG, or WebP.");
  }

  const dimensions = imageSize(input.bytes);
  if (!dimensions.width || !dimensions.height) {
    throw new Error("Map capture dimensions could not be read.");
  }
  if (dimensions.width > 10000 || dimensions.height > 10000) {
    throw new Error("Map capture dimensions are too large.");
  }

  const directory = await mkdtemp(join(tmpdir(), "akron-image-"));
  try {
    const source = join(directory, "source." + extension);
    await writeFile(source, input.bytes);
    await runOptimo(source);
    const output = join(directory, "source.webp");
    return { bytes: await readFile(output), contentType: "image/webp", extension: "webp" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runOptimo(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["-y", "optimo", path, "--format", "webp", "--resize", "w1280"],
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
