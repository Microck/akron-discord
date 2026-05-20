import yauzl from "yauzl";
import { akrMaxBytes, type AkrArchiveValidation, type AkronProfileSection } from "./types.js";
import { normalizeSection } from "./sections.js";

const allowedArchiveNames = new Set(["manifest.json", "profile.json"]);
const maxCompressionRatio = 100;
const maxJsonFileBytes = 1024 * 1024;
const maxStringValueLength = 10_000;

export async function validateAkrArchive(buffer: Buffer): Promise<AkrArchiveValidation> {
  const reasons: string[] = [];
  if (buffer.length > akrMaxBytes) {
    reasons.push("Archive exceeds 4 MB.");
  }

  const files = await readZipJsonFiles(buffer, reasons);
  const manifest = files.get("manifest.json");
  const profile = files.get("profile.json");
  if (!manifest) {
    reasons.push("Missing manifest.json.");
  } else if (!isPlainObject(manifest)) {
    reasons.push("manifest.json must be a JSON object.");
  }
  if (!profile) {
    reasons.push("Missing profile.json.");
  } else if (!isPlainObject(profile)) {
    reasons.push("profile.json must be a JSON object.");
  }

  const manifestKind = readString(manifest, ["kind", "Kind"]);
  if (manifest && manifestKind && manifestKind !== "profile") {
    reasons.push("manifest.kind must be profile.");
  }

  const manifestSection = normalizeSection(readString(manifest, ["section", "Section"]));
  const profileSection = normalizeSection(readString(profile, ["section", "Section"]));
  const section = profileSection ?? manifestSection;
  if (!section) {
    reasons.push("Profile section is missing or unsupported.");
  }
  if (manifestSection && profileSection && manifestSection !== profileSection) {
    reasons.push("Manifest/profile scope mismatch.");
  }
  if (section === "Whole") {
    reasons.push("Whole profile packs are not accepted publicly yet.");
  }

  const manifestMapSid = readNestedString(manifest, [["target", "Target"], ["mapSid", "MapSid"]]);
  const profileMapSid = readNestedString(profile, [["target", "Target"], ["mapSid", "MapSid"]]);
  const mapSid = profileMapSid || manifestMapSid || "";
  if (isMapSpecific(section) && !mapSid) {
    reasons.push("Map-specific pack is missing a target map SID.");
  }

  const suspicious = findSuspiciousValues({ manifest, profile });
  reasons.push(...suspicious);

  return {
    ok: reasons.length === 0,
    section,
    mapSid,
    manifest,
    profile,
    normalizedFacts: {
      section,
      mapSid,
      manifestKind,
      profileName: readString(profile, ["name", "Name"]),
      profileFormat: readString(profile, ["format", "Format"])
    },
    reasons
  };
}

function isMapSpecific(section: AkronProfileSection | undefined): boolean {
  return section === "StartPos" || section === "AutoKill" || section === "AutoDeafen";
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
        if (name.includes("..") || name.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(name)) {
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

function findSuspiciousValues(source: unknown): string[] {
  const reasons: string[] = [];
  const dangerous = /(token|secret|password|cmd\.exe|powershell|bash\s+-c|curl\s+|wget\s+|\/etc\/|\\AppData\\|https?:\/\/(?!(?:www\.)?gamebanana\.com))/i;

  function visit(value: unknown): void {
    if (typeof value === "string" && value.length > maxStringValueLength) {
      reasons.push("Config contains an unusually large text value.");
      return;
    }

    if (typeof value === "string" && dangerous.test(value)) {
      reasons.push("Config contains suspicious text: " + value.slice(0, 80));
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
