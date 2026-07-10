import yauzl from "yauzl";
import { akrMaxBytes, type AkrArchiveValidation, type AkronProfileSection } from "./types.js";

const allowedArchiveNames = new Set(["manifest.json", "setup.json"]);
const archiveFormat = "akron-archive";
const setupFormat = "akron-setup-v2";
const maxCompressionRatio = 100;
const maxJsonFileBytes = 1024 * 1024;
const maxJsonDepth = 32;
const maxJsonNodes = 10_000;
const maxStringValueLength = 10_000;
const maxPortableStartPosCoordinate = 16_777_216;

const manifestKeys = new Set(["format", "formatVersion", "kind", "kindVersion", "createdBy", "createdAt", "target"]);
const manifestTargetKeys = new Set(["game", "mapSid"]);
const baseSetupKeys = new Set(["format", "name", "createdUtc", "section", "state"]);
const canonicalSections = new Set<AkronProfileSection>([
  "StartPos", "AutoKill", "AutoDeafen", "Keybinds", "Audio", "Recorder", "Hud", "Whole"
]);
const forbiddenKeys = new Set([
  "recordingOutputFolder",
  "recordingColorspaceArgs",
  "recordingReplayAutoStart",
  "screenshotScannerExportPath",
  "audioSplitterMainDevice",
  "audioSplitterMusicDevice",
  "audioSplitterSfxDevice"
]);
const hudStateKeys = new Set(`
  roomLabels labelSystemVisible roomLabelColor staminaWidget speedWidget dashWidget inputViewer inputHistoryTextColor
  inputHistoryEventColor showTaps tapDisplayCorner tapDisplayScale tapDisplayOpacity inputBoardSource inputBoardLabelPreset
  inputBoardElements inputsPerSecondCounter inputsPerSecondPlacement inputsPerSecondScale inputsPerSecondOpacity
  inputsPerSecondTextColor inputsPerSecondShowTotal inputsPerSecondShowMax inputsPerSecondCountMovement inputsPerSecondCountActions
  inputsPerSecondCountMenu roomTimerWidget roomTimerColor roomStatTracker roomStatTrackerColor roomStatShowRoomName
  roomStatShowDeaths roomStatShowInGameTime roomStatShowStrawberries roomStatShowAliveTime roomStatHideIfGolden
  roomStatTimerFreezeMode deathStatsWidget deathStatsFormat deathStatsVisibility deathStatsColor resourceStaminaBar staminaBar
  staminaBarPlayer staminaBarHud staminaBarPlayerPosition staminaBarHudPosition staminaBarStyle staminaPlayerOffsetX staminaPlayerOffsetY
  staminaPlayerScale staminaAlwaysVisible staminaShowDangerMarker staminaShowChangePulse staminaShowOverflow staminaHideWhilePaused
  staminaHudOffsetX staminaHudOffsetY staminaNormalColor staminaLowColor staminaFillColor staminaLineColor staminaOverflowColor dashBar
  dashBarPlayer dashBarHud dashBarPlayerPosition dashBarHudPosition dashBarStyle dashBarPlayerOffsetX dashBarPlayerOffsetY
  dashBarPlayerScale dashBarAlwaysVisible dashBarShowText dashBarShowEmptyPips dashBarHideWhilePaused dashBarHudOffsetX dashBarHudOffsetY
  dashBarAvailableColor dashBarEmptyColor dashBarFillColor dashBarLineColor dashBarLowColor dashNumber dashNumberOffsetY dashNumberColor
  dashNumberOutlineColor dashNumberOpacity speedNumber speedNumberMode speedNumberOffsetY speedNumberColor speedNumberOutlineColor
  speedNumberOpacity totalAttemptsWidget totalAttemptsColor statusLabelsWidget statusLabelsColor toastLabels toastLabelColor
  toastLabelAnchor noShortNumbers hideVanillaHud hideAkronHud customHudLabels customHudLabelsInNonLevelScenes customHudLabelPadding
  customHudLabelGap customHudLabelObstructionEnabled customHudLabelObstructionMode customHudLabelObstructedOpacity
  customHudLabelObstructionPaddingPixels customHudLabelObstructionOnlyOverlappedLabel customHudLabelObstructedAnchor
  customHudLabelObstructedOffsetX customHudLabelObstructedOffsetY customHudLabelIndex customHudLabelDefinitions labelRowOrder
  labelBulkStyle roomLabelStyle inputHistoryLabelStyle inputsPerSecondLabelStyle startPosLabelStyle roomTimerLabelStyle
  deathStatsLabelStyle totalAttemptsLabelStyle statusLabelsLabelStyle toastLabelStyle hudCheatIndicator hudCheatIndicatorOnlyFlagged
  hudCheatIndicatorScale hudCheatIndicatorOpacity hudCheatIndicatorAnchor hudCheatIndicatorStyle
`.trim().split(/\s+/));

const stateKeysBySection: Record<Exclude<AkronProfileSection, "Whole">, ReadonlySet<string>> = {
  StartPos: new Set([
    "smartStartPos", "respawnAtStartPos", "startPosShowLabel", "startPosLabelColor", "startPosLabelAnchor",
    "startPosLabelFormat", "startPosLabelStyle", "startPosMousePlacement", "startPosPlacementPanelX",
    "startPosPlacementPanelY", "startPosPlacementPanelMinimized", "startPosPreviewOpacity", "startPosConfiguredDashes",
    "startPosConfiguredStaminaPercent", "startPosConfiguredFacing", "startPosConfiguredIdle", "startPosConfiguredGrab",
    "startPosSlotCount"
  ]),
  AutoKill: new Set([
    "autoKill", "autoKillTimer", "autoKillSeconds", "autoKillArea", "autoKillShowArea", "autoKillShowAreaOnDeath",
    "autoKillDefaultAreaConditions", "autoKillAreas", "autoKillAreaX", "autoKillAreaY", "autoKillAreaWidth", "autoKillAreaHeight"
  ]),
  AutoDeafen: new Set([
    "autoDeafen", "autoDeafenArea", "autoDeafenShowArea", "autoDeafenAreas", "autoDeafenAreaX",
    "autoDeafenAreaY", "autoDeafenAreaWidth", "autoDeafenAreaHeight"
  ]),
  Keybinds: new Set(),
  Audio: new Set([
    "audioSpeed", "audioSpeedPolicy", "audioSpeedMultiplier", "pitchShift", "pitchShiftPolicy", "pitchShiftMultiplier",
    "soundVolumes", "soundVolumeOverrides"
  ]),
  Recorder: new Set([
    "recordingContainerFormat", "recordingReplayBufferSeconds", "recordingTriggerLastDeath", "recordingTriggerRespawnToDeath",
    "recordingTriggerRoomEntryToClear", "recordingTriggerCheckpointClear", "recordingTriggerBerryCollect", "recordingTriggerGoldenDeath",
    "recordingPreRollSeconds", "recordingPostRollSeconds", "recordingAudioFullMixTrack", "recordingAudioMusicTrack",
    "recordingAudioSfxTrack", "recordingAudioAmbienceTrack", "recordingRecordMutedAudio", "recordingAudioFullMixLevel",
    "recordingAudioMusicLevel", "recordingAudioSfxLevel", "recordingAudioAmbienceLevel", "recordingQualityPreset",
    "recordingRateControl", "recordingKeyframeIntervalSeconds", "recordingDroppedFrameWarning", "recordingAutoRemux",
    "recordingClipBrowserSort", "recordingClipBrowserFilter", "recordingFramerate", "recordingEndscreenDurationSeconds",
    "recordingBitrateMbps", "recordingResolutionX", "recordingResolutionY", "recordingHidePreview", "recordingCodec",
    "recordingPreset"
  ]),
  Hud: hudStateKeys
};

const setupCollectionKeys: Partial<Record<AkronProfileSection, readonly string[]>> = {
  StartPos: ["startPositions"],
  Keybinds: ["buttonBindings", "menuActionBindings"]
};

const booleanStateKeys: Partial<Record<AkronProfileSection, ReadonlySet<string>>> = {
  StartPos: new Set(["smartStartPos", "respawnAtStartPos", "startPosShowLabel", "startPosMousePlacement", "startPosPlacementPanelMinimized", "startPosConfiguredIdle", "startPosConfiguredGrab"]),
  AutoKill: new Set(["autoKill", "autoKillTimer", "autoKillArea", "autoKillShowArea", "autoKillShowAreaOnDeath"]),
  AutoDeafen: new Set(["autoDeafen", "autoDeafenArea", "autoDeafenShowArea"]),
  Audio: new Set(["audioSpeed", "pitchShift"]),
  Recorder: new Set([
    "recordingTriggerLastDeath", "recordingTriggerRespawnToDeath", "recordingTriggerRoomEntryToClear", "recordingTriggerCheckpointClear",
    "recordingTriggerBerryCollect", "recordingTriggerGoldenDeath", "recordingAudioFullMixTrack", "recordingAudioMusicTrack",
    "recordingAudioSfxTrack", "recordingAudioAmbienceTrack", "recordingRecordMutedAudio", "recordingDroppedFrameWarning",
    "recordingAutoRemux", "recordingHidePreview"
  ]),
  Hud: new Set(`
    roomLabels labelSystemVisible staminaWidget speedWidget dashWidget inputViewer showTaps inputsPerSecondCounter
    inputsPerSecondShowTotal inputsPerSecondShowMax inputsPerSecondCountMovement inputsPerSecondCountActions inputsPerSecondCountMenu
    roomTimerWidget roomStatTracker roomStatShowRoomName roomStatShowDeaths roomStatShowInGameTime roomStatShowStrawberries
    roomStatShowAliveTime roomStatHideIfGolden deathStatsWidget resourceStaminaBar staminaBar staminaBarPlayer staminaBarHud
    staminaAlwaysVisible staminaShowDangerMarker staminaShowChangePulse staminaShowOverflow staminaHideWhilePaused dashBar dashBarPlayer
    dashBarHud dashBarAlwaysVisible dashBarShowText dashBarShowEmptyPips dashBarHideWhilePaused dashNumber speedNumber
    totalAttemptsWidget statusLabelsWidget toastLabels noShortNumbers hideVanillaHud hideAkronHud customHudLabels
    customHudLabelsInNonLevelScenes customHudLabelObstructionEnabled customHudLabelObstructionOnlyOverlappedLabel hudCheatIndicator
    hudCheatIndicatorOnlyFlagged
  `.trim().split(/\s+/))
};

const integerStateKeys: Partial<Record<AkronProfileSection, ReadonlySet<string>>> = {
  StartPos: new Set(["startPosLabelColor", "startPosPlacementPanelX", "startPosPlacementPanelY", "startPosPreviewOpacity", "startPosConfiguredDashes", "startPosConfiguredStaminaPercent", "startPosSlotCount"]),
  AutoKill: new Set(["autoKillSeconds", "autoKillAreaX", "autoKillAreaY", "autoKillAreaWidth", "autoKillAreaHeight"]),
  AutoDeafen: new Set(["autoDeafenAreaX", "autoDeafenAreaY", "autoDeafenAreaWidth", "autoDeafenAreaHeight"]),
  Recorder: new Set([
    "recordingReplayBufferSeconds", "recordingPreRollSeconds", "recordingPostRollSeconds", "recordingAudioFullMixLevel",
    "recordingAudioMusicLevel", "recordingAudioSfxLevel", "recordingAudioAmbienceLevel", "recordingKeyframeIntervalSeconds",
    "recordingFramerate", "recordingBitrateMbps", "recordingResolutionX", "recordingResolutionY"
  ]),
  Hud: new Set(`
    roomLabelColor inputHistoryTextColor inputHistoryEventColor tapDisplayScale tapDisplayOpacity inputsPerSecondScale
    inputsPerSecondOpacity inputsPerSecondTextColor roomTimerColor roomStatTrackerColor deathStatsColor staminaPlayerOffsetX
    staminaPlayerOffsetY staminaPlayerScale staminaHudOffsetX staminaHudOffsetY staminaNormalColor staminaLowColor staminaFillColor
    staminaLineColor staminaOverflowColor dashBarPlayerOffsetX dashBarPlayerOffsetY dashBarPlayerScale dashBarHudOffsetX dashBarHudOffsetY
    dashBarAvailableColor dashBarEmptyColor dashBarFillColor dashBarLineColor dashBarLowColor dashNumberOffsetY dashNumberColor
    dashNumberOutlineColor dashNumberOpacity speedNumberOffsetY speedNumberColor speedNumberOutlineColor speedNumberOpacity
    totalAttemptsColor statusLabelsColor toastLabelColor customHudLabelPadding customHudLabelGap customHudLabelObstructedOpacity
    customHudLabelObstructionPaddingPixels customHudLabelObstructedOffsetX customHudLabelObstructedOffsetY customHudLabelIndex
    hudCheatIndicatorScale hudCheatIndicatorOpacity
  `.trim().split(/\s+/))
};

const stateEnumValues: Record<string, ReadonlySet<string>> = {
  startPosLabelAnchor: new Set(["TopLeft", "TopCenter", "TopRight", "MiddleLeft", "Center", "MiddleRight", "BottomLeft", "BottomCenter", "BottomRight", "Absolute"]),
  startPosLabelFormat: new Set(["Prefix", "CountOnly", "SlotAndCount"]),
  startPosConfiguredFacing: new Set(["Current", "Left", "Right"]),
  audioSpeedPolicy: new Set(["Normal", "SyncTimescale", "Independent"]),
  pitchShiftPolicy: new Set(["Preserve", "FollowSpeed", "Independent"]),
  recordingContainerFormat: new Set(["Mkv", "Mp4", "Mov", "WebM"]),
  recordingQualityPreset: new Set(["LowImpact", "Balanced", "HighQuality", "Lossless"]),
  recordingRateControl: new Set(["Cbr", "Vbr", "Cqp", "Crf", "Lossless"]),
  recordingClipBrowserSort: new Set(["Date", "Chapter", "Room", "Death", "Clear", "Pb", "Favorite"]),
  recordingClipBrowserFilter: new Set(["All", "Chapter", "Room", "Death", "Clear", "Pb", "Favorite"]),
  recordingCodec: new Set(["Libx264", "H264Nvenc", "H264Amf", "HevcNvenc", "LibVpxVp9"]),
  recordingPreset: new Set(["Cpu", "Nvidia", "Amd"]),
  tapDisplayCorner: new Set(["TopLeft", "TopRight", "BottomLeft", "BottomRight"]),
  inputBoardSource: new Set(["GameActions", "KeyboardKeys"]),
  inputBoardLabelPreset: new Set(["Short", "Names", "Keyboard", "Arrows"]),
  inputsPerSecondPlacement: new Set(["Left", "Right"]),
  roomStatTimerFreezeMode: new Set(["Never", "Paused", "Inactive", "Cutscene", "PausedOrInactive", "PausedInactiveOrCutscene"]),
  deathStatsVisibility: new Set(["Disabled", "AfterDeath", "InMenu", "AfterDeathAndInMenu", "Always"]),
  staminaBarPlayerPosition: new Set(["Above", "Below"]),
  dashBarPlayerPosition: new Set(["Above", "Below"]),
  staminaBarHudPosition: new Set(["TopLeft", "TopCenter", "TopRight", "BottomRight", "BottomCenter", "BottomLeft"]),
  dashBarHudPosition: new Set(["TopLeft", "TopCenter", "TopRight", "BottomRight", "BottomCenter", "BottomLeft"]),
  staminaBarStyle: new Set(["Bar", "Ring"]),
  dashBarStyle: new Set(["Pips", "Bar"]),
  speedNumberMode: new Set(["Total", "Horizontal", "Vertical"]),
  toastLabelAnchor: new Set(["TopLeft", "TopCenter", "TopRight", "MiddleLeft", "Center", "MiddleRight", "BottomLeft", "BottomCenter", "BottomRight", "Absolute"]),
  customHudLabelObstructedAnchor: new Set(["TopLeft", "TopCenter", "TopRight", "MiddleLeft", "Center", "MiddleRight", "BottomLeft", "BottomCenter", "BottomRight", "Absolute"]),
  hudCheatIndicatorAnchor: new Set(["TopLeft", "TopCenter", "TopRight", "MiddleLeft", "Center", "MiddleRight", "BottomLeft", "BottomCenter", "BottomRight", "Absolute"]),
  customHudLabelObstructionMode: new Set(["Off", "Fade", "Move"]),
  hudCheatIndicatorStyle: new Set(["Text", "Dot"])
};
const keybindPropertyNames = new Set([
  "ToggleOverlay", "FastLookoutHold", "Retry", "ReloadRoom", "OpenDebugMap", "ReloadChapter", "SaveState",
  "LoadState", "PreviousSlot", "NextSlot", "CycleGrabMode", "FreezeGameplay", "StepFrame", "DecreaseTimescale",
  "IncreaseTimescale", "SetStartPos", "LoadStartPos", "ClearStartPos", "PreviousStartPos", "NextStartPos",
  "LoadStartPosSlot1", "LoadStartPosSlot2", "LoadStartPosSlot3", "LoadStartPosSlot4", "LoadStartPosSlot5",
  "LoadStartPosSlot6", "LoadStartPosSlot7", "LoadStartPosSlot8", "LoadStartPosSlot9", "ToggleHitboxes",
  "ToggleEntityInspector", "EntityInspectorCursorHold", "ToggleFrameBypass", "CycleFrameBypassCameraSmoothing",
  "ClickTeleportCursor", "CursorZoomHold", "CursorToolsHold"
]);
const keyboardKeyNames = new Set([
  "None", "Back", "Tab", "Enter", "CapsLock", "Escape", "Space", "PageUp", "PageDown", "End", "Home",
  "Left", "Up", "Right", "Down", "Select", "Print", "Execute", "PrintScreen", "Insert", "Delete", "Help",
  ...Array.from({ length: 10 }, (_, index) => `D${index}`),
  ...Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)),
  "LeftWindows", "RightWindows", "Apps", "Sleep",
  ...Array.from({ length: 10 }, (_, index) => `NumPad${index}`),
  "Multiply", "Add", "Separator", "Subtract", "Decimal", "Divide",
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  "NumLock", "Scroll", "LeftShift", "RightShift", "LeftControl", "RightControl", "LeftAlt", "RightAlt",
  "BrowserBack", "BrowserForward", "BrowserRefresh", "BrowserStop", "BrowserSearch", "BrowserFavorites", "BrowserHome",
  "VolumeMute", "VolumeDown", "VolumeUp", "MediaNextTrack", "MediaPreviousTrack", "MediaStop", "MediaPlayPause",
  "LaunchMail", "SelectMedia", "LaunchApplication1", "LaunchApplication2", "OemSemicolon", "OemPlus", "OemComma",
  "OemMinus", "OemPeriod", "OemQuestion", "OemTilde", "OemOpenBrackets", "OemPipe", "OemCloseBrackets",
  "OemQuotes", "Oem8", "OemBackslash", "ProcessKey", "Attn", "Crsel", "Exsel", "EraseEof", "Play", "Zoom",
  "Pa1", "OemClear", "ChatPadGreen", "ChatPadOrange", "Pause", "ImeConvert", "ImeNoConvert", "Kana", "Kanji",
  "OemAuto", "OemCopy", "OemEnlW"
]);
const controllerButtonNames = new Set([
  "DPadUp", "DPadDown", "DPadLeft", "DPadRight", "Start", "Back", "LeftStick", "RightStick", "LeftShoulder",
  "RightShoulder", "BigButton", "A", "B", "X", "Y", "LeftThumbstickLeft", "RightTrigger", "LeftTrigger",
  "RightThumbstickUp", "RightThumbstickDown", "RightThumbstickRight", "RightThumbstickLeft", "LeftThumbstickUp",
  "LeftThumbstickDown", "LeftThumbstickRight", "Misc1EXT", "Paddle1EXT", "Paddle2EXT", "Paddle3EXT",
  "Paddle4EXT", "TouchPadEXT"
]);
const mouseButtonNames = new Set(["Left", "Right", "Middle", "XButton1", "XButton2"]);
const inputBoardBindingNames = new Set([
  "Left", "Right", "Up", "Down", "Jump", "Dash", "Grab", "CrouchDash", "Talk", "Pause", "Confirm", "Cancel"
]);

export function buildPortableSetupStateExample(
  section: Exclude<AkronProfileSection, "Whole">
): Record<string, unknown> {
  const state: Record<string, unknown> = Object.fromEntries([...stateKeysBySection[section]].map(key => [key, 0]));
  for (const key of booleanStateKeys[section] ?? []) state[key] = false;
  for (const key of stateKeysBySection[section]) {
    const firstEnumValue = stateEnumValues[key]?.values().next().value;
    if (firstEnumValue !== undefined) state[key] = firstEnumValue;
  }

  if (section === "StartPos") {
    Object.assign(state, {
      startPosLabelStyle: defaultHudLabelStyle(),
      startPosConfiguredDashes: -1,
      startPosConfiguredStaminaPercent: -1,
      startPosSlotCount: 9
    });
  } else if (section === "AutoKill") {
    Object.assign(state, { autoKillDefaultAreaConditions: defaultAutoKillArea(), autoKillAreas: [] });
  } else if (section === "AutoDeafen") {
    state.autoDeafenAreas = [];
  } else if (section === "Audio") {
    Object.assign(state, {
      audioSpeedMultiplier: 1,
      pitchShiftMultiplier: 1,
      soundVolumes: {},
      soundVolumeOverrides: {}
    });
  } else if (section === "Recorder") {
    Object.assign(state, {
      recordingEndscreenDurationSeconds: 0,
      recordingFramerate: 60,
      recordingBitrateMbps: 30,
      recordingResolutionX: 1920,
      recordingResolutionY: 1080
    });
  } else if (section === "Hud") {
    Object.assign(state, {
      deathStatsFormat: "{deaths}",
      inputBoardElements: [],
      customHudLabelDefinitions: [],
      labelRowOrder: []
    });
    for (const key of [
      "labelBulkStyle", "roomLabelStyle", "inputHistoryLabelStyle", "inputsPerSecondLabelStyle", "startPosLabelStyle",
      "roomTimerLabelStyle", "deathStatsLabelStyle", "totalAttemptsLabelStyle", "statusLabelsLabelStyle", "toastLabelStyle"
    ]) {
      state[key] = defaultHudLabelStyle();
    }
  }
  return state;
}

function defaultHudLabelStyle(): Record<string, unknown> {
  return {
    offsetX: 0,
    offsetY: 0,
    scale: 100,
    opacity: 100,
    lineSpacing: 100,
    shadow: true,
    shadowColor: 0,
    shadowOpacity: 85,
    shadowOffsetX: 2,
    shadowOffsetY: 2
  };
}

function defaultAutoKillArea(): Record<string, unknown> {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    speedCondition: false,
    minSpeed: 0,
    maxSpeed: 1000,
    horizontalSpeedCondition: false,
    minHorizontalSpeed: 0,
    maxHorizontalSpeed: 1000,
    verticalSpeedCondition: false,
    minVerticalSpeed: 0,
    maxVerticalSpeed: 1000,
    dashCountCondition: false,
    dashCount: 0,
    groundCondition: "Any",
    horizontalDirection: "Any",
    verticalDirection: "Any",
    playerStateCondition: false,
    playerState: 0,
    invertConditions: false
  };
}

export async function validateAkrArchive(buffer: Buffer): Promise<AkrArchiveValidation> {
  if (buffer.length > akrMaxBytes) {
    return invalid("Archive exceeds 4 MiB.");
  }

  const archive = await readZipJsonFiles(buffer);
  if (archive.reason) {
    return invalid(archive.reason);
  }
  const manifest = archive.files.get("manifest.json");
  const setup = archive.files.get("setup.json");
  if (!manifest) {
    return invalid("Missing manifest.json.");
  }
  if (!setup) {
    return invalid("Missing setup.json.");
  }
  if (!isPlainObject(manifest)) {
    return invalid("manifest.json must be a JSON object.");
  }
  if (!isPlainObject(setup)) {
    return invalid("setup.json must be a JSON object.");
  }

  const budgetReason = validateJsonBudget({ manifest, setup });
  if (budgetReason) {
    return invalid(budgetReason, manifest, setup);
  }
  const forbidden = findForbiddenKey({ manifest, setup });
  if (forbidden) {
    return invalid(`Config contains forbidden key: ${forbidden}.`, manifest, setup);
  }

  const manifestReason = validateManifest(manifest);
  if (manifestReason) {
    return invalid(manifestReason, manifest, setup);
  }
  const sectionValue = setup.section;
  const section = typeof sectionValue === "string" && canonicalSections.has(sectionValue as AkronProfileSection)
    ? sectionValue as AkronProfileSection
    : undefined;
  if (!section) {
    return invalid("setup.section is missing or unsupported.", manifest, setup);
  }
  if (section === "Whole") {
    return invalid("Whole setup packs are not accepted publicly yet.", manifest, setup, section);
  }
  const mapSid = typeof (manifest.target as Record<string, unknown>).mapSid === "string"
    ? (manifest.target as Record<string, unknown>).mapSid as string
    : "";
  const setupReason = validateSetup(setup, section, mapSid);
  if (setupReason) {
    return invalid(setupReason, manifest, setup, section, mapSid);
  }
  if (setup.createdUtc !== manifest.createdAt) {
    return invalid("setup.createdUtc must match manifest.createdAt.", manifest, setup, section, mapSid);
  }
  if (isMapSpecificSection(section) && !mapSid.trim()) {
    return invalid("Map-specific pack is missing a target map SID.", manifest, setup, section);
  }

  return {
    ok: true,
    section,
    mapSid,
    manifest,
    setup,
    normalizedFacts: {
      section,
      mapSid,
      manifestFormat: manifest.format,
      manifestKind: manifest.kind,
      setupName: setup.name,
      setupFormat: setup.format
    },
    reasons: []
  };
}

function validateManifest(manifest: Record<string, unknown>): string | undefined {
  const keysReason = validateExactKeys(manifest, manifestKeys, manifestKeys, "manifest.json");
  if (keysReason) return keysReason;
  if (manifest.format !== archiveFormat) return "manifest.format must be akron-archive.";
  if (manifest.formatVersion !== 1) return "manifest.formatVersion must be 1.";
  if (manifest.kind !== "setup") return "manifest.kind must be setup.";
  if (manifest.kindVersion !== 1) return "manifest.kindVersion must be 1.";
  if (manifest.createdBy !== "Akron") return "manifest.createdBy must be Akron.";
  if (!isIsoDate(manifest.createdAt)) return "manifest.createdAt must be an ISO timestamp.";
  if (!isPlainObject(manifest.target)) return "manifest.target must be an object.";
  const targetReason = validateExactKeys(manifest.target, manifestTargetKeys, manifestTargetKeys, "manifest.target");
  if (targetReason) return targetReason;
  if (manifest.target.game !== "Celeste") return "manifest.target.game must be Celeste.";
  if (typeof manifest.target.mapSid !== "string" || manifest.target.mapSid.length > 256) return "manifest.target.mapSid is invalid.";
  return undefined;
}

function validateSetup(
  setup: Record<string, unknown>,
  section: Exclude<AkronProfileSection, "Whole">,
  mapSid: string
): string | undefined {
  const allowed = new Set([...baseSetupKeys, ...(setupCollectionKeys[section] ?? [])]);
  const keysReason = validateExactKeys(setup, allowed, allowed, "setup.json");
  if (keysReason) return keysReason;
  if (setup.format !== setupFormat) return "setup.format must be akron-setup-v2.";
  if (readRequiredBoundedString(setup, "name", 256) === undefined) return "setup.name is invalid.";
  if (!isIsoDate(setup.createdUtc)) return "setup.createdUtc must be an ISO timestamp.";
  if (!isPlainObject(setup.state)) return "setup.state must be an object.";

  const stateReason = validateExactKeys(setup.state, stateKeysBySection[section], stateKeysBySection[section], "setup.state");
  if (stateReason) return stateReason;
  const typeReason = validateStateTypes(setup.state, section);
  if (typeReason) return typeReason;
  const semanticReason = validateSectionState(setup.state, section);
  if (semanticReason) return semanticReason;

  if (section === "StartPos") return validateStartPositions(setup.startPositions, mapSid);
  if (section === "Keybinds") return validateBindings(setup.buttonBindings, setup.menuActionBindings);
  return undefined;
}

function validateStateTypes(state: Record<string, unknown>, section: Exclude<AkronProfileSection, "Whole">): string | undefined {
  for (const key of booleanStateKeys[section] ?? []) {
    if (typeof state[key] !== "boolean") return `setup.state.${key} must be a boolean.`;
  }
  for (const key of integerStateKeys[section] ?? []) {
    if (!isInt32(state[key])) return `setup.state.${key} must be an Int32.`;
  }
  for (const key of stateKeysBySection[section]) {
    const enumValues = stateEnumValues[key];
    if (enumValues && (typeof state[key] !== "string" || !enumValues.has(state[key] as string))) {
      return `setup.state.${key} is not a recognized value.`;
    }
  }

  if (section === "StartPos") {
    const styleReason = validateHudLabelStyle(state.startPosLabelStyle, "startPosLabelStyle");
    if (styleReason) return styleReason;
    if (!isFiniteNumberInRange(state.startPosPreviewOpacity, 0, 100) ||
        !isFiniteNumberInRange(state.startPosConfiguredDashes, -1, 5) ||
        !isFiniteNumberInRange(state.startPosConfiguredStaminaPercent, -1, 100) ||
        !isFiniteNumberInRange(state.startPosSlotCount, 1, 99)) return "setup.state StartPos values are outside the public range.";
  }
  if (section === "AutoKill") {
    if (!isPlainObject(state.autoKillDefaultAreaConditions)) return "setup.state.autoKillDefaultAreaConditions must be an object.";
    const reason = validateAreaEntry(state.autoKillDefaultAreaConditions, "autoKillDefaultAreaConditions", true);
    if (reason) return reason;
    if ((state.autoKillAreaWidth as number) < 0 || (state.autoKillAreaHeight as number) < 0 || (state.autoKillSeconds as number) < 0) {
      return "setup.state AutoKill values are outside the public range.";
    }
  }
  if (section === "AutoDeafen") {
    if ((state.autoDeafenAreaWidth as number) < 0 || (state.autoDeafenAreaHeight as number) < 0) {
      return "setup.state AutoDeafen values are outside the public range.";
    }
  }
  if (section === "Audio") {
    if (!isFiniteNumberInRange(state.audioSpeedMultiplier, 0.1, 4) ||
        !isFiniteNumberInRange(state.pitchShiftMultiplier, 0.1, 4)) return "setup.state audio multipliers are invalid.";
  }
  if (section === "Recorder" && !Number.isFinite(state.recordingEndscreenDurationSeconds)) {
    return "setup.state.recordingEndscreenDurationSeconds must be a number.";
  }
  if (section === "Hud") {
    if (typeof state.deathStatsFormat !== "string" || state.deathStatsFormat.length > 10_000) return "setup.state.deathStatsFormat is invalid.";
    for (const key of [
      "labelBulkStyle", "roomLabelStyle", "inputHistoryLabelStyle", "inputsPerSecondLabelStyle", "startPosLabelStyle",
      "roomTimerLabelStyle", "deathStatsLabelStyle", "totalAttemptsLabelStyle", "statusLabelsLabelStyle", "toastLabelStyle"
    ]) {
      const styleReason = validateHudLabelStyle(state[key], key);
      if (styleReason) return styleReason;
    }
    if (!Array.isArray(state.inputBoardElements) ||
        !Array.isArray(state.customHudLabelDefinitions) ||
        !Array.isArray(state.labelRowOrder) || !state.labelRowOrder.every(value => isNonblankBoundedString(value, 128))) {
      return "setup.state HUD collections are invalid.";
    }
    for (const [index, element] of state.inputBoardElements.entries()) {
      const reason = validateInputBoardElement(element, index);
      if (reason) return reason;
    }
    for (const [index, label] of state.customHudLabelDefinitions.entries()) {
      const reason = validateCustomHudLabel(label, index);
      if (reason) return reason;
    }
    for (const key of ["tapDisplayOpacity", "inputsPerSecondOpacity", "dashNumberOpacity", "speedNumberOpacity", "customHudLabelObstructedOpacity", "hudCheatIndicatorOpacity"]) {
      if (!isFiniteNumberInRange(state[key], 0, 100)) return `setup.state.${key} is outside the public range.`;
    }
  }
  return undefined;
}

function validateHudLabelStyle(value: unknown, name: string): string | undefined {
  if (!isPlainObject(value)) return `setup.state.${name} must be an object.`;
  const keys = new Set(["offsetX", "offsetY", "scale", "opacity", "lineSpacing", "shadow", "shadowColor", "shadowOpacity", "shadowOffsetX", "shadowOffsetY"]);
  const exact = validateExactKeys(value, keys, keys, `setup.state.${name}`);
  if (exact) return exact;
  for (const key of keys) {
    if (key === "shadow") {
      if (typeof value[key] !== "boolean") return `setup.state.${name}.${key} must be a boolean.`;
    } else if (!isInt32(value[key])) {
      return `setup.state.${name}.${key} must be an Int32.`;
    }
  }
  if (!isFiniteNumberInRange(value.opacity, 0, 100) || !isFiniteNumberInRange(value.shadowOpacity, 0, 100) ||
      !isFiniteNumberInRange(value.scale, 1, 1000) || !isFiniteNumberInRange(value.lineSpacing, 1, 1000)) {
    return `setup.state.${name} is outside the public range.`;
  }
  return undefined;
}

function validateInputBoardElement(value: unknown, index: number): string | undefined {
  const path = `setup.state.inputBoardElements.${index}`;
  if (!isPlainObject(value)) return `${path} must be an object.`;
  const keys = new Set(["id", "label", "x", "y", "width", "height", "bindings", "keyBindings", "visible", "fillColor", "pressedFillColor", "strokeColor", "textColor", "outlineWidth", "textScale"]);
  const exact = validateExactKeys(value, keys, keys, path);
  if (exact) return exact;
  if (!isNonblankBoundedString(value.id, 128) || typeof value.label !== "string" || value.label.length > 128 ||
      typeof value.visible !== "boolean") return `${path} contains invalid text or visibility.`;
  for (const key of ["x", "y", "width", "height", "fillColor", "pressedFillColor", "strokeColor", "textColor", "outlineWidth", "textScale"]) {
    if (!isInt32(value[key])) return `${path}.${key} must be an Int32.`;
  }
  if (!isFiniteNumberInRange(value.x, -2000, 2000) || !isFiniteNumberInRange(value.y, -2000, 2000) ||
      !isFiniteNumberInRange(value.width, 18, 240) || !isFiniteNumberInRange(value.height, 18, 240) ||
      !isFiniteNumberInRange(value.textScale, 40, 220)) return `${path} is outside the public range.`;
  if (!Array.isArray(value.bindings) || value.bindings.length > 16 ||
      !value.bindings.every(item => typeof item === "string" && inputBoardBindingNames.has(item)) ||
      !Array.isArray(value.keyBindings) || value.keyBindings.length > 16 ||
      !value.keyBindings.every(item => typeof item === "string" && keyboardKeyNames.has(item))) {
    return `${path} contains invalid bindings.`;
  }
  return undefined;
}

function validateCustomHudLabel(value: unknown, index: number): string | undefined {
  const path = `setup.state.customHudLabelDefinitions.${index}`;
  if (!isPlainObject(value)) return `${path} must be an object.`;
  const keys = new Set([
    "id", "name", "text", "visible", "anchor", "absolutePosition", "x", "y", "offsetX", "offsetY", "scale", "color",
    "opacity", "lineSpacing", "font", "textAlignment", "shadow", "shadowColor", "shadowOpacity", "shadowOffsetX",
    "shadowOffsetY", "eventMode", "eventDelaySeconds", "eventDurationSeconds", "eventOverridesStyle", "eventScale",
    "eventColor", "eventOpacity"
  ]);
  const exact = validateExactKeys(value, keys, keys, path);
  if (exact) return exact;
  if (!isNonblankBoundedString(value.id, 128)) return `${path}.id is invalid.`;
  if (typeof value.name !== "string" || value.name.length > 128) return `${path}.name is invalid.`;
  if (typeof value.text !== "string" || value.text.length > 4096) return `${path}.text is invalid.`;
  for (const key of ["visible", "absolutePosition", "shadow", "eventOverridesStyle"]) {
    if (typeof value[key] !== "boolean") return `${path}.${key} must be a boolean.`;
  }
  for (const key of ["x", "y", "offsetX", "offsetY", "color", "opacity", "lineSpacing", "shadowColor", "shadowOpacity", "shadowOffsetX", "shadowOffsetY", "eventColor", "eventOpacity"]) {
    if (!isInt32(value[key])) return `${path}.${key} must be an Int32.`;
  }
  for (const key of ["scale", "eventDelaySeconds", "eventDurationSeconds", "eventScale"]) {
    if (!Number.isFinite(value[key])) return `${path}.${key} must be a number.`;
  }
  const enumChecks: Record<string, ReadonlySet<string>> = {
    anchor: stateEnumValues.startPosLabelAnchor,
    font: new Set(["Tiny", "Small", "Default", "Large", "Huge"]),
    textAlignment: new Set(["Left", "Center", "Right"]),
    eventMode: new Set(["Always", "OnDeath", "OnButtonHold", "OnNoclipDeath"])
  };
  for (const [key, values] of Object.entries(enumChecks)) {
    if (typeof value[key] !== "string" || !values.has(value[key] as string)) return `${path}.${key} is not a recognized value.`;
  }
  if (!isFiniteNumberInRange(value.opacity, 0, 100) || !isFiniteNumberInRange(value.shadowOpacity, 0, 100) ||
      !isFiniteNumberInRange(value.eventOpacity, 0, 100)) return `${path} opacity is outside the public range.`;
  return undefined;
}

function validateSectionState(state: Record<string, unknown>, section: Exclude<AkronProfileSection, "Whole">): string | undefined {
  if (section === "AutoKill") {
    return validateAreaCollection(state.autoKillAreas, 128, "autoKillAreas");
  }
  if (section === "AutoDeafen") {
    return validateAreaCollection(state.autoDeafenAreas, 128, "autoDeafenAreas");
  }
  if (section === "Audio") {
    const volumes = validateStringNumberMap(state.soundVolumes, 64, 128, "soundVolumes");
    if (volumes) return volumes;
    if (!isFiniteNumberInRange(state.audioSpeedMultiplier, 0.1, 4) ||
        !isFiniteNumberInRange(state.pitchShiftMultiplier, 0.1, 4)) {
      return "setup.state audio multipliers are invalid.";
    }
    return validateStringBooleanMap(state.soundVolumeOverrides, 64, 128, "soundVolumeOverrides");
  }
  if (section === "Recorder") {
    return validateRecorderState(state);
  }
  if (section === "Hud") {
    for (const [key, maximum] of [["customHudLabelDefinitions", 64], ["inputBoardElements", 48], ["labelRowOrder", 128]] as const) {
      const value = state[key];
      if (value !== undefined && (!Array.isArray(value) || value.length > maximum)) {
        return `setup.state.${key} exceeds ${maximum} entries or is invalid.`;
      }
    }
  }
  return undefined;
}

function validateRecorderState(state: Record<string, unknown>): string | undefined {
  const numericRanges: Record<string, readonly [number, number]> = {
    recordingResolutionX: [320, 3840], recordingResolutionY: [180, 2160], recordingFramerate: [1, 120],
    recordingBitrateMbps: [1, 200], recordingReplayBufferSeconds: [0, 300], recordingPreRollSeconds: [0, 30],
    recordingPostRollSeconds: [0, 30], recordingKeyframeIntervalSeconds: [0, 10], recordingEndscreenDurationSeconds: [0, 15],
    recordingAudioFullMixLevel: [0, 200], recordingAudioMusicLevel: [0, 200], recordingAudioSfxLevel: [0, 200],
    recordingAudioAmbienceLevel: [0, 200]
  };
  for (const [key, range] of Object.entries(numericRanges)) {
    if (state[key] !== undefined && !isFiniteNumberInRange(state[key], range[0], range[1])) {
      return `setup.state.${key} is outside the public range.`;
    }
  }
  const width = state.recordingResolutionX;
  const height = state.recordingResolutionY;
  if (typeof width === "number" && typeof height === "number" && width * height > 8_294_400) {
    return "Recorder resolution exceeds 8294400 pixels.";
  }

  const enums: Record<string, ReadonlySet<string>> = {
    recordingContainerFormat: new Set(["Mkv", "Mp4", "Mov", "WebM"]),
    recordingQualityPreset: new Set(["LowImpact", "Balanced", "HighQuality", "Lossless"]),
    recordingRateControl: new Set(["Cbr", "Vbr", "Cqp", "Crf", "Lossless"]),
    recordingClipBrowserSort: new Set(["Date", "Chapter", "Room", "Death", "Clear", "Pb", "Favorite"]),
    recordingClipBrowserFilter: new Set(["All", "Chapter", "Room", "Death", "Clear", "Pb", "Favorite"]),
    recordingCodec: new Set(["Libx264", "H264Nvenc", "H264Amf", "HevcNvenc", "LibVpxVp9"]),
    recordingPreset: new Set(["Cpu", "Nvidia", "Amd"])
  };
  for (const [key, values] of Object.entries(enums)) {
    if (state[key] !== undefined && (typeof state[key] !== "string" || !values.has(state[key] as string))) {
      return `setup.state.${key} is not a recognized value.`;
    }
  }
  return undefined;
}

function validateStartPositions(value: unknown, mapSid: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || Object.keys(value).length > 99) return "setup.startPositions exceeds 99 slots or is invalid.";
  const allowed = new Set(["room", "areaSid", "x", "y", "usesSpawnConfig", "dashes", "staminaPercent", "facing", "idle", "grab"]);
  for (const [slot, rawPosition] of Object.entries(value)) {
    const slotNumber = Number(slot);
    if (!Number.isInteger(slotNumber) || String(slotNumber) !== slot || slotNumber < 1 || slotNumber > 99 || !isPlainObject(rawPosition)) {
      return "setup.startPositions contains an invalid slot.";
    }
    const keyReason = validateExactKeys(rawPosition, allowed, allowed, `setup.startPositions.${slot}`);
    if (keyReason) return keyReason;
    if (readRequiredBoundedString(rawPosition, "room", 256) === undefined ||
        readRequiredBoundedString(rawPosition, "areaSid", 256) === undefined ||
        !isPortableStartPosCoordinate(rawPosition.x) || !isPortableStartPosCoordinate(rawPosition.y)) {
      return `setup.startPositions.${slot} is invalid.`;
    }
    if (rawPosition.areaSid !== mapSid) return `setup.startPositions.${slot} belongs to a different map.`;
    if (typeof rawPosition.usesSpawnConfig !== "boolean" || !isInt32(rawPosition.dashes) ||
        !isInt32(rawPosition.staminaPercent) || typeof rawPosition.idle !== "boolean" || typeof rawPosition.grab !== "boolean" ||
        !new Set(["Current", "Left", "Right"]).has(rawPosition.facing as string) ||
        !isFiniteNumberInRange(rawPosition.dashes, -1, 5) || !isFiniteNumberInRange(rawPosition.staminaPercent, -1, 100)) {
      return `setup.startPositions.${slot} spawn configuration is invalid.`;
    }
  }
  return undefined;
}

function validateAreaCollection(value: unknown, maxEntries: number, name: string): string | undefined {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value) ? value : undefined;
  if (!entries || entries.length > maxEntries) return `setup.state.${name} exceeds ${maxEntries} entries or is invalid.`;
  for (const entry of entries) {
    if (!isPlainObject(entry)) return `setup.state.${name} contains an invalid area.`;
    const reason = validateAreaEntry(entry, name, name === "autoKillAreas");
    if (reason) return reason;
  }
  return undefined;
}

function validateAreaEntry(entry: Record<string, unknown>, name: string, autoKill: boolean): string | undefined {
  const allowed = autoKill
    ? new Set([
        "x", "y", "width", "height", "speedCondition", "minSpeed", "maxSpeed", "horizontalSpeedCondition",
        "minHorizontalSpeed", "maxHorizontalSpeed", "verticalSpeedCondition", "minVerticalSpeed", "maxVerticalSpeed",
        "dashCountCondition", "dashCount", "groundCondition", "horizontalDirection", "verticalDirection",
        "playerStateCondition", "playerState", "invertConditions"
      ])
    : new Set(["x", "y", "width", "height"]);
  const keyReason = validateExactKeys(entry, allowed, allowed, `setup.state.${name}`);
  if (keyReason) return keyReason;
  for (const key of ["x", "y", "width", "height"]) {
    if (!isInt32(entry[key])) return `setup.state.${name} contains a non-Int32 rectangle.`;
  }
  if ((entry.width as number) < 0 || (entry.height as number) < 0) return `setup.state.${name} contains a negative rectangle size.`;
  if (autoKill) {
    for (const key of ["speedCondition", "horizontalSpeedCondition", "verticalSpeedCondition", "dashCountCondition", "playerStateCondition", "invertConditions"]) {
      if (typeof entry[key] !== "boolean") return `setup.state.${name}.${key} must be a boolean.`;
    }
    for (const key of ["minSpeed", "maxSpeed", "minHorizontalSpeed", "maxHorizontalSpeed", "minVerticalSpeed", "maxVerticalSpeed", "dashCount", "playerState"]) {
      if (!isInt32(entry[key])) return `setup.state.${name}.${key} must be an Int32.`;
    }
    const ground = new Set(["Any", "Grounded", "Airborne"]);
    const axis = new Set(["Any", "Negative", "Positive", "Zero"]);
    if (!ground.has(entry.groundCondition as string) || !axis.has(entry.horizontalDirection as string) || !axis.has(entry.verticalDirection as string)) {
      return `setup.state.${name} contains an unsupported condition.`;
    }
  }
  return undefined;
}

function validateBindings(buttons: unknown, menuActions: unknown): string | undefined {
  if (buttons !== undefined) {
    if (!isPlainObject(buttons) || Object.keys(buttons).length > 128) return "setup.buttonBindings exceeds 128 entries or is invalid.";
    for (const [name, value] of Object.entries(buttons)) {
      if (!keybindPropertyNames.has(name)) return "setup.buttonBindings contains an unknown binding name.";
      if (!isPlainObject(value)) return "setup.buttonBindings contains an invalid binding.";
      const keyReason = validateExactKeys(
        value,
        new Set(["keys", "buttons", "mouseButtons"]),
        new Set(["keys", "buttons", "mouseButtons"]),
        "setup.buttonBindings"
      );
      if (keyReason) return keyReason;
      if (!Array.isArray(value.keys) || !Array.isArray(value.buttons) || !Array.isArray(value.mouseButtons)) {
        return "setup.buttonBindings contains an invalid binding token list.";
      }
      const tokens = [...value.keys, ...value.buttons, ...value.mouseButtons];
      if (tokens.length > 16 ||
          !value.keys.every(token => typeof token === "string" && keyboardKeyNames.has(token)) ||
          !value.buttons.every(token => typeof token === "string" && controllerButtonNames.has(token)) ||
          !value.mouseButtons.every(token => typeof token === "string" && mouseButtonNames.has(token))) {
        return "setup.buttonBindings contains an invalid binding token list.";
      }
    }
  }
  if (menuActions !== undefined) {
    if (!isPlainObject(menuActions) || Object.keys(menuActions).length > 256) return "setup.menuActionBindings exceeds 256 entries or is invalid.";
    for (const [key, value] of Object.entries(menuActions)) {
      if (!isNonblankBoundedString(key, 128) || !isNonblankBoundedString(value, 256)) {
        return "setup.menuActionBindings contains an invalid binding.";
      }
    }
  }
  return undefined;
}

function validateStringNumberMap(value: unknown, maxEntries: number, maxKeyLength: number, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || Object.keys(value).length > maxEntries) return `setup.state.${name} is invalid.`;
  for (const [key, item] of Object.entries(value)) {
    if (!isNonblankBoundedString(key, maxKeyLength) || !isInt32(item) || item < 0 || item > 200) {
      return `setup.state.${name} contains an invalid value.`;
    }
  }
  return undefined;
}

function validateStringBooleanMap(value: unknown, maxEntries: number, maxKeyLength: number, name: string): string | undefined {
  if (!isPlainObject(value) || Object.keys(value).length > maxEntries) return `setup.state.${name} is invalid.`;
  for (const [key, item] of Object.entries(value)) {
    if (!isNonblankBoundedString(key, maxKeyLength) || typeof item !== "boolean") {
      return `setup.state.${name} contains an invalid value.`;
    }
  }
  return undefined;
}

function readZipJsonFiles(buffer: Buffer): Promise<{ files: Map<string, unknown>; reason?: string }> {
  return new Promise(resolve => {
    const files = new Map<string, unknown>();
    let entryCount = 0;
    let totalUncompressedSize = 0;
    let finished = false;
    const finish = (reason?: string): void => {
      if (finished) return;
      finished = true;
      resolve({ files, reason });
    };

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return finish(describeZipOpenError(error));
      const reject = (reason: string): void => {
        zip.close();
        finish(reason);
      };
      zip.readEntry();
      zip.on("entry", entry => {
        entryCount += 1;
        totalUncompressedSize += entry.uncompressedSize;
        const name = entry.fileName;
        if (isUnsafeArchiveEntryName(name)) return reject("Archive contains an unsafe path.");
        if (/\.(zip|7z|rar|tar|gz)$/i.test(name)) return reject("Nested archives are not allowed.");
        if (!allowedArchiveNames.has(name)) return reject("Archive contains unexpected file: " + name);
        if (entryCount > allowedArchiveNames.size || files.has(name)) return reject("Archive contains duplicate or too many files.");
        if (totalUncompressedSize > akrMaxBytes) return reject("Archive uncompressed payload is too large.");
        if (entry.uncompressedSize > maxJsonFileBytes) return reject("Archive JSON payload is too large: " + name);
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > maxCompressionRatio) {
          return reject("Archive has suspicious compression ratio.");
        }

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject("Failed to read " + name + ".");
          const chunks: Buffer[] = [];
          let actualBytes = 0;
          stream.on("data", chunk => {
            actualBytes += chunk.length;
            if (actualBytes > maxJsonFileBytes) {
              stream.destroy();
              reject("Archive JSON payload is too large: " + name);
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          stream.on("error", () => reject("Failed to read " + name + "."));
          stream.on("end", () => {
            if (finished) return;
            try {
              const json = Buffer.concat(chunks).toString("utf8");
              const duplicateReason = findDuplicateJsonKey(json, name);
              if (duplicateReason) return reject(duplicateReason);
              files.set(name, JSON.parse(json));
            } catch {
              return reject(name + " is not valid JSON.");
            }
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => finish());
      zip.on("error", error => finish(describeZipOpenError(error)));
    });
  });
}

function findDuplicateJsonKey(json: string, rootPath: string): string | undefined {
  let index = 0;
  let duplicateReason: string | undefined;
  let budgetReason: string | undefined;
  let nodes = 0;
  const skipWhitespace = (): void => {
    while (/\s/.test(json[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    if (json[index] !== '"') throw new Error("Expected JSON string.");
    const start = index;
    index += 1;
    while (index < json.length) {
      if (json[index] === "\\") {
        index += 2;
        continue;
      }
      if (json[index] === '"') {
        index += 1;
        return JSON.parse(json.slice(start, index)) as string;
      }
      index += 1;
    }
    throw new Error("Unterminated JSON string.");
  };
  const childPath = (path: string, component: string | number): string => {
    const suffix = typeof component === "number" ? String(component) : describeJsonKey(component);
    const candidate = `${path}.${suffix}`;
    return candidate.length <= 512 ? candidate : `${rootPath}.<nested>`;
  };
  const parseValue = (path: string, depth: number): void => {
    nodes += 1;
    if (nodes > maxJsonNodes) {
      budgetReason = "Archive JSON exceeds the 10000 node budget.";
      throw new Error(budgetReason);
    }
    if (depth > maxJsonDepth) {
      budgetReason = "Archive JSON exceeds the maximum nesting depth.";
      throw new Error(budgetReason);
    }
    skipWhitespace();
    const token = json[index];
    if (token === "{") {
      parseObject(path, depth);
      return;
    }
    if (token === "[") {
      parseArray(path, depth);
      return;
    }
    if (token === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (json.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const start = index;
    while (index < json.length && !/[\s,\]}]/.test(json[index] ?? "")) index += 1;
    if (index === start) throw new Error("Expected JSON value.");
  };
  const parseObject = (path: string, depth: number): void => {
    index += 1;
    skipWhitespace();
    if (json[index] === "}") {
      index += 1;
      return;
    }
    const keys = new Set<string>();
    while (index < json.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key) && !duplicateReason) duplicateReason = `${path} contains duplicate key: ${describeJsonKey(key)}.`;
      keys.add(key);
      skipWhitespace();
      if (json[index] !== ":") throw new Error("Expected JSON property separator.");
      index += 1;
      parseValue(childPath(path, key), depth + 1);
      skipWhitespace();
      if (json[index] === "}") {
        index += 1;
        return;
      }
      if (json[index] !== ",") throw new Error("Expected JSON object separator.");
      index += 1;
    }
    throw new Error("Unterminated JSON object.");
  };
  const parseArray = (path: string, depth: number): void => {
    index += 1;
    skipWhitespace();
    if (json[index] === "]") {
      index += 1;
      return;
    }
    let itemIndex = 0;
    while (index < json.length) {
      parseValue(childPath(path, itemIndex), depth + 1);
      itemIndex += 1;
      skipWhitespace();
      if (json[index] === "]") {
        index += 1;
        return;
      }
      if (json[index] !== ",") throw new Error("Expected JSON array separator.");
      index += 1;
    }
    throw new Error("Unterminated JSON array.");
  };

  try {
    parseValue(rootPath, 0);
    skipWhitespace();
    if (index !== json.length) return undefined;
    return duplicateReason;
  } catch {
    // JSON.parse below owns syntax errors. This pass only adds duplicate-key semantics.
    return budgetReason;
  }
}

function describeJsonKey(key: string): string {
  if (key.length > 64) return "<oversized>";
  return key.replace(/[^\x20-\x7e]/g, "?");
}

function validateExactKeys(
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  path: string
): string | undefined {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) return `${path} contains unknown key: ${describeJsonKey(key)}.`;
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) return `${path} is missing key: ${key}.`;
  }
  return undefined;
}

function validateJsonBudget(root: unknown): string | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    nodes += 1;
    if (nodes > maxJsonNodes) return "Archive JSON exceeds the 10000 node budget.";
    if (item.depth > maxJsonDepth) return "Archive JSON exceeds the maximum nesting depth.";
    if (typeof item.value === "string" && item.value.length > maxStringValueLength) return "Config contains an unusually large text value.";
    if (Array.isArray(item.value)) {
      for (const value of item.value) stack.push({ value, depth: item.depth + 1 });
    } else if (isPlainObject(item.value)) {
      for (const [key, value] of Object.entries(item.value)) {
        if (key.length > maxStringValueLength) return "Config contains an unusually large object key.";
        stack.push({ value, depth: item.depth + 1 });
      }
    }
  }
  return undefined;
}

function findForbiddenKey(root: unknown): string | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
    } else if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) return describeJsonKey(key);
        stack.push(item);
      }
    }
  }
  return undefined;
}

function invalid(
  reason: string,
  manifest?: unknown,
  setup?: unknown,
  section?: AkronProfileSection,
  mapSid = ""
): AkrArchiveValidation {
  return { ok: false, section, mapSid, manifest, setup, normalizedFacts: { section, mapSid }, reasons: [reason] };
}

function readRequiredBoundedString(source: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = source[key];
  return isNonblankBoundedString(value, maxLength) ? value : undefined;
}

function isNonblankBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isIsoDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isFiniteNumberInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isInt32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= -2_147_483_648 && (value as number) <= 2_147_483_647;
}

function isPortableStartPosCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= maxPortableStartPosCoordinate;
}

function isMapSpecificSection(section: AkronProfileSection): boolean {
  return section === "StartPos" || section === "AutoKill" || section === "AutoDeafen";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isUnsafeArchiveEntryName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(name)) return true;
  return name.split(/[\\/]+/).includes("..");
}

function describeZipOpenError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /path|absolute|relative|invalid/i.test(message) ? "Archive contains an unsafe path." : "Invalid zip archive.";
}
