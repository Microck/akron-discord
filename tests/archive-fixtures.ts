export type ArchiveFixture = {
  name: string;
  entries: Record<string, unknown>;
  ok: boolean;
  section?: string;
  mapSid?: string;
  reasons?: string[];
};

const mapSid = "SpringCollab2020/1-Beginner";

export function canonicalStateForSection(section: string): Record<string, unknown> {
  if (section === "StartPos") {
    return {
      smartStartPos: false,
      respawnAtStartPos: false,
      startPosShowLabel: false,
      startPosLabelColor: 16_777_215,
      startPosLabelAnchor: "TopLeft",
      startPosLabelFormat: "Prefix",
      startPosLabelStyle: hudLabelStyle(),
      startPosMousePlacement: false,
      startPosPlacementPanelX: 8,
      startPosPlacementPanelY: 8,
      startPosPlacementPanelMinimized: false,
      startPosPreviewOpacity: 35,
      startPosConfiguredDashes: -1,
      startPosConfiguredStaminaPercent: -1,
      startPosConfiguredFacing: "Current",
      startPosConfiguredIdle: true,
      startPosConfiguredGrab: false,
      startPosSlotCount: 9
    };
  }
  if (section === "AutoKill") {
    return {
      autoKill: false,
      autoKillTimer: false,
      autoKillSeconds: 60,
      autoKillArea: false,
      autoKillShowArea: true,
      autoKillShowAreaOnDeath: false,
      autoKillDefaultAreaConditions: autoKillArea(),
      autoKillAreas: [],
      autoKillAreaX: 0,
      autoKillAreaY: 0,
      autoKillAreaWidth: 0,
      autoKillAreaHeight: 0
    };
  }
  if (section === "AutoDeafen") {
    return {
      autoDeafen: false,
      autoDeafenArea: false,
      autoDeafenShowArea: true,
      autoDeafenAreas: [],
      autoDeafenAreaX: 0,
      autoDeafenAreaY: 0,
      autoDeafenAreaWidth: 0,
      autoDeafenAreaHeight: 0
    };
  }
  if (section === "Audio") {
    return {
      audioSpeed: false,
      audioSpeedPolicy: "SyncTimescale",
      audioSpeedMultiplier: 1,
      pitchShift: false,
      pitchShiftPolicy: "Preserve",
      pitchShiftMultiplier: 1,
      soundVolumes: { music: 100 },
      soundVolumeOverrides: { music: false }
    };
  }
  if (section === "Recorder") {
    return {
      recordingContainerFormat: "Mkv", recordingReplayBufferSeconds: 0, recordingTriggerLastDeath: true,
      recordingTriggerRespawnToDeath: false, recordingTriggerRoomEntryToClear: false, recordingTriggerCheckpointClear: false,
      recordingTriggerBerryCollect: true, recordingTriggerGoldenDeath: true, recordingPreRollSeconds: 5,
      recordingPostRollSeconds: 3, recordingAudioFullMixTrack: true, recordingAudioMusicTrack: false,
      recordingAudioSfxTrack: false, recordingAudioAmbienceTrack: false, recordingRecordMutedAudio: false,
      recordingAudioFullMixLevel: 100, recordingAudioMusicLevel: 100, recordingAudioSfxLevel: 100,
      recordingAudioAmbienceLevel: 100, recordingQualityPreset: "Balanced", recordingRateControl: "Crf",
      recordingKeyframeIntervalSeconds: 2, recordingDroppedFrameWarning: true, recordingAutoRemux: true,
      recordingClipBrowserSort: "Date", recordingClipBrowserFilter: "All", recordingFramerate: 60,
      recordingEndscreenDurationSeconds: 3.4, recordingBitrateMbps: 30, recordingResolutionX: 1920,
      recordingResolutionY: 1080, recordingHidePreview: false, recordingCodec: "Libx264", recordingPreset: "Cpu"
    };
  }
  return {};
}

function autoKillArea(): Record<string, unknown> {
  return {
    x: 0, y: 0, width: 0, height: 0, speedCondition: false, minSpeed: 0, maxSpeed: 1000,
    horizontalSpeedCondition: false, minHorizontalSpeed: 0, maxHorizontalSpeed: 1000,
    verticalSpeedCondition: false, minVerticalSpeed: 0, maxVerticalSpeed: 1000,
    dashCountCondition: false, dashCount: 0, groundCondition: "Any", horizontalDirection: "Any",
    verticalDirection: "Any", playerStateCondition: false, playerState: 0, invertConditions: false
  };
}

function hudLabelStyle(): Record<string, unknown> {
  return {
    offsetX: 0, offsetY: 0, scale: 100, opacity: 100, lineSpacing: 100,
    shadow: true, shadowColor: 0, shadowOpacity: 85, shadowOffsetX: 2, shadowOffsetY: 2
  };
}

export const archiveValidationFixtures: ArchiveFixture[] = [
  {
    name: "valid StartPos setup archive",
    entries: setupArchive({
      section: "StartPos",
      setup: {
        startPositions: {
          "1": {
            room: "a-00", areaSid: mapSid, x: 48, y: 128, usesSpawnConfig: false,
            dashes: -1, staminaPercent: -1, facing: "Current", idle: true, grab: false
          }
        }
      }
    }),
    ok: true,
    section: "StartPos",
    mapSid
  },
  {
    name: "valid archive with seven fractional UTC digits",
    entries: setupArchive({
      section: "AutoKill",
      manifest: { createdAt: "2026-01-01T00:00:00.1234567Z" },
      setup: { createdUtc: "2026-01-01T00:00:00.1234567Z" }
    }),
    ok: true,
    section: "AutoKill",
    mapSid
  },
  {
    name: "archive timestamps must use a zero UTC offset",
    entries: setupArchive({
      section: "AutoKill",
      manifest: { createdAt: "2026-01-01T01:00:00.000+01:00" }
    }),
    ok: false,
    reasons: ["manifest.createdAt must be an ISO timestamp."]
  },
  {
    name: "archive timestamps reject explicit plus-zero offsets",
    entries: setupArchive({
      section: "AutoKill",
      manifest: { createdAt: "2026-01-01T00:00:00.000+00:00" }
    }),
    ok: false,
    reasons: ["manifest.createdAt must be an ISO timestamp."]
  },
  {
    name: "archive timestamps reject impossible calendar dates",
    entries: setupArchive({
      section: "AutoKill",
      manifest: { createdAt: "2026-02-29T00:00:00Z" }
    }),
    ok: false,
    reasons: ["manifest.createdAt must be an ISO timestamp."]
  },
  {
    name: "setup and manifest timestamps must match exactly",
    entries: setupArchive({
      section: "AutoKill",
      setup: { createdUtc: "2026-01-02T00:00:00.000Z" }
    }),
    ok: false,
    reasons: ["setup.createdUtc must match manifest.createdAt."]
  },
  {
    name: "valid AutoKill setup archive",
    entries: setupArchive({ section: "AutoKill" }),
    ok: true,
    section: "AutoKill",
    mapSid
  },
  {
    name: "valid AutoDeafen setup archive",
    entries: setupArchive({ section: "AutoDeafen" }),
    ok: true,
    section: "AutoDeafen",
    mapSid
  },
  {
    name: "removed profile archive contract",
    entries: {
      "manifest.json": { kind: "profile" },
      "profile.json": { format: "akron-profile-v1", section: "StartPos" }
    },
    ok: false,
    reasons: ["Archive contains unexpected file: profile.json"]
  },
  {
    name: "missing current archive and setup format markers",
    entries: {
      "manifest.json": { kind: "setup" },
      "setup.json": { section: "StartPos" }
    },
    ok: false,
    reasons: ["manifest.json is missing key: format."]
  },
  {
    name: "absolute archive path",
    entries: { "/evil.json": { bad: true } },
    ok: false,
    reasons: ["Archive contains an unsafe path."]
  },
  {
    name: "traversal archive path",
    entries: { "../evil.json": { bad: true } },
    ok: false,
    reasons: ["Archive contains an unsafe path."]
  },
  {
    name: "map-specific setup without target map SID",
    entries: setupArchive({
      section: "AutoKill",
      mapSid: ""
    }),
    ok: false,
    reasons: ["Map-specific pack is missing a target map SID."]
  },
  {
    name: "unsupported Whole setup pack",
    entries: setupArchive({ section: "Whole" }),
    ok: false,
    section: "Whole",
    reasons: ["Whole setup packs are not accepted publicly yet."]
  },
  {
    name: "PascalCase setup keys are rejected",
    entries: setupArchive({
      section: "StartPos",
      setup: { Name: "legacy" }
    }),
    ok: false,
    reasons: ["setup.json contains unknown key: Name."]
  },
  {
    name: "extra file fails fast",
    entries: {
      ...setupArchive({ section: "StartPos" }),
      "extra.json": { bad: true }
    },
    ok: false,
    reasons: ["Archive contains unexpected file: extra.json"]
  },
  {
    name: "unsupported setup payload format",
    entries: {
      ...setupArchive({ section: "StartPos" }),
      "setup.json": {
        format: "unknown-format",
        name: "Bad",
        createdUtc: "2026-01-01T00:00:00.000Z",
        section: "StartPos",
        state: {},
        startPositions: {}
      }
    },
    ok: false,
    reasons: ["setup.format must be akron-setup-v2."]
  },
  {
    name: "forbidden local path state",
    entries: setupArchive({
      section: "Recorder",
      state: { recordingOutputFolder: "/tmp/export" }
    }),
    ok: false,
    reasons: ["Config contains forbidden key: recordingOutputFolder."]
  }
];

function setupArchive(parts: {
  section: string;
  mapSid?: string;
  manifest?: Record<string, unknown>;
  state?: Record<string, unknown>;
  setup?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    "manifest.json": {
      format: "akron-archive",
      formatVersion: 1,
      kind: "setup",
      kindVersion: 1,
      createdBy: "Akron",
      createdAt: "2026-01-01T00:00:00.000Z",
      target: { game: "Celeste", mapSid: parts.mapSid ?? mapSid },
      ...parts.manifest
    },
    "setup.json": {
      format: "akron-setup-v2",
      name: `${parts.section} Test Pack`,
      createdUtc: "2026-01-01T00:00:00.000Z",
      section: parts.section,
      state: parts.state ?? canonicalStateForSection(parts.section),
      ...(parts.section === "StartPos" ? { startPositions: {} } : {}),
      ...(parts.section === "Keybinds" ? { buttonBindings: {}, menuActionBindings: {} } : {}),
      ...parts.setup
    }
  };
}

export function zipJson(entries: Record<string, unknown>): Buffer {
  return zipText(Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [name, JSON.stringify(value)])
  ));
}

export function zipText(entries: Record<string, string>): Buffer {
  const fileRecords: Array<{ name: Buffer; body: Buffer; crc: number; offset: number }> = [];
  const localParts: Buffer[] = [];
  let offset = 0;

  for (const [nameText, value] of Object.entries(entries)) {
    const name = Buffer.from(nameText);
    const body = Buffer.from(value, "utf8");
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
