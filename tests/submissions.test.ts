import { describe, expect, it } from "vitest";
import { validateAkrArchive } from "../src/submissions/archive.js";
import { normalizeMapUrl, parseSubmissionPost } from "../src/submissions/post-parser.js";
import { buildScanComponents, buildScanEmbed, buildScannedArchiveKey, hasFlaggableArchiveReason } from "../src/submissions/scanner.js";
import { formatSection, normalizeSection, sectionTag } from "../src/submissions/sections.js";

describe("submission post parsing", () => {
  it("extracts and normalizes supported GameBanana map links", () => {
    const parsed = parseSubmissionPost([
      "Map: https://www.gamebanana.com/mods/150453?foo=bar#preview",
      "Description: Beginner lobby starts."
    ].join("\n"));

    expect(parsed.mapUrl).toBe("https://gamebanana.com/mods/150453");
    expect(parsed.description).toBe("Beginner lobby starts.");
  });

  it("preserves unsupported explicit map links for validation errors", () => {
    const parsed = parseSubmissionPost("Map: https://example.com/map\nDescription: bad link");

    expect(parsed.mapUrl).toBe("https://example.com/map");
  });
});

describe("section normalization", () => {
  it("normalizes common aliases", () => {
    expect(normalizeSection("auto kill")).toBe("AutoKill");
    expect(normalizeSection("start_pos")).toBe("StartPos");
    expect(formatSection("AutoDeafen")).toBe("Auto Deafen");
    expect(sectionTag("StartPos")).toBe("startpos");
  });
});

describe("archive validation", () => {
  it("accepts a minimal scoped map-specific .akr archive", async () => {
    const buffer = zipJson({
      "manifest.json": {
        Kind: "profile",
        Target: { MapSid: "SpringCollab2020/1-Beginner" }
      },
      "profile.json": {
        Format: "akron-profile-v1",
        Name: "Beginner StartPos",
        Section: "StartPos",
        Target: { MapSid: "SpringCollab2020/1-Beginner" }
      }
    });

    const result = await validateAkrArchive(buffer);

    expect(result.ok).toBe(true);
    expect(result.section).toBe("StartPos");
    expect(result.mapSid).toBe("SpringCollab2020/1-Beginner");
    expect(result.reasons).toEqual([]);
  });

  it("rejects unsafe archive paths", async () => {
    const result = await validateAkrArchive(zipJson({ "/evil.json": { bad: true } }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Archive contains an unsafe path.");
  });

  it("rejects Whole profile packs", async () => {
    const result = await validateAkrArchive(zipJson({
      "manifest.json": { Kind: "profile" },
      "profile.json": { Format: "akron-profile-v1", Section: "Whole" }
    }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Whole profile packs are not accepted publicly yet.");
  });

  it("flags suspicious values in profile content", async () => {
    const result = await validateAkrArchive(zipJson({
      "manifest.json": { Kind: "profile" },
      "profile.json": {
        Format: "akron-profile-v1",
        Section: "Hud",
        Note: "run powershell -enc bad"
      }
    }));

    expect(result.ok).toBe(false);
    expect(result.reasons.some(reason => reason.startsWith("Config contains suspicious text:"))).toBe(true);
  });

  it("rejects extra file count and oversized text values", async () => {
    const result = await validateAkrArchive(zipJson({
      "manifest.json": { Kind: "profile" },
      "profile.json": {
        Format: "akron-profile-v1",
        Section: "Hud",
        Note: "x".repeat(10_001)
      },
      "extra.json": { bad: true }
    }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Archive contains too many files.");
    expect(result.reasons).toContain("Archive contains unexpected file: extra.json");
    expect(result.reasons).toContain("Config contains an unusually large text value.");
  });
});

describe("map URL normalization", () => {
  it("removes query strings, fragments, and www host prefix", () => {
    expect(normalizeMapUrl("https://www.gamebanana.com/mods/123?x=1#tab")).toBe("https://gamebanana.com/mods/123");
  });
});

describe("submission scan classification", () => {
  it("treats archive hardening failures as flagged reasons", () => {
    expect(hasFlaggableArchiveReason([
      "Archive contains too many files.",
      "Archive JSON payload is too large: profile.json"
    ])).toBe(true);
  });

  it("builds immutable scanned archive keys from forum, thread, and hash", () => {
    expect(buildScannedArchiveKey("StartPos Packs!", "123", "a".repeat(64))).toBe(
      `submissions/startpos-packs/123/${"a".repeat(64)}.akr`
    );
  });

  it("formats scan feedback as a validity checklist", () => {
    const embed = buildScanEmbed("Published", "StartPos", [], {
      mapUrl: "https://gamebanana.com/mods/150453",
      mapSid: "Glyph/Glyph",
      scannedArchiveUrl: "https://akron.micr.dev/submissions/startpos-packs/123/hash.akr",
      scannedArchiveSha256: "a".repeat(64),
      catalogPublished: true,
      hasAkrAttachment: true,
      hasCaptureImage: true,
      isMapCatalogSubmission: true
    }).toJSON();

    expect(embed.title).toBe("Akron Scan: Valid");
    expect(embed.color).toBe(0xfee75c);
    expect(embed.thumbnail?.url).toBe("attachment://akronleaf.png");
    expect(embed.description).toContain("**Result:** Valid");
    expect(embed.description).toContain("[x] One `.akr` attachment found");
    expect(embed.description).toContain("[x] Published to the Akron catalog");
    expect(embed.fields?.some(field => field.name === "Scanned File")).toBe(true);
  });

  it("marks invalid scan feedback as action-needed", () => {
    const embed = buildScanEmbed("Needs Fix", "StartPos", ["Attach exactly one `.akr` file."], {
      isMapCatalogSubmission: true
    }).toJSON();

    expect(embed.title).toBe("Akron Scan: Needs Fix");
    expect(embed.color).toBe(0x80848e);
    expect(embed.thumbnail?.url).toBe("attachment://akronleaf-desaturated.png");
    expect(embed.description).toContain("[ ] One `.akr` attachment found");
    expect(embed.description).toContain("[!] Action needed before this is valid");
    expect(embed.fields?.some(field => field.name === "What needs attention")).toBe(true);
  });

  it("uses the flagged leaf and red color for flagged scan feedback", () => {
    const embed = buildScanEmbed("Flagged", "StartPos", ["Archive contains an unsafe path."], {
      hasAkrAttachment: true,
      isMapCatalogSubmission: true
    }).toJSON();

    expect(embed.color).toBe(0xcf222e);
    expect(embed.thumbnail?.url).toBe("attachment://akronleaf-flagged.png");
  });

  it("labels NIM attention separately", () => {
    const embed = buildScanEmbed("Needs Moderator Review", "StartPos", ["NIM review: model could not decide."], {
      hasAkrAttachment: true,
      isMapCatalogSubmission: true
    }).toJSON();

    expect(embed.fields?.some(field => field.name === "NIM review:")).toBe(true);
  });

  it("adds notify only after a repeated failed scan", () => {
    const firstFailure = buildScanComponents("Needs Fix", false)[0]?.toJSON();
    const repeatedFailure = buildScanComponents("Needs Fix", true)[0]?.toJSON();

    expect(firstFailure?.components.map(component => "label" in component ? component.label : "")).toEqual(["Fixed", "Cancel"]);
    expect(repeatedFailure?.components.map(component => "label" in component ? component.label : "")).toEqual(["Fixed", "Cancel", "Notify"]);
    expect(buildScanComponents("Published", true)).toEqual([]);
  });
});

function zipJson(entries: Record<string, unknown>): Buffer {
  const fileRecords: Array<{ name: Buffer; body: Buffer; crc: number; offset: number }> = [];
  const localParts: Buffer[] = [];
  let offset = 0;

  for (const [nameText, value] of Object.entries(entries)) {
    const name = Buffer.from(nameText);
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, body);
    fileRecords.push({ name, body, crc, offset });
    offset += local.length + name.length + body.length;
  }

  const centralParts: Buffer[] = [];
  let centralSize = 0;
  for (const record of fileRecords) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.body.length, 20);
    central.writeUInt32LE(record.body.length, 24);
    central.writeUInt16LE(record.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(record.offset, 42);
    centralParts.push(central, record.name);
    centralSize += central.length + record.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(fileRecords.length, 8);
  end.writeUInt16LE(fileRecords.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
