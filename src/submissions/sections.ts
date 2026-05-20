import type { AkronProfileSection } from "./types.js";

const aliases = new Map<string, AkronProfileSection>([
  ["whole", "Whole"],
  ["profile", "Whole"],
  ["all", "Whole"],
  ["startpos", "StartPos"],
  ["start-pos", "StartPos"],
  ["start position", "StartPos"],
  ["start positions", "StartPos"],
  ["keybind", "Keybinds"],
  ["keybinds", "Keybinds"],
  ["bindings", "Keybinds"],
  ["autokill", "AutoKill"],
  ["auto-kill", "AutoKill"],
  ["auto kill", "AutoKill"],
  ["autodeafen", "AutoDeafen"],
  ["auto-deafen", "AutoDeafen"],
  ["auto deafen", "AutoDeafen"],
  ["recorder", "Recorder"],
  ["audio", "Audio"],
  ["hud", "Hud"],
  ["ui", "Hud"]
]);

export function normalizeSection(value: unknown): AkronProfileSection | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return aliases.get(value.trim().toLowerCase().replace(/_/g, "-"));
}

export function formatSection(section: AkronProfileSection): string {
  switch (section) {
    case "StartPos":
      return "StartPos";
    case "AutoKill":
      return "Auto Kill";
    case "AutoDeafen":
      return "Auto Deafen";
    case "Keybinds":
      return "Keybinds";
    case "Recorder":
      return "Recorder";
    case "Audio":
      return "Audio";
    case "Hud":
      return "HUD";
    default:
      return "Whole";
  }
}

export function sectionTag(section: AkronProfileSection): string {
  return formatSection(section).toLowerCase().replace(/\s+/g, "-");
}
