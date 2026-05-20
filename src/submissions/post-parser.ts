import type { ParsedSubmissionPost } from "./types.js";

const supportedMapLinkPattern = /^https:\/\/(?:www\.)?gamebanana\.com\/mods\/\d+(?:[/?#].*)?$/i;

export function parseSubmissionPost(content: string): ParsedSubmissionPost {
  const text = content ?? "";
  const mapUrl = extractMapUrl(text);
  const description = extractDescription(text);
  return { mapUrl, description };
}

export function isSupportedMapUrl(value: string): boolean {
  return supportedMapLinkPattern.test((value ?? "").trim());
}

export function normalizeMapUrl(value: string): string {
  const trimmed = (value ?? "").trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./i, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

function extractMapUrl(text: string): string {
  const explicit = text.match(/^\s*map\s*:\s*(https?:\/\/\S+)/im);
  if (explicit) {
    return normalizeMapUrl(explicit[1]);
  }

  const any = text.match(/https:\/\/(?:www\.)?gamebanana\.com\/mods\/\d+(?:[/?#]\S*)?/i);
  return any ? normalizeMapUrl(any[0]) : "";
}

function extractDescription(text: string): string {
  const explicit = text.match(/^\s*description\s*:\s*(.+)$/im);
  if (explicit) {
    return explicit[1].trim();
  }

  return text
    .split(/\r?\n/)
    .filter(line => !/^\s*map\s*:/i.test(line))
    .join("\n")
    .trim()
    .slice(0, 1500);
}
