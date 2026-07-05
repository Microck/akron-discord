import yauzl from "yauzl";
import { akrMaxBytes, type AkrArchiveValidation, type AkronProfileSection } from "./types.js";
import { normalizeSection } from "./sections.js";

const archiveFormat = "akron-archive";
const setupKind = "setup";
const setupFormat = "akron-setup-v1";
const allowedArchiveNames = new Set(["manifest.json", "setup.json"]);
const maxCompressionRatio = 100;
const maxJsonFileBytes = 1024 * 1024;
const maxStringValueLength = 10_000;

export async function validateAkrArchive(buffer: Buffer): Promise<AkrArchiveValidation> {
  const reasons: string[] = [];
  if (buffer.length > akrMaxBytes) {
    reasons.push("Archive exceeds 4 MiB.");
  }

  const files = await readZipJsonFiles(buffer, reasons);
  const manifest = files.get("manifest.json");
  const setup = files.get("setup.json");
  if (!manifest) {
    reasons.push("Missing manifest.json.");
  } else if (!isPlainObject(manifest)) {
    reasons.push("manifest.json must be a JSON object.");
  }
  if (!setup) {
    reasons.push("Missing setup.json.");
  } else if (!isPlainObject(setup)) {
    reasons.push("setup.json must be a JSON object.");
  }

  const manifestFormat = readString(manifest, ["format", "Format"]);
  if (isPlainObject(manifest) && manifestFormat !== archiveFormat) {
    reasons.push("manifest.format must be akron-archive.");
  }
  const manifestKind = readString(manifest, ["kind", "Kind"]);
  if (isPlainObject(manifest) && manifestKind !== setupKind) {
    reasons.push("manifest.kind must be setup.");
  }
  const setupFormatValue = readString(setup, ["format", "Format"]);
  if (isPlainObject(setup) && setupFormatValue !== setupFormat) {
    reasons.push("setup.json format must be akron-setup-v1.");
  }

  const manifestSection = normalizeSection(readString(manifest, ["section", "Section"]));
  const setupSection = normalizeSection(readString(setup, ["section", "Section"]));
  const section = setupSection ?? manifestSection;
  if (!section) {
    reasons.push("Setup section is missing or unsupported.");
  }
  if (manifestSection && setupSection && manifestSection !== setupSection) {
    reasons.push("Manifest/setup scope mismatch.");
  }
  if (section === "Whole") {
    reasons.push("Whole setup packs are not accepted publicly yet.");
  }

  const manifestMapSid = readNestedString(manifest, [["target", "Target"], ["mapSid", "MapSid"]]);
  const setupMapSid = readNestedString(setup, [["target", "Target"], ["mapSid", "MapSid"]]);
  const startPosMapSid = readStartPosMapSid(setup);
  const mapSid = setupMapSid || manifestMapSid || startPosMapSid || "";
  if (isMapSpecificSection(section) && !mapSid) {
    reasons.push("Map-specific pack is missing a target map SID.");
  }

  const suspicious = findSuspiciousValues({ manifest, setup });
  reasons.push(...suspicious);

  return {
    ok: reasons.length === 0,
    section,
    mapSid,
    manifest,
    setup,
    normalizedFacts: {
      section,
      mapSid,
      manifestFormat,
      manifestKind,
      setupName: readString(setup, ["name", "Name"]),
      setupFormat: setupFormatValue
    },
    reasons
  };
}

function readZipJsonFiles(buffer: Buffer, reasons: string[]): Promise<Map<string, unknown>> {
  return new Promise(resolve => {
    const files = new Map<string, unknown>();
    let entryCount = 0;
    let totalUncompressedSize = 0;
    let tooManyFilesReported = false;
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reasons.push(describeZipOpenError(error));
        resolve(files);
        return;
      }

      zip.readEntry();
      zip.on("entry", entry => {
        entryCount += 1;
        totalUncompressedSize += entry.uncompressedSize;
        if (entryCount > allowedArchiveNames.size && !tooManyFilesReported) {
          reasons.push("Archive contains too many files.");
          tooManyFilesReported = true;
        }
        if (totalUncompressedSize > akrMaxBytes) {
          reasons.push("Archive uncompressed payload is too large.");
          zip.close();
          resolve(files);
          return;
        }

        const name = entry.fileName;
        if (isUnsafeArchiveEntryName(name)) {
          reasons.push("Archive contains an unsafe path.");
          zip.close();
          resolve(files);
          return;
        }

        if (!allowedArchiveNames.has(name)) {
          reasons.push("Archive contains unexpected file: " + name);
        }

        if (/\.(zip|7z|rar|tar|gz)$/i.test(name)) {
          reasons.push("Nested archives are not allowed.");
        }

        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > maxCompressionRatio) {
          reasons.push("Archive has suspicious compression ratio.");
        }

        if (!allowedArchiveNames.has(name)) {
          zip.readEntry();
          return;
        }

        if (entry.uncompressedSize > maxJsonFileBytes) {
          reasons.push("Archive JSON payload is too large: " + name);
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reasons.push("Failed to read " + name + ".");
            zip.readEntry();
            return;
          }

          const chunks: Buffer[] = [];
          stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
          stream.on("end", () => {
            try {
              files.set(name, JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reasons.push(name + " is not valid JSON.");
            }
            zip.readEntry();
          });
        });
      });

      zip.on("end", () => resolve(files));
      zip.on("error", error => {
        reasons.push(describeZipOpenError(error));
        resolve(files);
      });
    });
  });
}

function isUnsafeArchiveEntryName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(name)) {
    return true;
  }

  return name.split(/[\\/]+/).includes("..");
}

function describeZipOpenError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/path|absolute|relative|invalid/i.test(message)) {
    return "Archive contains an unsafe path.";
  }
  return "Invalid zip archive.";
}

function readString(source: unknown, keys: string[]): string {
  if (!source || typeof source !== "object") {
    return "";
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function isPlainObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNestedString(source: unknown, pathOptions: string[][]): string {
  let current = source;
  for (const keys of pathOptions) {
    if (!current || typeof current !== "object") {
      return "";
    }
    const record = current as Record<string, unknown>;
    current = keys.map(key => record[key]).find(Boolean);
  }
  return typeof current === "string" ? current : "";
}

function readStartPosMapSid(setup: unknown): string {
  if (!setup || typeof setup !== "object") {
    return "";
  }

  const startPositions = (setup as Record<string, unknown>).StartPositions ?? (setup as Record<string, unknown>).startPositions;
  if (!startPositions || typeof startPositions !== "object" || Array.isArray(startPositions)) {
    return "";
  }

  const areaSids = new Set<string>();
  for (const value of Object.values(startPositions)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const areaSid = readString(value, ["areaSid", "AreaSid"]);
    if (areaSid) {
      areaSids.add(areaSid);
    }
  }

  return areaSids.size === 1 ? [...areaSids][0] : "";
}

function isMapSpecificSection(section: AkronProfileSection | undefined): boolean {
  return section === "StartPos" || section === "AutoKill" || section === "AutoDeafen";
}

function findSuspiciousValues(source: unknown): string[] {
  const reasons: string[] = [];
  const dangerous = /(token|secret|password|cmd\.exe|powershell|bash\s+-c|curl\s+|wget\s+|\/etc\/|\\AppData\\|https?:\/\/(?!(?:www\.)?gamebanana\.com))/i;

  function visit(value: unknown): void {
    if (typeof value === "string" && value.length > maxStringValueLength) {
      reasons.push("Config contains an unusually large text value.");
      return;
    }

    if (typeof value === "string" && dangerous.test(value)) {
      reasons.push("Config contains suspicious secret-like, command-like, or non-GameBanana URL text.");
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        visit(item);
      }
    }
  }

  visit(source);
  return [...new Set(reasons)];
}
