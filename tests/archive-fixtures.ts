export type ArchiveFixture = {
  name: string;
  entries: Record<string, unknown>;
  ok: boolean;
  section?: string;
  mapSid?: string;
  reasons?: string[];
};

const mapSid = "SpringCollab2020/1-Beginner";

export const archiveValidationFixtures: ArchiveFixture[] = [
  {
    name: "valid StartPos setup archive",
    entries: setupArchive({
      manifest: { Target: { MapSid: mapSid } },
      setup: { Name: "Beginner StartPos", Section: "StartPos" }
    }),
    ok: true,
    section: "StartPos",
    mapSid
  },
  {
    name: "valid AutoKill setup archive",
    entries: setupArchive({
      manifest: { Target: { MapSid: mapSid } },
      setup: { Name: "Beginner AutoKill", Section: "AutoKill" }
    }),
    ok: true,
    section: "AutoKill",
    mapSid
  },
  {
    name: "valid AutoDeafen setup archive",
    entries: setupArchive({
      manifest: { Target: { MapSid: mapSid } },
      setup: { Name: "Beginner AutoDeafen", Section: "AutoDeafen" }
    }),
    ok: true,
    section: "AutoDeafen",
    mapSid
  },
  {
    name: "removed profile archive contract",
    entries: {
      "manifest.json": { Kind: "profile" },
      "profile.json": { Format: "akron-profile-v1", Section: "StartPos" }
    },
    ok: false,
    reasons: [
      "Archive contains unexpected file: profile.json",
      "Missing setup.json.",
      "manifest.format must be akron-archive.",
      "manifest.kind must be setup."
    ]
  },
  {
    name: "missing current archive and setup format markers",
    entries: {
      "manifest.json": { Kind: "setup" },
      "setup.json": { Section: "StartPos" }
    },
    ok: false,
    reasons: [
      "manifest.format must be akron-archive.",
      "setup.json format must be akron-setup-v1."
    ]
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
      setup: { Section: "AutoKill" }
    }),
    ok: false,
    reasons: ["Map-specific pack is missing a target map SID."]
  },
  {
    name: "unsupported Whole setup pack",
    entries: setupArchive({
      setup: { Section: "Whole" }
    }),
    ok: false,
    section: "Whole",
    reasons: ["Whole setup packs are not accepted publicly yet."]
  },
  {
    name: "suspicious command text",
    entries: setupArchive({
      setup: { Section: "Hud", Note: "run powershell -enc bad" }
    }),
    ok: false,
    reasons: ["Config contains suspicious secret-like, command-like, or non-GameBanana URL text."]
  },
  {
    name: "extra file and oversized text",
    entries: {
      ...setupArchive({
        setup: { Section: "Hud", Note: "x".repeat(10_001) }
      }),
      "extra.json": { bad: true }
    },
    ok: false,
    reasons: [
      "Archive contains too many files.",
      "Archive contains unexpected file: extra.json",
      "Config contains an unusually large text value."
    ]
  },
  {
    name: "unsupported setup payload format",
    entries: {
      "manifest.json": { Format: "akron-archive", Kind: "setup" },
      "setup.json": { Format: "unknown-format", Section: "Hud" }
    },
    ok: false,
    reasons: ["setup.json format must be akron-setup-v1."]
  },
  {
    name: "manifest setup scope mismatch",
    entries: setupArchive({
      manifest: { Section: "StartPos", Target: { MapSid: mapSid } },
      setup: { Section: "AutoKill" }
    }),
    ok: false,
    section: "AutoKill",
    mapSid,
    reasons: ["Manifest/setup scope mismatch."]
  }
];

function setupArchive(parts: {
  manifest?: Record<string, unknown>;
  setup?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    "manifest.json": {
      Format: "akron-archive",
      Kind: "setup",
      ...parts.manifest
    },
    "setup.json": {
      Format: "akron-setup-v1",
      ...parts.setup
    }
  };
}

export function zipJson(entries: Record<string, unknown>): Buffer {
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
