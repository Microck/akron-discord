import { describe, expect, it } from "vitest";
import { buildPortableSetupStateExample, validateAkrArchive } from "../src/submissions/archive.js";
import { normalizeMapUrl, parseSubmissionPost } from "../src/submissions/post-parser.js";
import {
  buildScanComponents,
  buildScanEmbed,
  buildScannedArchiveKey,
  hasMalwareArchiveReason,
  isSubmissionForumName
} from "../src/submissions/scanner.js";
import { formatSection, normalizeSection, sectionTag } from "../src/submissions/sections.js";
import { archiveValidationFixtures, canonicalStateForSection, zipJson, zipText } from "./archive-fixtures.js";

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
  it.each(archiveValidationFixtures)("matches the shared archive contract: $name", async fixture => {
    const result = await validateAkrArchive(zipJson(fixture.entries));

    expect(result.ok).toBe(fixture.ok);
    if (fixture.section) {
      expect(result.section).toBe(fixture.section);
    }
    if (fixture.mapSid) {
      expect(result.mapSid).toBe(fixture.mapSid);
    }
    for (const reason of fixture.reasons ?? []) {
      expect(result.reasons).toContain(reason);
    }
  });

  it("rejects unsafe archive paths", async () => {
    const result = await validateAkrArchive(zipJson({ "/evil.json": { bad: true } }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Archive contains an unsafe path.");
  });

  it("rejects traversal archive paths", async () => {
    const result = await validateAkrArchive(zipJson({ "../evil.json": { bad: true } }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Archive contains an unsafe path.");
  });

  it("rejects nested relative archive entries as unsupported layout", async () => {
    const forwardSlash = await validateAkrArchive(zipJson({ "folder/setup.json": { bad: true } }));
    const backslash = await validateAkrArchive(zipJson({ "folder\\setup.json": { bad: true } }));

    expect(forwardSlash.ok).toBe(false);
    expect(forwardSlash.reasons).toContain("Archive contains unexpected file: folder/setup.json");
    expect(forwardSlash.reasons).not.toContain("Archive contains an unsafe path.");
    expect(backslash.ok).toBe(false);
    expect(backslash.reasons.some(reason => reason.startsWith("Archive contains unexpected file: "))).toBe(true);
    expect(backslash.reasons).not.toContain("Archive contains an unsafe path.");
  });

  it("rejects deeply nested JSON before walking config values recursively", async () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 40; depth += 1) nested = { value: nested };
    const result = await validateAkrArchive(zipJson({
      "manifest.json": nested,
      "setup.json": {}
    }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["Archive JSON exceeds the maximum nesting depth."]);
  });

  it("rejects unknown top-level and forbidden local-machine keys", async () => {
    const unknown = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({ debug: true })
    }));
    const forbidden = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, { recordingOutputFolder: "/tmp" }, "Recorder")
    }));

    expect(unknown.reasons).toEqual(["setup.json contains unknown key: debug."]);
    expect(forbidden.reasons).toEqual(["Config contains forbidden key: recordingOutputFolder."]);
  });

  it("rejects the retired setup v1 payload without a compatibility bridge", async () => {
    const result = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": { ...canonicalSetup(), format: "akron-setup-v1" }
    }));

    expect(result.reasons).toEqual(["setup.format must be akron-setup-v2."]);
  });

  it("requires the exact Akron section state and boolean audio overrides", async () => {
    const missingState = canonicalStateForSection("StartPos");
    delete missingState.smartStartPos;
    const missing = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, missingState)
    }));
    const extra = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, { ...canonicalStateForSection("StartPos"), legacyStartPos: true })
    }));
    const wrongAudioType = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, {
        ...canonicalStateForSection("Audio"),
        soundVolumeOverrides: { music: 1 }
      }, "Audio")
    }));

    expect(missing.reasons).toEqual(["setup.state is missing key: smartStartPos."]);
    expect(extra.reasons).toEqual(["setup.state contains unknown key: legacyStartPos."]);
    expect(wrongAudioType.reasons).toEqual(["setup.state.soundVolumeOverrides contains an invalid value."]);
  });

  it("rejects primitive, Int32, and nested DTO mutations that C# cannot deserialize", async () => {
    const wrongBoolean = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, { ...canonicalStateForSection("AutoKill"), autoKill: "yes" }, "AutoKill")
    }));
    const intOverflow = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, { ...canonicalStateForSection("StartPos"), startPosPlacementPanelX: 2_147_483_648 })
    }));
    const nestedStyle = canonicalStateForSection("StartPos");
    nestedStyle.startPosLabelStyle = { ...(nestedStyle.startPosLabelStyle as Record<string, unknown>), legacy: true };
    const wrongNested = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, nestedStyle)
    }));

    expect(wrongBoolean.reasons).toEqual(["setup.state.autoKill must be a boolean."]);
    expect(intOverflow.reasons).toEqual(["setup.state.startPosPlacementPanelX must be an Int32."]);
    expect(wrongNested.reasons).toEqual(["setup.state.startPosLabelStyle contains unknown key: legacy."]);
  });

  it("matches Akron's portable StartPos coordinate and spawn bounds", async () => {
    const boundaryPosition = {
      room: "a-00", areaSid: "SpringCollab2020/1-Beginner", x: 16_777_216, y: -16_777_216,
      usesSpawnConfig: true, dashes: 5, staminaPercent: 100, facing: "Right", idle: false, grab: true
    };
    const validState = { ...canonicalStateForSection("StartPos"), startPosConfiguredDashes: 5 };
    const valid = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({ startPositions: { "1": boundaryPosition } }, validState)
    }));
    const outside = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({
        startPositions: { "1": { ...boundaryPosition, x: 16_777_217 } }
      })
    }));

    expect(valid.ok).toBe(true);
    expect(outside.reasons).toEqual(["setup.startPositions.1 is invalid."]);
  });

  it.each(["01", "+1", "1e0"])("rejects non-canonical StartPos slot key %s", async slot => {
    const position = {
      room: "a-00", areaSid: "SpringCollab2020/1-Beginner", x: 0, y: 0,
      usesSpawnConfig: false, dashes: -1, staminaPercent: -1, facing: "Current", idle: false, grab: false
    };
    const result = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({ startPositions: { [slot]: position } })
    }));

    expect(result.reasons).toEqual(["setup.startPositions contains an invalid slot."]);
  });

  it("rejects duplicate keys before JSON.parse can collapse them", async () => {
    const manifest = JSON.stringify(canonicalManifest());
    const setup = JSON.stringify(canonicalSetup());
    const cases = [
      {
        manifest: manifest.replace('"format":"akron-archive"', '"format":"akron-archive","format":"akron-archive"'),
        setup,
        reason: "manifest.json contains duplicate key: format."
      },
      {
        manifest: manifest.replace('"game":"Celeste"', '"game":"Celeste","game":"Celeste"'),
        setup,
        reason: "manifest.json.target contains duplicate key: game."
      },
      {
        manifest,
        setup: setup.replace('"section":"StartPos"', '"section":"StartPos","section":"StartPos"'),
        reason: "setup.json contains duplicate key: section."
      },
      {
        manifest,
        setup: setup.replace('"smartStartPos":false', '"smartStartPos":false,"smartStartPos":false'),
        reason: "setup.json.state contains duplicate key: smartStartPos."
      },
      {
        manifest,
        setup: setup.replace('"opacity":100', '"opacity":100,"opacity":100'),
        reason: "setup.json.state.startPosLabelStyle contains duplicate key: opacity."
      }
    ];

    for (const duplicate of cases) {
      const result = await validateAkrArchive(zipText({
        "manifest.json": duplicate.manifest,
        "setup.json": duplicate.setup
      }));
      expect(result.reasons).toEqual([duplicate.reason]);
    }
  });

  it("bounds duplicate and unknown key validation before reflecting attacker text", async () => {
    const oversizedKey = "x".repeat(100_000);
    const duplicate = await validateAkrArchive(zipText({
      "manifest.json": JSON.stringify(canonicalManifest()),
      "setup.json": `{"${oversizedKey}":1,"${oversizedKey}":2}`
    }));
    const unknown = await validateAkrArchive(zipText({
      "manifest.json": JSON.stringify(canonicalManifest()),
      "setup.json": `{"${oversizedKey}":1}`
    }));

    expect(duplicate.reasons).toEqual(["setup.json contains duplicate key: <oversized>."]);
    expect(duplicate.reasons[0]?.length).toBeLessThan(128);
    expect(unknown.reasons).toEqual(["Config contains an unusually large object key."]);
  });

  it("builds contract-complete states for every public setup section", async () => {
    for (const section of ["StartPos", "AutoKill", "AutoDeafen", "Keybinds", "Audio", "Recorder", "Hud"] as const) {
      const result = await validateAkrArchive(zipJson({
        "manifest.json": canonicalManifest(),
        "setup.json": canonicalSetup({}, buildPortableSetupStateExample(section), section)
      }));
      expect(result.reasons, section).toEqual([]);
    }
  });

  it("requires canonical keybind property and enum names", async () => {
    const validBinding = { ToggleOverlay: { keys: ["F8"], buttons: ["A"], mouseButtons: ["Left"] } };
    const valid = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({ buttonBindings: validBinding, menuActionBindings: { OpenMenu: "ToggleOverlay" } }, {}, "Keybinds")
    }));
    expect(valid.ok).toBe(true);

    for (const buttonBindings of [
      { NotARealBinding: { keys: ["F8"], buttons: [], mouseButtons: [] } },
      { ToggleOverlay: { keys: ["f8"], buttons: [], mouseButtons: [] } },
      { ToggleOverlay: { keys: ["A, B"], buttons: [], mouseButtons: [] } },
      { ToggleOverlay: { keys: [999999], buttons: [], mouseButtons: [] } },
      { ToggleOverlay: { keys: ["NotAKey"], buttons: [], mouseButtons: [] } }
    ]) {
      const result = await validateAkrArchive(zipJson({
        "manifest.json": canonicalManifest(),
        "setup.json": canonicalSetup({ buttonBindings, menuActionBindings: {} }, {}, "Keybinds")
      }));
      expect(result.ok).toBe(false);
    }

    const blankMenu = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({ buttonBindings: {}, menuActionBindings: { " ": " " } }, {}, "Keybinds")
    }));
    expect(blankMenu.reasons).toEqual(["setup.menuActionBindings contains an invalid binding."]);
  });

  it("requires bounded nonblank audio keys and 0-200 volumes", async () => {
    for (const state of [
      { ...canonicalStateForSection("Audio"), soundVolumes: { music: -1 } },
      { ...canonicalStateForSection("Audio"), soundVolumes: { music: 201 } },
      { ...canonicalStateForSection("Audio"), soundVolumes: { " ": 100 } },
      { ...canonicalStateForSection("Audio"), soundVolumeOverrides: { " ": true } }
    ]) {
      const result = await validateAkrArchive(zipJson({
        "manifest.json": canonicalManifest(),
        "setup.json": canonicalSetup({}, state, "Audio")
      }));
      expect(result.ok).toBe(false);
    }
  });

  it("validates canonical nested HUD input DTO values", async () => {
    const state = buildPortableSetupStateExample("Hud");
    state.inputBoardElements = [{
      id: "jump", label: "Jump", x: 0, y: 0, width: 38, height: 38, bindings: ["Jump"], keyBindings: ["F8"],
      visible: true, fillColor: 0, pressedFillColor: 0, strokeColor: 0, textColor: 0, outlineWidth: 1, textScale: 100
    }];
    state.labelRowOrder = ["room"];
    const valid = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, state, "Hud")
    }));
    expect(valid.ok).toBe(true);

    const invalidState = structuredClone(state);
    (invalidState.inputBoardElements as Array<Record<string, unknown>>)[0]!.keyBindings = ["f8"];
    const invalid = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, invalidState, "Hud")
    }));
    expect(invalid.reasons).toEqual(["setup.state.inputBoardElements.0 contains invalid bindings."]);

    const tooManyState = structuredClone(state);
    tooManyState.inputBoardElements = Array.from({ length: 49 }, (_, index) => ({
      ...(state.inputBoardElements as Array<Record<string, unknown>>)[0],
      id: `key-${index}`
    }));
    const tooMany = await validateAkrArchive(zipJson({
      "manifest.json": canonicalManifest(),
      "setup.json": canonicalSetup({}, tooManyState, "Hud")
    }));
    expect(tooMany.reasons).toEqual(["setup.state.inputBoardElements exceeds 48 entries or is invalid."]);
  });
});

function canonicalManifest(): Record<string, unknown> {
  return {
    format: "akron-archive",
    formatVersion: 1,
    kind: "setup",
    kindVersion: 1,
    createdBy: "Akron",
    createdAt: "2026-01-01T00:00:00.000Z",
    target: { game: "Celeste", mapSid: "SpringCollab2020/1-Beginner" }
  };
}

function canonicalSetup(
  extra: Record<string, unknown> = {},
  state: Record<string, unknown> | undefined = undefined,
  section = "StartPos"
): Record<string, unknown> {
  return {
    format: "akron-setup-v2",
    name: "Test Pack",
    createdUtc: "2026-01-01T00:00:00.000Z",
    section,
    state: state ?? canonicalStateForSection(section),
    ...(section === "StartPos" ? { startPositions: {} } : {}),
    ...(section === "Keybinds" ? { buttonBindings: {}, menuActionBindings: {} } : {}),
    ...extra
  };
}

describe("map URL normalization", () => {
  it("removes query strings, fragments, and www host prefix", () => {
    expect(normalizeMapUrl("https://www.gamebanana.com/mods/123?x=1#tab")).toBe("https://gamebanana.com/mods/123");
  });
});

describe("submission scan classification", () => {
  it("scans only the general pack forums for direct Discord submissions", () => {
    expect(["keybind-packs", "hud-layouts", "audio-packs", "recorder-packs"].every(isSubmissionForumName)).toBe(true);
    expect(["startpos-packs", "auto-kill-areas", "auto-deafen-areas"].some(isSubmissionForumName)).toBe(false);
  });

  it("only treats malware-like archive findings as flagged reasons", () => {
    expect(hasMalwareArchiveReason([
      "Archive contains too many files.",
      "Archive JSON payload is too large: setup.json"
    ])).toBe(false);
    expect(hasMalwareArchiveReason([
      "Config contains suspicious text: powershell -enc bad"
    ])).toBe(true);
  });

  it("builds immutable scanned archive keys from forum, thread, and hash", () => {
    expect(buildScannedArchiveKey("StartPos Packs!", "123", "a".repeat(64))).toBe(
      `submissions/startpos-packs/123/${"a".repeat(64)}.akr`
    );
  });

  it("formats scan feedback as a validity checklist", () => {
    const embed = buildScanEmbed("Published", "Keybinds", [], {
      scannedArchiveUrl: "https://akron.micr.dev/submissions/keybind-packs/123/hash.akr",
      scannedArchiveSha256: "a".repeat(64),
      hasAkrAttachment: true,
      hasCaptureImage: true
    }).toJSON();

    expect(embed.title).toBe("Akron Scan: Valid");
    expect(embed.color).toBe(0xfee75c);
    expect(embed.thumbnail?.url).toBe("attachment://akronleaf.png");
    expect(embed.description).toContain("**Result:** Valid");
    expect(embed.description).toContain("[x] One `.akr` attachment found");
    expect(embed.description).toContain("[x] Approved public `.akr` stored");
    expect(embed.description).toContain("[-] Catalog publishing not used for Discord-only packs");
    expect(embed.fields?.some(field => field.name === "Scanned File")).toBe(true);
  });

  it("marks invalid scan feedback as action-needed", () => {
    const embed = buildScanEmbed("Needs Fix", "Keybinds", ["Attach exactly one `.akr` file."], {}).toJSON();

    expect(embed.title).toBe("Akron Scan: Needs Fix");
    expect(embed.color).toBe(0x80848e);
    expect(embed.thumbnail?.url).toBe("attachment://akronleaf-desaturated.png");
    expect(embed.description).toContain("[ ] One `.akr` attachment found");
    expect(embed.description).toContain("[!] Action needed before this is valid");
    expect(embed.fields?.some(field => field.name === "What needs attention")).toBe(true);
  });

  it("uses the flagged leaf and red color for flagged scan feedback", () => {
    const embed = buildScanEmbed("Flagged", "Keybinds", ["Archive contains an unsafe path."], {
      hasAkrAttachment: true,
      scannedArchiveSha256: "b".repeat(64)
    }).toJSON();

    expect(embed.color).toBe(0xcf222e);
    expect(embed.thumbnail?.url).toBe("attachment://akronleaf-flagged.png");
    expect(embed.description).toContain("[ ] Approved public `.akr` stored");
    expect(embed.fields?.find(field => field.name === "Scanned File")?.value)
      .toContain("Not uploaded to public R2.");
  });

  it("keeps AI review issues under the generic attention label", () => {
    const embed = buildScanEmbed("Needs Moderator Review", "Keybinds", ["model could not decide."], {
      hasAkrAttachment: true
    }).toJSON();

    expect(embed.title).toBe("Akron Scan: Needs Review");
    expect(embed.description).toContain("**Result:** Needs Review");
    expect(embed.fields?.some(field => field.name === "What needs attention")).toBe(true);
    expect(JSON.stringify(embed)).not.toContain("NIM review");
  });

  it("adds notify only after a repeated failed scan", () => {
    const firstFailure = buildScanComponents("Needs Fix", false)[0]?.toJSON();
    const repeatedFailure = buildScanComponents("Needs Fix", true)[0]?.toJSON();

    expect(firstFailure?.components.map(component => "label" in component ? component.label : "")).toEqual(["Fixed", "Cancel"]);
    expect(repeatedFailure?.components.map(component => "label" in component ? component.label : "")).toEqual(["Fixed", "Cancel", "Notify"]);
    expect(buildScanComponents("Published", true)).toEqual([]);
  });
});
