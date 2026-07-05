export const akrMaxBytes = 4 * 1024 * 1024;
export const imageSourceMaxBytes = 64 * 1024 * 1024;
export const catalogImageMaxBytes = 4 * 1024 * 1024;
export const catalogImageResizeTarget = "4MB";

export type AkronProfileSection =
  | "Whole"
  | "StartPos"
  | "Keybinds"
  | "AutoKill"
  | "AutoDeafen"
  | "Recorder"
  | "Audio"
  | "Hud";

export const allowedSections: AkronProfileSection[] = [
  "Whole",
  "StartPos",
  "Keybinds",
  "AutoKill",
  "AutoDeafen",
  "Recorder",
  "Audio",
  "Hud"
];

export type ScanStatus = "Published" | "Needs Fix" | "Needs Moderator Review" | "Flagged";

export type AkrArchiveValidation = {
  ok: boolean;
  section?: AkronProfileSection;
  mapSid?: string;
  manifest: unknown;
  setup: unknown;
  normalizedFacts: Record<string, unknown>;
  reasons: string[];
};

export type ParsedSubmissionPost = {
  mapUrl: string;
  description: string;
};
